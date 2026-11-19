import {
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_TEXT,
  MAX_INBOUND_MESSAGE_BYTES,
  type ContextMessage,
  type InboundMessage,
} from "@hippidy/contracts";
import { slackTsToIso } from "./map.ts";

/** One message of a thread, as Slack's `conversations.replies` reports it. */
export interface SlackThreadMessage {
  ts: string;
  /** The sender's user id; absent for some bot and system messages. */
  user?: string;
  /** Set when a bot (this one or another) posted the message. */
  botId?: string;
  text?: string;
}

/** What the adapter needs to read a thread: Slack's `conversations.replies` and user names. */
export interface ThreadReader {
  threadReplies(channel: string, threadTs: string): Promise<SlackThreadMessage[]>;
  userName(userId: string): Promise<string | undefined>;
}

/**
 * How long reading the thread (and the names in it) may take before the mention is sent
 * without it. Bolt acknowledges an event before it calls the listener, so this does not count
 * against Slack's 3 second limit; it bounds how much later 👀 appears and the agent starts.
 */
export const THREAD_READ_TIMEOUT_MS = 1500;

/** Thrown when reading the thread took longer than allowed. */
export class ThreadReadTimeout extends Error {
  readonly code = "timeout";
  constructor() {
    super("Reading the thread timed out");
    this.name = "ThreadReadTimeout";
  }
}

/**
 * The messages to tell the agent about (decision 140): those after the bot's latest message
 * and before this mention, from people, that do not mention the bot (those reach the API as
 * their own messages), with text. The last 50 at most, oldest first.
 */
export function selectContext(
  messages: readonly SlackThreadMessage[],
  options: { mentionTs: string; botUserId: string | undefined },
): SlackThreadMessage[] {
  const before = [...messages]
    .filter((message) => compareTs(message.ts, options.mentionTs) < 0)
    .sort((a, b) => compareTs(a.ts, b.ts));
  const isBot = (message: SlackThreadMessage) =>
    message.botId !== undefined ||
    (options.botUserId !== undefined && message.user === options.botUserId);
  const mention =
    options.botUserId === undefined
      ? undefined
      : new RegExp(`<@${escapeRegExp(options.botUserId)}(\\|[^>]*)?>`);

  // The boundary is this bot's own last message only: another app posting in the thread
  // (GitHub, CI) must not hide what people said before it.
  const isSelf = (message: SlackThreadMessage) =>
    options.botUserId !== undefined && message.user === options.botUserId;
  let lastBot = -1;
  before.forEach((message, index) => {
    if (isSelf(message)) lastBot = index;
  });
  return before
    .slice(lastBot + 1)
    .filter(
      (message) =>
        !isBot(message) &&
        message.user !== undefined &&
        (message.text ?? "").trim() !== "" &&
        mention?.test(message.text ?? "") !== true,
    )
    .slice(-MAX_CONTEXT_MESSAGES);
}

/**
 * Reads the thread and returns what was said in it since the bot's last message. Throws if the
 * thread cannot be read in `timeoutMs` (names that do not arrive in that time are left out).
 */
export async function readThreadContext(
  input: { channel: string; threadTs: string; mentionTs: string; botUserId: string | undefined },
  slack: ThreadReader,
  timeoutMs: number = THREAD_READ_TIMEOUT_MS,
): Promise<ContextMessage[]> {
  const deadline = Date.now() + timeoutMs;
  const replies = await withTimeout(slack.threadReplies(input.channel, input.threadTs), timeoutMs);
  const selected = selectContext(replies, input);

  const users = [...new Set(selected.map((message) => message.user ?? ""))];
  const names = new Map<string, string | undefined>();
  await Promise.all(
    users.map(async (user) => {
      const name = await withTimeout(slack.userName(user), Math.max(deadline - Date.now(), 0))
        .then((found) => found?.trim().slice(0, 255))
        .catch((): undefined => undefined);
      names.set(user, name === "" ? undefined : name);
    }),
  );

  return selected.map((message) => {
    const actorId = message.user ?? "";
    const actorName = names.get(actorId);
    return {
      actorId,
      ...(actorName === undefined ? {} : { actorName }),
      text: capText(message.text ?? "", MAX_CONTEXT_TEXT),
      sentAt: slackTsToIso(message.ts),
    };
  });
}

/**
 * Drops the oldest context messages until the request fits the API's body limit, so a long
 * thread never costs the mention itself. Returns how many were dropped.
 */
export function fitContext(message: InboundMessage): number {
  let dropped = 0;
  while (
    message.context !== undefined &&
    message.context.length > 0 &&
    Buffer.byteLength(JSON.stringify(message)) > MAX_INBOUND_MESSAGE_BYTES
  ) {
    message.context = message.context.slice(1);
    dropped += 1;
  }
  if (message.context?.length === 0) delete message.context;
  return dropped;
}

/** Orders two Slack timestamps ("seconds.micros"). */
export function compareTs(a: string, b: string): number {
  const [aSeconds = "", aFraction = ""] = a.split(".");
  const [bSeconds = "", bFraction = ""] = b.split(".");
  const key = (seconds: string, fraction: string) =>
    `${seconds.padStart(12, "0")}.${fraction.padEnd(6, "0")}`;
  const left = key(aSeconds, aFraction);
  const right = key(bSeconds, bFraction);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** At most `max` UTF-16 units, without leaving half of a surrogate pair at the end. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // The call may still fail after the timeout; that must not become an unhandled rejection.
  promise.catch((): void => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ThreadReadTimeout());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
