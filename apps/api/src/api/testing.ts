import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";

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
