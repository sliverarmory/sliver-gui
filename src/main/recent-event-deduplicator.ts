import { createHash } from "node:crypto";

import { clientpb } from "sliver-script";

export const RECENT_EVENT_DEDUP_WINDOW_MS = 1_000;

/**
 * Suppresses only an immediately repeated, byte-equivalent protobuf event.
 * Keeping a single accepted fingerprint makes the memory bound constant and
 * ensures an intervening distinct event always breaks the duplicate run.
 */
export class RecentEventDeduplicator {
  private acceptedFingerprint?: string;
  private acceptedAt = 0;

  constructor(
    private readonly windowMs = RECENT_EVENT_DEDUP_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  shouldRecord(event: clientpb.Event): boolean {
    const fingerprint = eventFingerprint(event);
    const timestamp = this.now();
    const elapsed = timestamp - this.acceptedAt;
    if (
      fingerprint === this.acceptedFingerprint &&
      elapsed >= 0 &&
      elapsed <= this.windowMs
    ) {
      return false;
    }

    this.acceptedFingerprint = fingerprint;
    this.acceptedAt = timestamp;
    return true;
  }
}

function eventFingerprint(event: clientpb.Event): string {
  return createHash("sha256").update(clientpb.Event.encode(event).finish()).digest("base64url");
}
