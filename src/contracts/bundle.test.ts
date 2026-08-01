import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION, parseCausalJsonl } from "./envelope.js";
import { CAUSAL_STREAM_FINAL_VERSION } from "./streamFinal.js";
import { parseCausalBundle, parseCausalBundleBytes } from "./bundle.js";

import type { CausalEvent } from "./envelope.js";

const eventA: CausalEvent = {
  cause_event_ids: [],
  emitter: {
    seq: 1,
    stream_id: "network:room-1",
    system: "moltnet"
  },
  event_id: "moltnet:e1",
  payload: {},
  principal_id: "agent:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

const eventB: CausalEvent = {
  ...eventA,
  cause_event_ids: ["moltnet:e1"],
  emitter: { ...eventA.emitter, seq: 2 },
  event_id: "moltnet:e2",
  recorded_at: "2026-07-09T00:00:00.001Z"
};

const collisionEventTupleOne: CausalEvent = {
  ...eventA,
  event_id: "simfile:e3",
  emitter: {
    seq: 1,
    stream_id: "foo",
    system: "simfile"
  },
  run_id: "run::moltnet"
};

const collisionEventTupleTwo: CausalEvent = {
  ...eventA,
  event_id: "moltnet:e3",
  emitter: {
    seq: 1,
    stream_id: ":simfile:foo",
    system: "moltnet"
  },
  run_id: "run"
};

const finalForStream = {
  final_seq: 2,
  emitter: {
    stream_id: "network:room-1",
    system: "moltnet"
  },
  run_id: "run-1",
  version: CAUSAL_STREAM_FINAL_VERSION
};

const finalForCollisionTupleOne = {
  final_seq: 1,
  emitter: {
    stream_id: "foo",
    system: "simfile"
  },
  run_id: "run::moltnet",
  version: CAUSAL_STREAM_FINAL_VERSION
};

const finalForCollisionTupleTwo = {
  final_seq: 1,
  emitter: {
    stream_id: ":simfile:foo",
    system: "moltnet"
  },
  run_id: "run",
  version: CAUSAL_STREAM_FINAL_VERSION
};

const exactDigestDomain = {
  hash: "sha-256",
  label: "content/exact-bytes",
  output: "lowercase-hex",
  subject_bytes: "exact-bytes",
  version: "noopolis.causal-digest-domain.v1"
};

describe("parseCausalBundle", () => {
  it("accepts mixed canonical event/final/domain input", () => {
    const jsonl = `${JSON.stringify(eventA)}\n${JSON.stringify(eventB)}\n${JSON.stringify(finalForStream)}\n${JSON.stringify(exactDigestDomain)}\n`;
    const { events, streamFinals, digestDomains, errors } = parseCausalBundle(jsonl);
    expect(errors).toEqual([]);
    expect(events).toHaveLength(2);
    expect(streamFinals).toHaveLength(1);
    expect(digestDomains).toHaveLength(1);
  });

  it("preserves blank lines while parsing", () => {
    const jsonl = `${JSON.stringify(eventA)}\n\n${JSON.stringify(eventB)}\n`;
    const { events, errors } = parseCausalBundle(jsonl);
    expect(events).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("keeps malformed JSON as line-local errors", () => {
    const { errors, events } = parseCausalBundle("{\n");
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining("invalid JSON:") });
  });

  it("rejects unknown versions", () => {
    const jsonl = `${JSON.stringify({ ...eventA, version: "noopolis.unknown.v1" })}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining("invalid record") });
  });

  it("rejects malformed event fields", () => {
    const jsonl = `${JSON.stringify({ ...eventA, emitter: { ...eventA.emitter, seq: 0 } })}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
  });

  it("rejects every duplicate event id", () => {
    const duplicate = {
      ...eventA,
      event_id: "moltnet:e1",
      emitter: { ...eventA.emitter, seq: 2, stream_id: "network:room-2" },
      recorded_at: "2026-07-10T00:00:00.000Z"
    };
    const jsonl = `${JSON.stringify(eventA)}\n${JSON.stringify(duplicate)}\n`;
    const { events, errors } = parseCausalBundle(jsonl);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 2, message: "duplicate event_id: moltnet:e1" });
  });

  it("rejects duplicate event seq slot in the same stream", () => {
    const duplicateSlot = { ...eventA, event_id: "moltnet:e2", recorded_at: "2026-07-10T00:00:00.000Z" };
    const jsonl = `${JSON.stringify(eventA)}\n${JSON.stringify(duplicateSlot)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`duplicate event slot`);
  });

  it("rejects duplicate stream finals", () => {
    const duplicateFinal = { ...finalForStream };
    const jsonl = `${JSON.stringify(finalForStream)}\n${JSON.stringify(duplicateFinal)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 2, message: expect.stringContaining("duplicate stream final for run-1::moltnet:network:room-1") });
  });

  it("rejects final below observed sequence", () => {
    const lowFinal = { ...finalForStream, final_seq: 1 };
    const jsonl = `${JSON.stringify(eventA)}\n${JSON.stringify(eventB)}\n${JSON.stringify(lowFinal)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("below observed sequence 2");
  });

  it("rejects empty-stream final paired with an observed event", () => {
    const emptyFinal = { ...finalForStream, final_seq: 0 };
    const jsonl = `${JSON.stringify(eventA)}\n${JSON.stringify(emptyFinal)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(2);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 2,
          message: expect.stringContaining("below observed sequence")
        }),
        expect.objectContaining({
          line: 2,
          message: expect.stringContaining("has final_seq 0 but stream has observed events")
        })
      ])
    );
  });

  it("accepts unresolved direct causes", () => {
    const unresolved = { ...eventA, event_id: "moltnet:e3", cause_event_ids: ["moltnet:missing"] };
    const jsonl = `${JSON.stringify(unresolved)}\n`;
    const { events, errors } = parseCausalBundle(jsonl);
    expect(events).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("admits a bare cause id at ingest but rejects it at seal", () => {
    const jsonl = `${JSON.stringify({ ...eventA, cause_event_ids: ["fixture-turn-1"] })}\n`;

    // Be liberal in what you accept from others: INGEST preserves evidence
    // so stitching can repair the producer-local cause.
    const ingest = parseCausalJsonl(jsonl);
    expect(ingest.errors).toEqual([]);
    expect(ingest.events).toHaveLength(1);
    expect(ingest.events[0]?.cause_event_ids).toEqual(["fixture-turn-1"]);

    // Be strict in what you seal yourself: SEALING rejects the producer defect.
    const sealed = parseCausalBundle(jsonl);
    expect(sealed.errors.length).toBeGreaterThan(0);
    expect(sealed.errors.some((error) => error.message.includes("fixture-turn-1"))).toBe(true);
  });

  it("accepts a foreign cause namespace at ingest and seal", () => {
    const jsonl = `${JSON.stringify({ ...eventA, cause_event_ids: ["driver:turn:7"] })}\n`;

    // Be liberal in what you accept from others and strict in what you seal
    // yourself; foreign namespaces conform on both sides of that rule.
    const ingest = parseCausalJsonl(jsonl);
    expect(ingest.errors).toEqual([]);
    expect(ingest.events).toHaveLength(1);
    expect(ingest.events[0]?.cause_event_ids).toEqual(["driver:turn:7"]);

    const sealed = parseCausalBundle(jsonl);
    expect(sealed.errors).toEqual([]);
    expect(sealed.events).toHaveLength(1);
    expect(sealed.events[0]?.cause_event_ids).toEqual(["driver:turn:7"]);
  });

  it("rejects direct causes that resolve to another run", () => {
    const otherRun = { ...eventA, event_id: "simfile:p1", run_id: "run-2", emitter: { ...eventA.emitter, system: "simfile" } };
    const causeFromAnotherRun = { ...eventA, event_id: "moltnet:e4", cause_event_ids: ["simfile:p1"] };
    const jsonl = `${JSON.stringify(otherRun)}\n${JSON.stringify(causeFromAnotherRun)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 2,
      message: expect.stringContaining("belongs to another run")
    });
  });

  it("rejects malformed digest domains with a line error", () => {
    const badDomain = { ...exactDigestDomain, label: "bogus" };
    const { errors } = parseCausalBundle(`${JSON.stringify(badDomain)}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining("label") });
  });

  it("keeps delimiter-based tuple collisions out of event slot identity", () => {
    const jsonl = `${JSON.stringify(collisionEventTupleOne)}\n${JSON.stringify(collisionEventTupleTwo)}\n`;
    const { errors, events } = parseCausalBundle(jsonl);
    expect(errors).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it("keeps delimiter-based tuple collisions out of stream final identity", () => {
    const jsonl = `${JSON.stringify(finalForCollisionTupleOne)}\n${JSON.stringify(finalForCollisionTupleTwo)}\n`;
    const { errors, streamFinals } = parseCausalBundle(jsonl);
    expect(errors).toEqual([]);
    expect(streamFinals).toHaveLength(2);
  });

  it("keeps final checks separated for delimiter-collision tuples", () => {
    const event = { ...collisionEventTupleOne, event_id: "simfile:e4" };
    const collidingFinalTupleTwo = { ...finalForCollisionTupleTwo, final_seq: 0 };
    const collidingFinalTupleOne = { ...finalForCollisionTupleOne, final_seq: 0 };

    const jsonl = `${JSON.stringify(event)}\n${JSON.stringify(collidingFinalTupleOne)}\n${JSON.stringify(collidingFinalTupleTwo)}\n`;
    const { errors } = parseCausalBundle(jsonl);
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual(
      expect.objectContaining({
        line: 2,
        message: expect.stringContaining("below observed sequence 1")
      })
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        line: 2,
        message: expect.stringContaining("has final_seq 0 but stream has observed events")
      })
    );
    expect(errors.filter((error) => error.line === 3)).toHaveLength(0);
  });
});

describe("parseCausalBundleBytes", () => {
  it("rejects invalid UTF-8 bytes", () => {
    const { errors, events } = parseCausalBundleBytes(Uint8Array.from([0xff]));
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("invalid JSON:")
    });
  });

  it("rejects BOM-prefixed JSONL bytes", () => {
    const bytes = new TextEncoder().encode(`\uFEFF{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"moltnet:m1","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2026-07-09T00:00:00.000Z","cause_event_ids":[],"payload":{}}`);
    const { errors } = parseCausalBundleBytes(bytes);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("leading BOM")
    });
  });
});
