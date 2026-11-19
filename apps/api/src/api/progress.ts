import type { LatestActivity } from "../store/record.ts";

// Progress notes in the thread while a turn runs long (decisions 103, 106): after 15 minutes,
// 1, 2, 4 and 8 hours, then every 4 hours. Nothing before 15 minutes.

const FIRST_NOTES_MINUTES = [15, 60, 120, 240, 480];
const THEN_EVERY_MINUTES = 240;

/**
 * The latest note due after `elapsedMinutes` of waiting: its number (1 for the first) and when
 * it was due. Undefined before the first. Only the latest is posted, so a reconcile run that
 * comes late does not post a burst of old notes.
 */
export function progressDue(
  elapsedMinutes: number,
): { number: number; atMinutes: number } | undefined {
  let due: { number: number; atMinutes: number } | undefined;
  FIRST_NOTES_MINUTES.forEach((atMinutes, index) => {
    if (elapsedMinutes >= atMinutes) due = { number: index + 1, atMinutes };
  });
  const last = FIRST_NOTES_MINUTES.at(-1) ?? 0;
  if (elapsedMinutes >= last + THEN_EVERY_MINUTES) {
    const extra = Math.floor((elapsedMinutes - last) / THEN_EVERY_MINUTES);
    due = {
      number: FIRST_NOTES_MINUTES.length + extra,
      atMinutes: last + extra * THEN_EVERY_MINUTES,
    };
  }
  return due;
}

/** "15 minutes", "1 hour", "12 hours". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour" : `${String(hours)} hours`;
}

const MAX_QUOTE = 280;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_QUOTE ? flat : `${flat.slice(0, MAX_QUOTE - 1)}…`;
}

/**
 * The note's text: how long so far, then the agent's latest own words, else its latest step.
 * Built from the record only, with no model call (decision 106).
 */
export function progressText(atMinutes: number, activity: LatestActivity): string {
  const head = `Still working on this (${formatDuration(atMinutes)} so far).`;
  if (activity.words !== undefined && activity.words.trim() !== "") {
    return `${head} Latest: ${clip(activity.words)}`;
  }
  if (activity.step !== undefined) {
    const what =
      activity.step.command === undefined
        ? activity.step.name
        : `\`${clip(activity.step.command).replace(/`/g, "'")}\``;
    return `${head} Latest step: ${what}`;
  }
  return head;
}
