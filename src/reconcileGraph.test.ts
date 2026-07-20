import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION, type CausalEvent } from "./envelope.js";
import { reconcileEvents, traceCausesBackward } from "./reconcile.js";
import { streamKey } from "./seq.js";

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

  it("marks explicit two-node cycles and their descendants divergent", () => {
    const a = event("moltnet:a", ["moltnet:b"]);
    const b = event("moltnet:b", ["moltnet:a"]);
    const child = event("moltnet:child", ["moltnet:b"]);
    const outside = event("moltnet:outside");
    const result = reconcileEvents([child, outside, b, a]);
    for (const id of ["moltnet:a", "moltnet:b", "moltnet:child"]) {
      expect(result.byEventId.get(id)).toMatchObject({ state: "divergent" });
      expect(result.byEventId.get(id)?.reasonCodes.length).toBeGreaterThan(0);
    }
    expect(result.byEventId.get("moltnet:child")?.reasonCodes).toEqual(["ancestor-divergent"]);
    expect(result.byEventId.get("moltnet:outside")?.state).toBe("complete");
  });

  it("rejects self and present cross-run causes, including an ambiguous id", () => {
    const self = event("moltnet:self", ["moltnet:self"]);
    const foreign = event("moltnet:foreign", [], "run-2");
    const child = event("moltnet:child", ["moltnet:foreign"]);
    const descendant = event("daimon:descendant", ["moltnet:child"]);
    const result = reconcileEvents([self, foreign, child, descendant]);
    expect(result.byEventId.get("moltnet:self")?.localState).toBe("divergent");
    expect(result.byEventId.get("moltnet:child")?.reasonCodes).toContain("cross-run-cause");
    expect(result.byEventId.get("moltnet:child")?.state).toBe("divergent");
    expect(result.byEventId.get("daimon:descendant")?.reasonCodes).toEqual(["ancestor-divergent"]);
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

  it("explains highest-precedence state propagated through a diamond", () => {
    const divergent = event("moltnet:divergent", ["moltnet:divergent"]);
    const unknown = event("daimon:unknown", ["mneme:missing"]);
    const partial = { ...event("mneme:partial", ["mneme:missing"]), emitter: { seq: 1, stream_id: "partial", system: "mneme" as const }, principal_id: "mneme:authn:test" };
    const stale = event("moltnet:stale", [], "run-1", 3);
    const left = event("moltnet:left", ["moltnet:divergent", "daimon:unknown"]);
    const right = event("moltnet:right", ["mneme:partial", "moltnet:stale"]);
    const root = event("moltnet:root", ["moltnet:left", "moltnet:right"]);
    const result = reconcileEvents([root, right, stale, partial, left, unknown, divergent], {
      declaredFinalSeq: { [streamKey("run-1", "moltnet", "stream:moltnet:stale")]: 4 }
    });
    expect(result.byEventId.get("moltnet:left")?.reasonCodes).toEqual(["ancestor-divergent"]);
    expect(result.byEventId.get("moltnet:right")?.reasonCodes).toEqual(["ancestor-partial"]);
    expect(result.byEventId.get("moltnet:root")?.reasonCodes).toEqual(["ancestor-divergent"]);
    expect(result.byEventId.get("moltnet:root")?.state).toBe("divergent");
    for (const record of result.byEventId.values()) if (record.state !== "complete") expect(record.reasons.length).toBeGreaterThan(0);
  });

  it("treats final gaps as stale and propagates them to descendants", () => {
    const first = event("moltnet:first", [], "run-1", 1);
    const third = event("moltnet:third", [], "run-1", 3);
    const child = event("daimon:child", ["moltnet:third"]);
    // The helper uses a distinct stream per event; make a genuine shared stream gap.
    const sharedFirst = { ...first, emitter: { ...first.emitter, stream_id: "shared" } };
    const sharedThird = { ...third, emitter: { ...third.emitter, stream_id: "shared" } };
    const sharedChild = { ...child, cause_event_ids: [sharedThird.event_id] };
    const gapped = reconcileEvents([sharedChild, sharedThird, sharedFirst], { declaredFinalSeq: { [streamKey("run-1", "moltnet", "shared")]: 3 } });
    expect(gapped.byEventId.get("moltnet:third")?.localState).toBe("stale");
    expect(gapped.byEventId.get("daimon:child")?.reasonCodes).toEqual(["ancestor-stale"]);
  });

  it("fails closed for hostile declared-final compatibility input without getters or proxy get traps", () => {
    let getterRead = false; let proxyRead = false; let finalGetterRead = false;
    const getterOptions = Object.defineProperty({}, "declaredFinalSeq", { enumerable: true, get: () => { getterRead = true; throw new Error("nope"); } });
    const proxyOptions = new Proxy({ declaredFinalSeq: {} }, { get: () => { proxyRead = true; throw new Error("nope"); } });
    const finalGetter = { declaredFinalSeq: Object.defineProperty({}, streamKey("run-1", "moltnet", "s"), { enumerable: true, get: () => { finalGetterRead = true; throw new Error("nope"); } }) };
    const finalProxy = { declaredFinalSeq: new Proxy({}, { get: () => { proxyRead = true; throw new Error("nope"); } }) };
    const invalidKey = { declaredFinalSeq: { legacy: 1 } };
    const invalidValue = { declaredFinalSeq: { [streamKey("run-1", "moltnet", "s")]: -1 } };
    const extraOption = { declaredFinalSeq: {}, extra: true };
    for (const options of [getterOptions, proxyOptions, finalGetter, finalProxy, invalidKey, invalidValue, extraOption]) {
      const result = reconcileEvents([event("moltnet:only")], options as never);
      expect(result.byEventId.get("moltnet:only")?.reasonCodes).toEqual(["invalid-declared-final-hints"]);
    }
    expect(getterRead).toBe(false); expect(finalGetterRead).toBe(false); expect(proxyRead).toBe(false);
    expect(reconcileEvents([], proxyOptions as never).byEventId.size).toBe(0);
  });

  it("uses UTF-16 ordering, never localeCompare, for representatives and output", () => {
    const z = event("moltnet:z"); const umlaut = event("moltnet:ä");
    const duplicate = { ...z, payload: { id: "ä" } };
    const result = reconcileEvents([umlaut, duplicate, z]);
    expect([...result.byEventId.keys()]).toEqual(["moltnet:z", "moltnet:ä"]);
    expect(reconcileEvents([z, duplicate]).byEventId.get("moltnet:z")).toEqual(reconcileEvents([duplicate, z]).byEventId.get("moltnet:z"));
    expect(readFileSync(new URL("./reconcileGraph.ts", import.meta.url), "utf8") + readFileSync(new URL("./seq.ts", import.meta.url), "utf8")).not.toContain("localeCompare");
  });

  it("selects an isolated canonical representative independently of input order", () => {
    const first = { ...event("moltnet:duplicate"), payload: { id: "original", nested: { value: "original" } } };
    const second = { ...first, payload: { id: "other" } };
    const input = [first, second];
    const left = reconcileEvents(input);
    const right = reconcileEvents([second, first]);
    expect(left.byEventId.get("moltnet:duplicate")).toEqual(right.byEventId.get("moltnet:duplicate"));
    first.payload.id = "mutated";
    first.cause_event_ids.push("moltnet:anything");
    first.emitter.stream_id = "mutated";
    (first.payload as { nested: { value: string } }).nested.value = "mutated";
    input.length = 0;
    expect(left.byEventId.get("moltnet:duplicate")?.event.payload.id).not.toBe("mutated");
    expect(left.byEventId.get("moltnet:duplicate")?.event.emitter.stream_id).not.toBe("mutated");
    const original = left.occurrencesByEventId.get("moltnet:duplicate")?.find(({ payload }) => payload.id === "original");
    expect((original?.payload.nested as { value: string }).value).toBe("original");
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
