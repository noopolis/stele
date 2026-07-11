import { afterEach, describe, expect, it, vi } from "vitest";

import { CAUSAL_EVENT_VERSION } from "./envelope.js";
import type { CausalEvent } from "./envelope.js";
import * as envelope from "./envelope.js";
import { reconcileEvents } from "./reconcile.js";

const SYSTEMS = ["moltnet", "mneme", "daimon", "simfile"] as const;

/**
 * Builds a large, well-formed synthetic causal stream: `streamCount`
 * independent (run_id, system:stream_id) streams, each `perStream` events
 * long, with every event (seq > 1) caused by the previous event in its own
 * stream. Every cause resolves inside the set, so a clean stream is entirely
 * `complete`.
 */
const buildSyntheticStream = (streamCount: number, perStream: number): CausalEvent[] => {
  const events: CausalEvent[] = [];

  for (let streamIndex = 0; streamIndex < streamCount; streamIndex += 1) {
    const system = SYSTEMS[streamIndex % SYSTEMS.length]!;
    const runId = `run-${streamIndex % 3}`;
    const streamId = `stream:${streamIndex}`;
    let previousEventId: string | undefined;

    for (let seq = 1; seq <= perStream; seq += 1) {
      const eventId = `${system}:${runId}:${streamId}:${seq}`;
      events.push({
        cause_event_ids: previousEventId ? [previousEventId] : [],
        emitter: { seq, stream_id: streamId, system },
        event_id: eventId,
        payload: { index: seq },
        principal_id: `${system}:authn:agent-${streamIndex}`,
        recorded_at: "2026-07-10T00:00:00.000Z",
        run_id: runId,
        type: "stream.event",
        version: CAUSAL_EVENT_VERSION
      });
      previousEventId = eventId;
    }
  }

  return events;
};

describe("reconcileEvents — scale and single-pass linearity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconciles a ~10k-event synthetic stream with correct states at scale", () => {
    const events = buildSyntheticStream(20, 500);
    expect(events).toHaveLength(10_000);

    // A well-formed mid-stream event whose cause is present => complete.
    const wellFormedId = "moltnet:run-0:stream:0:250";
    expect(events.some((event) => event.event_id === wellFormedId)).toBe(true);

    // Inject a dangling cause (system present, specific parent absent) => partial.
    const partialEvent: CausalEvent = {
      cause_event_ids: ["daimon:run-1:stream:missing:999"],
      emitter: { seq: 501, stream_id: "stream:2", system: "daimon" },
      event_id: "daimon:run-2:injected-partial",
      payload: { index: 501 },
      principal_id: "daimon:authn:injected",
      recorded_at: "2026-07-10T00:00:00.000Z",
      run_id: "run-2",
      type: "stream.event",
      version: CAUSAL_EVENT_VERSION
    };

    // Inject the same event_id twice with different payloads => divergent.
    const divergentA: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "stream:dup", system: "moltnet" },
      event_id: "moltnet:run-0:injected-divergent",
      payload: { revision: 1 },
      principal_id: "moltnet:authn:injected",
      recorded_at: "2026-07-10T00:00:00.000Z",
      run_id: "run-0",
      type: "stream.event",
      version: CAUSAL_EVENT_VERSION
    };
    const divergentB: CausalEvent = { ...divergentA, payload: { revision: 2 } };

    const allEvents = [...events, partialEvent, divergentA, divergentB];

    const startedAt = Date.now();
    const result = reconcileEvents(allEvents);
    const elapsedMs = Date.now() - startedAt;

    // Structural single-index proof: one indexed record per distinct
    // event_id, never a cross-product of the input.
    const distinctEventIds = new Set(allEvents.map((event) => event.event_id));
    expect(result.byEventId.size).toBe(distinctEventIds.size);
    const totalOccurrences = [...result.occurrencesByEventId.values()].reduce(
      (sum, occurrences) => sum + occurrences.length,
      0
    );
    expect(totalOccurrences).toBe(allEvents.length);

    // Behavioral correctness at scale.
    expect(result.byEventId.get(wellFormedId)?.state).toBe("complete");
    expect(result.byEventId.get("moltnet:run-0:stream:0:1")?.state).toBe("complete");
    expect(result.byEventId.get("daimon:run-2:injected-partial")?.state).toBe("partial");
    expect(result.byEventId.get("moltnet:run-0:injected-divergent")?.state).toBe("divergent");
    expect(result.occurrencesByEventId.get("moltnet:run-0:injected-divergent")).toHaveLength(2);

    // Secondary, generous wall-clock ceiling only — never the primary signal.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("hashes each event exactly once, so work scales linearly (no quadratic joins)", () => {
    const hashSpy = vi.spyOn(envelope, "hashCausalEvent");

    const smallEvents = buildSyntheticStream(10, 500);
    expect(smallEvents).toHaveLength(5_000);
    hashSpy.mockClear();
    reconcileEvents(smallEvents);
    const smallHashCalls = hashSpy.mock.calls.length;

    const largeEvents = buildSyntheticStream(20, 500);
    expect(largeEvents).toHaveLength(10_000);
    hashSpy.mockClear();
    reconcileEvents(largeEvents);
    const largeHashCalls = hashSpy.mock.calls.length;

    // Exactly one hash per input event: the canonical single-pass signature.
    expect(smallHashCalls).toBe(smallEvents.length);
    expect(largeHashCalls).toBe(largeEvents.length);

    // Doubling the input exactly doubles the work — linear, not quadratic
    // (a quadratic reconciler would hash on the order of N^2 times).
    expect(largeHashCalls).toBe(smallHashCalls * 2);
  });
});
