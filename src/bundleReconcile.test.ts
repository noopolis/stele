import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { reconcileCausalBundle } from "./bundleReconcile.js";
import { compareCausalDigest, SUPPORTED_CAUSAL_DIGEST_DECLARATIONS } from "./contracts/digestDomain.js";
import { canonicalJsonStringify, type CausalEvent } from "./envelope.js";

const event = (id: string, seq = 1, causes: string[] = [], stream = "s", run = "run"): CausalEvent => ({
  cause_event_ids: causes, emitter: { seq, stream_id: stream, system: "moltnet" }, event_id: id,
  payload: { id }, principal_id: "agent:test", recorded_at: "2026-07-20T00:00:00.000Z",
  run_id: run, type: "message.accepted", version: "noopolis.causal-event.v1"
});
const final = (stream = "s", finalSeq = 1, run = "run") => ({
  emitter: { stream_id: stream, system: "moltnet" }, final_seq: finalSeq, run_id: run, version: "noopolis.causal-stream-final.v1"
});
const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const domain = (label: "causal-event/canonical-json" | "content/exact-utf8" | "content/exact-bytes") =>
  SUPPORTED_CAUSAL_DIGEST_DECLARATIONS.find((candidate) => candidate.label === label)!;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

describe("reconcileCausalBundle", () => {
  it("seals disconnected and multi-stream graphs only with complete authoritative finals", () => {
    const input = lines(event("moltnet:a", 1, [], "a"), event("moltnet:b", 1, ["moltnet:a"], "b"), final("b"), final("a"));
    const result = reconcileCausalBundle(input);
    expect(result.verdict).toBe("valid");
    expect(result.streams.map(({ streamId, status }) => [streamId, status])).toEqual([["a", "complete"], ["b", "complete"]]);
    expect([...result.graph.byEventId.values()].every(({ state }) => state === "complete")).toBe(true);
  });

  it("retains accepted records while parser errors independently invalidate", () => {
    const result = reconcileCausalBundle(`${lines(event("moltnet:a"), final())}\n{`);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "parser-error", line: 3 })]);
    expect(result.graph.byEventId.get("moltnet:a")?.state).toBe("complete");
    expect(reconcileCausalBundle("{").graph.byEventId.size).toBe(0);
  });

  it("makes missing finals partial and authoritative gaps or absent positive streams stale", () => {
    const partial = reconcileCausalBundle(lines(event("moltnet:a"), event("moltnet:b", 1, ["moltnet:a"], "b"), final("b")));
    expect(partial.verdict).toBe("incomplete");
    expect(partial.graph.byEventId.get("moltnet:a")?.reasonCodes).toContain("missing-authoritative-stream-final");
    expect(partial.graph.byEventId.get("moltnet:b")?.state).toBe("partial");
    const stale = reconcileCausalBundle(lines(event("moltnet:a", 1, [], "g"), event("moltnet:b", 3, [], "g"), final("g", 3), final("empty", 2)));
    expect(stale.streams.map(({ streamId, status, missing }) => [streamId, status, missing])).toEqual([
      ["empty", "stale", []], ["g", "stale", [{ from: 2, to: 2 }]]
    ]);
    expect(stale.graph.byEventId.get("moltnet:a")?.state).toBe("stale");
    expect(reconcileCausalBundle(lines(final("empty", 0))).verdict).toBe("valid");
  });

  it("uses parser finality errors as invalid without compatibility final hints", () => {
    const below = reconcileCausalBundle(lines(event("moltnet:a", 2), final("s", 1)));
    expect(below.verdict).toBe("invalid");
    expect(below.diagnostics[0]?.message).toContain("below observed sequence");
    const duplicate = reconcileCausalBundle(lines(final(), final()));
    expect(duplicate.verdict).toBe("invalid");
  });

  it("keeps graph divergence and unknown authority distinct from parser validity", () => {
    const cycle = reconcileCausalBundle(lines(
      event("moltnet:a", 1, ["moltnet:b"], "a"), event("moltnet:b", 1, ["moltnet:a"], "b"), final("a"), final("b")
    ));
    expect(cycle.verdict).toBe("invalid");
    expect(cycle.graph.byEventId.get("moltnet:a")?.reasonCodes).toContain("cycle");
    const unknown = reconcileCausalBundle(lines(event("moltnet:a", 1, ["mneme:missing"]), final()));
    expect(unknown.verdict).toBe("incomplete");
    expect(unknown.graph.byEventId.get("moltnet:a")?.state).toBe("unknown");
  });

  it("rejects duplicate declarations but exposes each recognized declaration in isolation", () => {
    const result = reconcileCausalBundle(lines(final("empty", 0), domain("content/exact-bytes"), domain("content/exact-bytes")));
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate-digest-domain" }));
    const all = reconcileCausalBundle(lines(final("empty", 0), ...SUPPORTED_CAUSAL_DIGEST_DECLARATIONS));
    expect(all.verdict).toBe("valid");
    expect(all.digestDomains.map(({ label }) => label)).toEqual(["causal-event/canonical-json", "content/exact-bytes", "content/exact-utf8"]);
  });

  it("canonically orders every valid result array and does not retain result mutation", () => {
    const records = [
      event("moltnet:a", 1, [], "z"), final("z"), domain("content/exact-utf8"),
      event("moltnet:b", 1, [], "a"), final("a"), domain("content/exact-bytes")
    ];
    const left = reconcileCausalBundle(lines(...records));
    const right = reconcileCausalBundle(lines(...records.slice().reverse()));
    expect(left.streams).toEqual(right.streams);
    expect(left.streamFinals).toEqual(right.streamFinals);
    expect(left.digestDomains).toEqual(right.digestDomains);
    expect(left.streamFinals.map(({ emitter }) => emitter.stream_id)).toEqual(["a", "z"]);
    expect(left.digestDomains.map(({ label }) => label)).toEqual(["content/exact-bytes", "content/exact-utf8"]);
    left.streams[0]!.missing.push({ from: 99, to: 99 });
    left.streamFinals[0]!.emitter.stream_id = "changed";
    left.digestDomains[0]!.label = "content/exact-utf8";
    expect(reconcileCausalBundle(lines(...records))).toMatchObject({ digestDomains: right.digestDomains, streamFinals: right.streamFinals, streams: right.streams });
    const source = new TextEncoder().encode(lines(...records));
    const fromBytes = reconcileCausalBundle(source);
    source.fill(0);
    expect(fromBytes.verdict).toBe("valid");
    expect(fromBytes.graph.byEventId.get("moltnet:a")?.event.payload).toEqual({ id: "moltnet:a" });
    expect(reconcileCausalBundle("").verdict).toBe("valid");
  });

  it("keeps missing causes partial when authoritative finality knows only their system", () => {
    const child = { ...event("daimon:child", 1, ["moltnet:absent"], "child"), emitter: { seq: 1, stream_id: "child", system: "daimon" as const } };
    const unrelatedStale = reconcileCausalBundle(lines(
      event("moltnet:present", 1, [], "unrelated"),
      child,
      final("unrelated", 2),
      { ...final("empty", 1), emitter: { stream_id: "empty", system: "mneme" } },
      { ...final("absent", 0), emitter: { stream_id: "absent", system: "simfile" } },
      { ...final("child", 1), emitter: { stream_id: "child", system: "daimon" } }
    ));
    expect(unrelatedStale.graph.byEventId.get("daimon:child")).toMatchObject({ localState: "partial", reasonCodes: ["missing-cause-partial"], state: "partial" });
    expect(unrelatedStale.graph.byEventId.get("moltnet:present")?.localState).toBe("stale");
    const descendant = { ...event("daimon:descendant", 1, ["moltnet:present"], "descendant"), emitter: { seq: 1, stream_id: "descendant", system: "daimon" as const } };
    const propagated = reconcileCausalBundle(lines(event("moltnet:present", 1, [], "own"), descendant, final("own", 2), { ...final("descendant"), emitter: { stream_id: "descendant", system: "daimon" } }));
    expect(propagated.graph.byEventId.get("moltnet:present")?.localState).toBe("stale");
    expect(propagated.graph.byEventId.get("daimon:descendant")?.reasonCodes).toEqual(["ancestor-stale"]);
  });

  it("classifies empty and positive authoritative systems as partial, and absent systems as unknown", () => {
    const emptyChild = { ...event("daimon:empty-child", 1, ["mneme:missing"], "empty-child"), emitter: { seq: 1, stream_id: "empty-child", system: "daimon" as const } };
    const positiveChild = { ...event("daimon:positive-child", 1, ["simfile:missing"], "positive-child"), emitter: { seq: 1, stream_id: "positive-child", system: "daimon" as const } };
    const unknownChild = { ...event("daimon:unknown-child", 1, ["moltnet:missing"], "unknown-child"), emitter: { seq: 1, stream_id: "unknown-child", system: "daimon" as const } };
    const result = reconcileCausalBundle(lines(
      emptyChild, positiveChild, unknownChild,
      { ...final("empty", 0), emitter: { stream_id: "empty", system: "mneme" } },
      { ...final("positive", 1), emitter: { stream_id: "positive", system: "simfile" } },
      { ...final("empty-child"), emitter: { stream_id: "empty-child", system: "daimon" } },
      { ...final("positive-child"), emitter: { stream_id: "positive-child", system: "daimon" } },
      { ...final("unknown-child"), emitter: { stream_id: "unknown-child", system: "daimon" } }
    ));
    expect(result.graph.byEventId.get("daimon:empty-child")).toMatchObject({ localState: "partial", reasonCodes: ["missing-cause-partial"] });
    expect(result.graph.byEventId.get("daimon:positive-child")).toMatchObject({ localState: "partial", reasonCodes: ["missing-cause-partial"] });
    expect(result.graph.byEventId.get("daimon:unknown-child")).toMatchObject({ localState: "unknown", reasonCodes: ["missing-cause-unknown"] });
  });
});

describe("compareCausalDigest", () => {
  it("compares accepted indexed canonical events and exact original UTF-8 or bytes", () => {
    const bundled = reconcileCausalBundle(lines(event("moltnet:a"), final()));
    const accepted = bundled.graph.byEventId.get("moltnet:a")!.event;
    const expectedEvent = sha(new TextEncoder().encode(canonicalJsonStringify(accepted)));
    expect(compareCausalDigest(domain("causal-event/canonical-json"), accepted, expectedEvent)).toMatchObject({ matches: true });
    expect(compareCausalDigest(domain("causal-event/canonical-json"), { ...accepted, payload: { id: "altered" } }, expectedEvent)).toEqual({ matches: false, reason: "digest-mismatch" });
    const text = "café\u0000";
    expect(compareCausalDigest(domain("content/exact-utf8"), text, sha(text))).toMatchObject({ matches: true });
    const bytes = Uint8Array.from([0, 0xff, 0x61]); const copied = bytes.slice();
    expect(compareCausalDigest(domain("content/exact-bytes"), bytes, sha(bytes))).toMatchObject({ matches: true });
    copied[1] = 0;
    expect(compareCausalDigest(domain("content/exact-bytes"), copied, sha(bytes))).toEqual({ matches: false, reason: "digest-mismatch" });
  });

  it("fails closed for invalid labels, subject types, and expected hashes", () => {
    expect(compareCausalDigest({ ...domain("content/exact-bytes"), label: "bad" }, new Uint8Array(), "a".repeat(64))).toEqual({ matches: false, reason: "invalid-domain" });
    expect(compareCausalDigest(domain("content/exact-bytes"), "text", "a".repeat(64))).toEqual({ matches: false, reason: "invalid-subject" });
    expect(compareCausalDigest(domain("content/exact-utf8"), "text", "A".repeat(64))).toEqual({ matches: false, reason: "invalid-expected-hash" });
  });
});
