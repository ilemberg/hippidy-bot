import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";

/** A deliverer that records what it was asked to send, and can be made to fail. */
export class RecordingDeliverer implements Deliverer {
  readonly delivered: OutboundDelivery[] = [];
  failures = 0;

  deliver(delivery: OutboundDelivery): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error("delivery failed"));
    }
    this.delivered.push(delivery);
    return Promise.resolve();
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
