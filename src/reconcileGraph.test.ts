import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION, type CausalEvent } from "./envelope.js";
import { reconcileEvents, traceCausesBackward } from "./reconcile.js";

const event = (id: string, causes: string[] = [], run = "run-1", seq = 1): CausalEvent => ({
  cause_event_ids: causes, emitter: { seq, stream_id: `stream:${id}`, system: "moltnet" }, event_id: id,
  payload: { id }, principal_id: "moltnet:authn:test", recorded_at: "2026-07-20T00:00:00.000Z",
  run_id: run, type: "message.accepted", version: CAUSAL_EVENT_VERSION
});

describe("reconcileEvents graph hardening", () => {
  it("marks every cycle member and its descendant divergent without contaminating its ancestor", () => {
    const outside = event("moltnet:outside");
    const a = event("moltnet:a", ["moltnet:b", "moltnet:outside"]);
    const b = event("moltnet:b", ["moltnet:c"]);
    const c = event("moltnet:c", ["moltnet:a"]);
    const child = event("moltnet:child", ["moltnet:a"]);
    const result = reconcileEvents([outside, a, b, c, child]);
    for (const id of ["moltnet:a", "moltnet:b", "moltnet:c", "moltnet:child"]) expect(result.byEventId.get(id)?.state).toBe("divergent");
    expect(result.byEventId.get("moltnet:outside")?.state).toBe("complete");
    expect(result.byEventId.get("moltnet:a")?.reasonCodes).toContain("cycle");
  });

  it("rejects self and present cross-run causes, including an ambiguous id", () => {
    const self = event("moltnet:self", ["moltnet:self"]);
    const foreign = event("moltnet:foreign", [], "run-2");
    const child = event("moltnet:child", ["moltnet:foreign"]);
    const result = reconcileEvents([self, foreign, child]);
    expect(result.byEventId.get("moltnet:self")?.localState).toBe("divergent");
    expect(result.byEventId.get("moltnet:child")?.reasonCodes).toContain("cross-run-cause");
    expect(result.byEventId.get("moltnet:child")?.state).toBe("divergent");
  });

  it("makes a same-id fact in two runs ambiguous to a direct in-run reference", () => {
    const inRun = event("moltnet:shared", [], "run-1");
    const otherRun = event("moltnet:shared", [], "run-2");
    const child = event("daimon:child", ["moltnet:shared"]);
    const result = reconcileEvents([inRun, otherRun, child]);
    expect(result.byEventId.get("daimon:child")?.localState).toBe("divergent");
    expect(result.byEventId.get("daimon:child")?.reasonCodes).toContain("cross-run-cause");
  });

  it("propagates precedence from reachable causes and scopes missing authority by run", () => {
    const knownElsewhere = event("mneme:elsewhere", [], "run-2");
    const unknown = event("daimon:unknown", ["mneme:missing"]);
    const partialRoot = event("moltnet:partial-root", ["moltnet:missing"]);
    const partialChild = event("daimon:partial-child", ["moltnet:partial-root"]);
    const result = reconcileEvents([knownElsewhere, unknown, partialRoot, partialChild]);
    expect(result.byEventId.get("daimon:unknown")?.state).toBe("unknown");
    expect(result.byEventId.get("moltnet:partial-root")?.state).toBe("partial");
    expect(result.byEventId.get("daimon:partial-child")?.state).toBe("partial");
  });

  it("selects an isolated canonical representative independently of input order", () => {
    const first = event("moltnet:duplicate");
    const second = { ...first, payload: { id: "other" } };
    const left = reconcileEvents([first, second]);
    const right = reconcileEvents([second, first]);
    expect(left.byEventId.get("moltnet:duplicate")).toEqual(right.byEventId.get("moltnet:duplicate"));
    first.payload.id = "mutated";
    first.cause_event_ids.push("moltnet:anything");
    expect(left.byEventId.get("moltnet:duplicate")?.event.payload.id).not.toBe("mutated");
    expect(left.occurrencesByEventId.get("moltnet:duplicate")?.[0]?.cause_event_ids).toEqual([]);
  });

  it("handles a 10k chain iteratively in reconciliation and tracing", () => {
    const events: CausalEvent[] = [];
    for (let n = 0; n < 10_100; n += 1) events.push(event(`moltnet:${n}`, n ? [`moltnet:${n - 1}`] : [], "run-1", n + 1));
    const result = reconcileEvents(events);
    expect(result.byEventId.get("moltnet:10099")?.state).toBe("complete");
    expect(traceCausesBackward(result, "moltnet:10099")).toHaveLength(10_099);
  });
});
