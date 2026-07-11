import { describe, expect, it } from "vitest";

import {
  CAUSAL_EVENT_VERSION,
  canonicalJsonStringify,
  causalEventSchema,
  hashCausalEvent,
  parseCausalEvent,
  parseCausalJsonl,
  validateCausalEvent
} from "./envelope.js";
import type { CausalEvent } from "./envelope.js";

const goldenRecord: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" },
  event_id: "moltnet:m1",
  payload: { content_sha256: "a".repeat(64), message_id: "m1" },
  principal_id: "agent:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

describe("causalEventSchema", () => {
  it("round-trips a golden record byte-for-byte", () => {
    const result = validateCausalEvent(goldenRecord);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(goldenRecord);
  });

  it("rejects an unknown top-level key", () => {
    const result = validateCausalEvent({ ...goldenRecord, extra: true });
    expect(result.success).toBe(false);
  });

  it("rejects a version other than the literal", () => {
    const result = validateCausalEvent({ ...goldenRecord, version: "noopolis.causal-event.v2" });
    expect(result.success).toBe(false);
  });

  it("rejects an event_id whose system prefix does not match emitter.system", () => {
    const result = validateCausalEvent({ ...goldenRecord, event_id: "daimon:m1" });
    expect(result.success).toBe(false);
  });

  it("rejects an event_id without a <system>:<local> separator", () => {
    const result = validateCausalEvent({ ...goldenRecord, event_id: "m1" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO recorded_at", () => {
    const result = validateCausalEvent({ ...goldenRecord, recorded_at: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects an emitter.seq below 1", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, seq: 0 }
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized emitter.system", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, system: "unknown-system" }
    });
    expect(result.success).toBe(false);
  });

  it("accepts every declared emitter system", () => {
    for (const system of ["simfile", "moltnet", "mneme", "daimon"] as const) {
      const result = validateCausalEvent({
        ...goldenRecord,
        emitter: { ...goldenRecord.emitter, system },
        event_id: `${system}:local-1`
      });
      expect(result.success).toBe(true);
    }
  });

  /**
   * B62: principal_id is grammar-enforced on the wire itself, not just by
   * conformance.ts's PRINCIPAL_DISCIPLINE_CHECKS layered on top — the schema
   * is the real conformance path's first line of defense (realConformance.test.ts
   * proves the layered checks separately for the schema-valid-but-anonymous case).
   */
  it.each(["agent-1", "anonymous", "moltnet:authn:agent-1", ""])(
    "rejects a non-grammar principal_id %j",
    (principalId) => {
      const result = validateCausalEvent({ ...goldenRecord, principal_id: principalId });
      expect(result.success).toBe(false);
    }
  );

  it.each(["agent:agent-1", "operator:control", "system:simfile.world", "system:moltnet.anonymous"])(
    "accepts a grammar-valid principal_id %s",
    (principalId) => {
      const result = validateCausalEvent({ ...goldenRecord, principal_id: principalId });
      expect(result.success).toBe(true);
    }
  );
});

describe("parseCausalEvent", () => {
  it("returns the parsed event for a valid record", () => {
    expect(parseCausalEvent(goldenRecord)).toEqual(goldenRecord);
  });

  it("throws with issue detail for an invalid record", () => {
    expect(() => parseCausalEvent({ ...goldenRecord, version: "bad" })).toThrow(/invalid causal event/);
  });
});

describe("parseCausalJsonl", () => {
  it("parses multiple valid records and ignores blank lines", () => {
    const jsonl = `${JSON.stringify(goldenRecord)}\n\n${JSON.stringify({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, seq: 2 },
      event_id: "moltnet:m2"
    })}\n`;

    const { errors, events } = parseCausalJsonl(jsonl);
    expect(errors).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it("reports a line-numbered error for invalid JSON", () => {
    const jsonl = `${JSON.stringify(goldenRecord)}\nnot-json\n`;

    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toHaveLength(1);
    expect(errors).toEqual([{ line: 2, message: expect.stringContaining("invalid JSON") }]);
  });

  it("reports a line-numbered error for a schema violation", () => {
    const jsonl = `${JSON.stringify({ ...goldenRecord, version: "bad" })}\n`;

    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(1);
  });

  it("returns no events for empty input", () => {
    expect(parseCausalJsonl("")).toEqual({ errors: [], events: [] });
  });
});

describe("canonicalJsonStringify", () => {
  it("produces the same string regardless of key order", () => {
    const left = canonicalJsonStringify({ a: 1, b: { d: 4, c: 3 } });
    const right = canonicalJsonStringify({ b: { c: 3, d: 4 }, a: 1 });
    expect(left).toBe(right);
  });

  it("sorts keys inside array elements too", () => {
    const value = canonicalJsonStringify([{ b: 2, a: 1 }]);
    expect(value).toBe('[{"a":1,"b":2}]');
  });
});

describe("hashCausalEvent", () => {
  it("hashes structurally identical events the same regardless of field order", () => {
    const reordered = {
      version: goldenRecord.version,
      type: goldenRecord.type,
      run_id: goldenRecord.run_id,
      recorded_at: goldenRecord.recorded_at,
      principal_id: goldenRecord.principal_id,
      payload: goldenRecord.payload,
      event_id: goldenRecord.event_id,
      emitter: goldenRecord.emitter,
      cause_event_ids: goldenRecord.cause_event_ids
    } as unknown as CausalEvent;

    expect(hashCausalEvent(goldenRecord)).toBe(hashCausalEvent(reordered));
  });

  it("hashes differing payloads differently", () => {
    const changed: CausalEvent = {
      ...goldenRecord,
      payload: { ...goldenRecord.payload, content_sha256: "b".repeat(64) }
    };

    expect(hashCausalEvent(goldenRecord)).not.toBe(hashCausalEvent(changed));
  });
});

describe("causalEventSchema export", () => {
  it("is a usable zod schema directly", () => {
    expect(causalEventSchema.safeParse(goldenRecord).success).toBe(true);
  });
});
