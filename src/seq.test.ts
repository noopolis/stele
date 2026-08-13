import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION } from "./envelope.js";
import type { CausalEvent } from "./envelope.js";
import { checkSeqContiguity, streamKey, streamSlotKey } from "./seq.js";

const makeEvent = (overrides: Partial<CausalEvent> & { emitter: CausalEvent["emitter"] }): CausalEvent => ({
  cause_event_ids: [],
  event_id: `${overrides.emitter.system}:${overrides.emitter.seq}`,
  payload: {},
  principal_id: "moltnet:authn:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION,
  ...overrides
});

describe("streamKey", () => {
  it("uses a collision-safe tuple encoding", () => {
    expect(streamKey("run-1", "moltnet", "network:room-1")).toBe('["run-1","moltnet","network:room-1"]');
    expect(streamKey("a::b", "c", "d:e")).not.toBe(streamKey("a", "b::c", "d:e"));
    expect(streamSlotKey("a", "b", "c:1", 2)).not.toBe(streamSlotKey("a", "b:c", "1", 2));
  });
});

describe("checkSeqContiguity", () => {
  it("reports no gaps for a fully contiguous stream", () => {
    const events = [1, 2, 3].map((seq) =>
      makeEvent({ emitter: { seq, stream_id: "network:room-1", system: "moltnet" } })
    );

    const result = checkSeqContiguity(events);
    expect(result.gaps).toEqual([]);
    expect(result.maxSeqByStream.get(streamKey("run-1", "moltnet", "network:room-1"))).toBe(3);
  });

  it("rejects a stream with a gap", () => {
    const events = [1, 3].map((seq) =>
      makeEvent({ emitter: { seq, stream_id: "network:room-1", system: "moltnet" } })
    );

    const result = checkSeqContiguity(events);
    expect(result.gaps).toEqual([
      { maxSeq: 3, missing: [{ from: 2, to: 2 }], runId: "run-1", streamId: "network:room-1", system: "moltnet" }
    ]);
  });

  it("tracks gaps independently per (run_id, system, stream_id)", () => {
    const events = [
      makeEvent({ emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" } }),
      makeEvent({ emitter: { seq: 1, stream_id: "network:room-2", system: "moltnet" } }),
      makeEvent({ emitter: { seq: 3, stream_id: "network:room-2", system: "moltnet" } }),
      makeEvent({
        emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" },
        run_id: "run-2"
      })
    ];

    const result = checkSeqContiguity(events);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toEqual({
      maxSeq: 3,
      missing: [{ from: 2, to: 2 }],
      runId: "run-1",
      streamId: "network:room-2",
      system: "moltnet"
    });
  });

  it("treats a duplicate seq in the same stream as present, not a gap", () => {
    const events = [
      makeEvent({ emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" } }),
      makeEvent({ emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" } }),
      makeEvent({ emitter: { seq: 2, stream_id: "network:room-1", system: "moltnet" } })
    ];

    const result = checkSeqContiguity(events);
    expect(result.gaps).toEqual([]);
  });

  it("returns no gaps and an empty max-seq map for no events", () => {
    const result = checkSeqContiguity([]);
    expect(result.gaps).toEqual([]);
    expect(result.maxSeqByStream.size).toBe(0);
  });

  it("keeps sparse sequence gaps compact", () => {
    const events = [1, Number.MAX_SAFE_INTEGER].map((seq) =>
      makeEvent({ emitter: { seq, stream_id: "sparse", system: "moltnet" } })
    );
    expect(checkSeqContiguity(events).gaps).toEqual([{ maxSeq: Number.MAX_SAFE_INTEGER, missing: [{ from: 2, to: Number.MAX_SAFE_INTEGER - 1 }], runId: "run-1", streamId: "sparse", system: "moltnet" }]);
  });
});
