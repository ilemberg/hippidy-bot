import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";

/** A deliverer that records what it was asked to send, and can be made to fail or stall. */
export class RecordingDeliverer implements Deliverer {
  readonly delivered: OutboundDelivery[] = [];
  /** Number of upcoming deliveries that fail. */
  failures = 0;
  /** Deliveries to hold up, one each, in order; `reached` tells the test one is waiting. */
  private gates: { opened: Promise<void>; reached: () => void }[] = [];
  /** What opens each gate, oldest first. */
  private openers: (() => void)[] = [];

  /**
   * Makes the next delivery wait (called twice: the next two, and so on); resolves once that
   * delivery is actually waiting.
   */
  stallNext(): Promise<void> {
    const opened = new Promise<void>((resolve) => {
      this.openers.push(resolve);
    });
    return new Promise<void>((reached) => {
      this.gates.push({ opened, reached });
    });
  }

  /** Lets the delivery that has been held up longest go on. */
  release(): void {
    this.openers.shift()?.();
  }

  async deliver(delivery: OutboundDelivery): Promise<void> {
    const gate = this.gates.shift();
    if (gate !== undefined) {
      gate.reached();
      await gate.opened;
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
