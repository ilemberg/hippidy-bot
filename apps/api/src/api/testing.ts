import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";
import { SignJWT } from "jose";

/** The secret and workspace the person-token tests configure the API with. */
export const PERSON_SECRET = "w".repeat(48);
export const PERSON_WORKSPACE = "T0123456789";

export interface PersonTokenOptions {
  secret?: string;
  team?: string;
  name?: string | undefined;
  audience?: string;
  issuer?: string;
  issuedAt?: Date;
  lifetimeSeconds?: number;
  algorithm?: "HS256" | "HS512";
}

/** A person token as the web app's server makes one (decision 194); each part can be changed. */
export function signPersonToken(options: PersonTokenOptions = {}): Promise<string> {
  const issuedAt = Math.floor((options.issuedAt ?? new Date()).getTime() / 1000);
  const claims: Record<string, string> = { team: options.team ?? PERSON_WORKSPACE };
  const name = "name" in options ? options.name : "Ilya";
  if (name !== undefined) claims.name = name;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.algorithm ?? "HS256" })
    .setSubject("U0123456789")
    .setAudience(options.audience ?? "hippidy-api")
    .setIssuer(options.issuer ?? "hippidy-web")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 120))
    .sign(new TextEncoder().encode(options.secret ?? PERSON_SECRET));
}

/** A deliverer that records what it was asked to send, and can be made to fail or stall. */
export class RecordingDeliverer implements Deliverer {
  readonly delivered: OutboundDelivery[] = [];
  /** Number of upcoming deliveries that fail. */
  failures = 0;
  /** When set, the next delivery waits until `release()` is called. */
  private gate: { promise: Promise<void>; release: () => void } | undefined;
  private reached: (() => void) | undefined;
  private releaseGate: (() => void) | undefined;

  /** Makes the next delivery wait; resolves once a delivery is actually waiting. */
  stallNext(): Promise<void> {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { promise, release };
    this.releaseGate = release;
    return new Promise<void>((resolve) => {
      this.reached = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
  }

  async deliver(delivery: OutboundDelivery): Promise<void> {
    const gate = this.gate;
    this.gate = undefined;
    if (gate !== undefined) {
      this.reached?.();
      await gate.promise;
    }
    if (this.failures > 0) {
      this.failures--;
      throw new Error("delivery failed");
    }
    this.delivered.push(delivery);
  }

  replies(): string[] {
    return this.delivered.flatMap((d) => (d.kind === "reply" ? [d.text] : []));
  }

  statuses(): { messageIds: string[]; status: string }[] {
    return this.delivered.flatMap((d) =>
      d.kind === "status" ? [{ messageIds: d.messageIds, status: d.status }] : [],
    );
  }
}
