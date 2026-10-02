// @vitest-environment node

import { describe, expect, it } from "vitest";
import { clientpb } from "sliver-script";

import { RecentEventDeduplicator } from "./recent-event-deduplicator.js";

describe("RecentEventDeduplicator", () => {
  it("expires duplicate suppression from the accepted event, even during a continuous duplicate run", () => {
    let now = 10_000;
    const deduplicator = new RecentEventDeduplicator(1_000, () => now);
    const stopped = jobEvent(41);

    expect(deduplicator.shouldRecord(stopped)).toBe(true);
    now = 10_500;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(false);
    now = 11_000;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(false);
    now = 11_001;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
    now = 11_002;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(false);
  });

  it("accepts an event after the clock moves backwards and starts a fresh bounded window", () => {
    let now = 10_000;
    const deduplicator = new RecentEventDeduplicator(1_000, () => now);

    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
    now = 5_000;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
    now = 5_001;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(false);
    now = 6_001;
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
  });

  it("preserves events for different jobs and events with distinct data or errors", () => {
    let now = 20_000;
    const deduplicator = new RecentEventDeduplicator(1_000, () => ++now);

    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42, { data: "first" }))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42, { data: "second" }))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42, { error: "first error" }))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42, { error: "second error" }))).toBe(true);
  });

  it("accepts a repeated event when an intervening distinct event breaks the run", () => {
    let now = 30_000;
    const deduplicator = new RecentEventDeduplicator(1_000, () => ++now);

    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(42))).toBe(true);
    expect(deduplicator.shouldRecord(jobEvent(41))).toBe(true);
  });
});

function jobEvent(jobId: number, options: { data?: string; error?: string } = {}): clientpb.Event {
  return clientpb.Event.create({
    EventType: "job-stopped",
    Job: clientpb.Job.create({
      ID: jobId,
      Name: "http",
      Description: "http listener",
      Protocol: "tcp",
      Port: 8080,
      Domains: ["example.test"],
    }),
    Data: Buffer.from(options.data ?? ""),
    Err: options.error ?? "",
  });
}
