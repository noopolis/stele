import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION } from "./envelope.js";
import type { CausalEvent } from "./envelope.js";
import { reconcileEvents, traceCausesBackward } from "./reconcile.js";
import { streamKey } from "./seq.js";

const RUN_ID = "run-1";

const m1: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" },
  event_id: "moltnet:m1",
  payload: { content_sha256: "a".repeat(64), message_id: "m1" },
  principal_id: "moltnet:authn:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: RUN_ID,
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

const memRecalled: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "memory:agent-1", system: "mneme" },
  event_id: "mneme:r1",
  payload: { content_sha256: "c".repeat(64), memory_id: "mem-1" },
  principal_id: "mneme:authn:agent-1",
  recorded_at: "2026-07-09T00:00:01.000Z",
  run_id: RUN_ID,
  type: "memory.recalled",
  version: CAUSAL_EVENT_VERSION
};

const t1In: CausalEvent = {
  cause_event_ids: ["moltnet:m1", "mneme:r1"],
  emitter: { seq: 1, stream_id: "agent:agent-1", system: "daimon" },
  event_id: "daimon:t1-in",
  payload: {
    input_content_sha256: "a".repeat(64),
    input_message_ids: ["m1"],
    prompt_sha256: "p".repeat(64),
    turn_id: "t1"
  },
  principal_id: "daimon:authn:agent-1",
  recorded_at: "2026-07-09T00:00:02.000Z",
  run_id: RUN_ID,
  type: "turn.input.submitted",
  version: CAUSAL_EVENT_VERSION
};

const t1Out: CausalEvent = {
  cause_event_ids: ["daimon:t1-in"],
  emitter: { seq: 2, stream_id: "agent:agent-1", system: "daimon" },
  event_id: "daimon:t1-out",
  payload: { output_sha256: "o".repeat(64), turn_id: "t1" },
  principal_id: "daimon:authn:agent-1",
  recorded_at: "2026-07-09T00:00:03.000Z",
  run_id: RUN_ID,
  type: "turn.output.completed",
  version: CAUSAL_EVENT_VERSION
};

const m2: CausalEvent = {
  cause_event_ids: ["daimon:t1-out"],
  emitter: { seq: 2, stream_id: "network:room-1", system: "moltnet" },
  event_id: "moltnet:m2",
  payload: { content_sha256: "e".repeat(64), message_id: "m2" },
  principal_id: "moltnet:authn:agent-1",
  recorded_at: "2026-07-09T00:00:04.000Z",
  run_id: RUN_ID,
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

const fullChain = [m1, memRecalled, t1In, t1Out, m2];

describe("reconcileEvents — full interaction chain", () => {
  it("reconstructs the exact edge sequence backward from M2 via cause_event_ids only", () => {
    const result = reconcileEvents(fullChain);
    const edges = traceCausesBackward(result, "moltnet:m2");

    expect(edges).toEqual([
      { from: "moltnet:m2", to: "daimon:t1-out" },
      { from: "daimon:t1-out", to: "daimon:t1-in" },
      { from: "daimon:t1-in", to: "moltnet:m1" },
      { from: "daimon:t1-in", to: "mneme:r1" }
    ]);

    for (const eventId of ["moltnet:m2", "daimon:t1-out", "daimon:t1-in", "moltnet:m1", "mneme:r1"]) {
      const record = result.byEventId.get(eventId);
      expect(record).toBeDefined();
      expect(record?.event.principal_id).toMatch(/^(moltnet|daimon|mneme):authn:/);
    }
  });

  it("labels every event in the clean chain complete", () => {
    const result = reconcileEvents(fullChain);
    for (const eventId of ["moltnet:m1", "mneme:r1", "daimon:t1-in", "daimon:t1-out", "moltnet:m2"]) {
      expect(result.byEventId.get(eventId)?.state).toBe("complete");
    }
  });

  it("also traces backward directly from a plain event_id -> CausalEvent map", () => {
    const index = new Map(fullChain.map((event) => [event.event_id, event]));
    const edges = traceCausesBackward(index, "moltnet:m2");
    expect(edges).toHaveLength(4);
  });

  it("marks M2 partial when turn.output.completed is dropped", () => {
    const droppedOutput = fullChain.filter((event) => event.event_id !== "daimon:t1-out");
    const result = reconcileEvents(droppedOutput);

    expect(result.byEventId.get("moltnet:m2")?.state).toBe("partial");
  });

  it("marks the reintroduced turn.output.completed divergent when its content hash differs", () => {
    const conflictingOutput: CausalEvent = {
      ...t1Out,
      payload: { ...t1Out.payload, output_sha256: "f".repeat(64) }
    };

    const result = reconcileEvents([...fullChain, conflictingOutput]);

    expect(result.byEventId.get("daimon:t1-out")?.state).toBe("divergent");
    expect(result.occurrencesByEventId.get("daimon:t1-out")).toHaveLength(2);
  });

  it("marks a duplicate-seq slot occupied by different event_ids divergent", () => {
    const impostor: CausalEvent = {
      ...m1,
      event_id: "moltnet:impostor",
      payload: { content_sha256: "z".repeat(64), message_id: "impostor" }
    };

    const result = reconcileEvents([...fullChain, impostor]);

    expect(result.byEventId.get("moltnet:m1")?.state).toBe("divergent");
    expect(result.byEventId.get("moltnet:impostor")?.state).toBe("divergent");
  });

  it("marks a daimon turn divergent when input_content_sha256 disagrees with moltnet's content_sha256 for the same message_id", () => {
    const conflictingInput: CausalEvent = {
      ...t1In,
      payload: { ...t1In.payload, input_content_sha256: "d".repeat(64) }
    };

    const result = reconcileEvents([m1, memRecalled, conflictingInput, t1Out, m2]);

    expect(result.byEventId.get("daimon:t1-in")?.state).toBe("divergent");
  });

  it("marks unknown when a cause references a system with zero ingested events", () => {
    const withoutMneme = fullChain.filter((event) => event.emitter.system !== "mneme");
    const result = reconcileEvents(withoutMneme);

    expect(result.byEventId.get("daimon:t1-in")?.state).toBe("unknown");
  });

  it("marks stale when a stream's declared final seq exceeds its ingested max seq", () => {
    const declaredFinalSeq = {
      [streamKey(RUN_ID, "daimon", "agent:agent-1")]: 3
    };

    const result = reconcileEvents(fullChain, { declaredFinalSeq });

    expect(result.byEventId.get("daimon:t1-in")?.state).toBe("stale");
    expect(result.byEventId.get("daimon:t1-out")?.state).toBe("stale");
  });

  it("marks a dangling cause stale (not partial) when it resolves to a stream behind its declared final seq", () => {
    const droppedOutput = fullChain.filter((event) => event.event_id !== "daimon:t1-out");
    const declaredFinalSeq = {
      [streamKey(RUN_ID, "daimon", "agent:agent-1")]: 2
    };

    const result = reconcileEvents(droppedOutput, { declaredFinalSeq });

    expect(result.byEventId.get("moltnet:m2")?.state).toBe("stale");
  });

  it("gives divergent precedence over an otherwise-unknown cause on the same event", () => {
    const withoutMneme = fullChain.filter((event) => event.emitter.system !== "mneme");
    const conflictingInput: CausalEvent = {
      ...t1In,
      payload: { ...t1In.payload, input_content_sha256: "d".repeat(64) }
    };
    const events = withoutMneme.map((event) => (event.event_id === "daimon:t1-in" ? conflictingInput : event));

    const result = reconcileEvents(events);

    expect(result.byEventId.get("daimon:t1-in")?.state).toBe("divergent");
  });
});

describe("traceCausesBackward — guard branches", () => {
  it("terminates self and two-node cycles while retaining the encountered edges", () => {
    const self = { ...m1, cause_event_ids: ["moltnet:m1"] };
    expect(traceCausesBackward(new Map([[self.event_id, self]]), self.event_id)).toEqual([{ from: "moltnet:m1", to: "moltnet:m1" }]);
    const a = { ...m1, event_id: "moltnet:a", cause_event_ids: ["moltnet:b"] };
    const b = { ...m1, event_id: "moltnet:b", cause_event_ids: ["moltnet:a"] };
    expect(traceCausesBackward(new Map([[a.event_id, a], [b.event_id, b]]), a.event_id)).toEqual([{ from: "moltnet:a", to: "moltnet:b" }, { from: "moltnet:b", to: "moltnet:a" }]);
  });

  it("records dangling causes and handles a deep iterative chain", () => {
    const dangling = { ...m1, cause_event_ids: ["moltnet:absent"] };
    expect(traceCausesBackward(new Map([[dangling.event_id, dangling]]), dangling.event_id)).toEqual([{ from: "moltnet:m1", to: "moltnet:absent" }]);
    const chain = new Map<string, CausalEvent>();
    for (let index = 0; index < 10_000; index += 1) chain.set(`moltnet:${index}`, { ...m1, event_id: `moltnet:${index}`, cause_event_ids: index ? [`moltnet:${index - 1}`] : [] });
    expect(traceCausesBackward(chain, "moltnet:9999")).toHaveLength(9_999);
  });
  it("returns no edges when the start event_id cannot be resolved", () => {
    const result = reconcileEvents(fullChain);
    expect(traceCausesBackward(result, "moltnet:does-not-exist")).toEqual([]);
  });

  it("still records both edges into a cause shared by two parents without re-expanding it", () => {
    const sharedCause: CausalEvent = {
      ...memRecalled,
      event_id: "mneme:shared",
      emitter: { ...memRecalled.emitter, seq: 2 }
    };
    const parentA: CausalEvent = {
      ...t1In,
      cause_event_ids: ["mneme:shared"],
      event_id: "daimon:parent-a"
    };
    const parentB: CausalEvent = {
      ...t1In,
      cause_event_ids: ["mneme:shared"],
      event_id: "daimon:parent-b"
    };
    const root: CausalEvent = {
      ...t1Out,
      cause_event_ids: ["daimon:parent-a", "daimon:parent-b"],
      event_id: "daimon:diamond-root"
    };

    const index = new Map(
      [sharedCause, parentA, parentB, root].map((event) => [event.event_id, event])
    );

    const edges = traceCausesBackward(index, "daimon:diamond-root");

    expect(edges).toEqual([
      { from: "daimon:diamond-root", to: "daimon:parent-a" },
      { from: "daimon:parent-a", to: "mneme:shared" },
      { from: "daimon:diamond-root", to: "daimon:parent-b" },
      { from: "daimon:parent-b", to: "mneme:shared" }
    ]);
  });
});
