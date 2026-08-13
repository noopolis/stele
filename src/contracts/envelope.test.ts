import { describe, expect, it } from "vitest";

import {
  CAUSAL_EVENT_VERSION,
  canonicalJsonStringify,
  causalEventSchema,
  hashCausalEvent,
  parseCausalEvent,
  parseCausalJsonl,
  parseCausalJsonlBytes,
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
  it("accepts a golden record byte-for-byte", () => {
    const result = validateCausalEvent(goldenRecord);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(goldenRecord);
  });

  it("rejects unknown top-level fields", () => {
    const result = validateCausalEvent({ ...goldenRecord, extra: true });
    expect(result.success).toBe(false);
  });

  it("rejects unknown emitter system", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, system: "bogus" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsafe seq integers", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, seq: Number.MAX_SAFE_INTEGER + 1 }
    });
    expect(result.success).toBe(false);
  });

  it("rejects seq below one", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, seq: 0 }
    });
    expect(result.success).toBe(false);
  });

  it("rejects event_id that does not match emitter", () => {
    const result = validateCausalEvent({ ...goldenRecord, event_id: "simfile:m1" });
    expect(result.success).toBe(false);
  });

  it("admits a bare cause id (reconciliation content, not an admission field)", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      cause_event_ids: ["missing-colon"]
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.cause_event_ids).toEqual(["missing-colon"]);
  });

  it("admits a foreign cause namespace unchanged", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      cause_event_ids: ["driver:turn:7"]
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.cause_event_ids).toEqual(["driver:turn:7"]);
  });

  it("rejects duplicate cause ids while preserving order", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      cause_event_ids: ["simfile:parent-1", "simfile:parent-1"]
    });
    expect(result.success).toBe(false);
  });

  it("accepts each recognized emitter system", () => {
    for (const system of ["simfile", "moltnet", "mneme", "daimon"] as const) {
      const result = validateCausalEvent({
        ...goldenRecord,
        emitter: { ...goldenRecord.emitter, system },
        event_id: `${system}:local-1`
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts principal_id grammar", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      principal_id: "system:simfile.world"
    });
    expect(result.success).toBe(true);
  });

  it("rejects broad-date recorded_at values", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      recorded_at: "2026-07-09 00:00:00"
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid leap-day recorded_at", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      event_id: "moltnet:local-2",
      emitter: { ...goldenRecord.emitter, stream_id: "stream-2" },
      recorded_at: "2024-02-29T00:00:00Z"
    });
    expect(result.success).toBe(true);
  });

  it("rejects impossible recorded_at dates and offsets", () => {
    expect(
      validateCausalEvent({
        ...goldenRecord,
        event_id: "moltnet:local-3",
        emitter: { ...goldenRecord.emitter, stream_id: "stream-3" },
        recorded_at: "2026-02-29T00:00:00Z"
      }).success
    ).toBe(false);

    expect(
      validateCausalEvent({
        ...goldenRecord,
        event_id: "moltnet:local-4",
        emitter: { ...goldenRecord.emitter, stream_id: "stream-4" },
        recorded_at: "2026-04-31T00:00:00Z"
      }).success
    ).toBe(false);

    expect(
      validateCausalEvent({
        ...goldenRecord,
        event_id: "moltnet:local-5",
        emitter: { ...goldenRecord.emitter, stream_id: "stream-5" },
        recorded_at: "2026-01-01T00:00:00+24:00"
      }).success
    ).toBe(false);

    expect(
      validateCausalEvent({
        ...goldenRecord,
        event_id: "moltnet:local-6",
        emitter: { ...goldenRecord.emitter, stream_id: "stream-6" },
        recorded_at: "2026-07-31T24:00:00Z"
      }).success
    ).toBe(false);
  });

  it("accepts recorded_at with timezone offsets and fractional seconds", () => {
    const result = validateCausalEvent({
      ...goldenRecord,
      recorded_at: "2026-07-09T00:00:00.123+02:30",
      event_id: "moltnet:room:1",
      emitter: { ...goldenRecord.emitter, stream_id: "room:1" }
    });
    expect(result.success).toBe(true);
  });
});

describe("parseCausalEvent", () => {
  it("returns a parsed event for a valid record", () => {
    expect(parseCausalEvent(goldenRecord)).toEqual(goldenRecord);
  });
});

describe("parseCausalJsonl", () => {
  it("keeps blank lines", () => {
    const jsonl = `${JSON.stringify(goldenRecord)}\n\n${JSON.stringify({
      ...goldenRecord,
      emitter: { ...goldenRecord.emitter, seq: 2 },
      event_id: "moltnet:m2"
    })}\n`;
    const { errors, events } = parseCausalJsonl(jsonl);
    expect(errors).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it("aggregates raw JSON duplicate-key errors with line numbers", () => {
    const jsonl = `{"v":1,"v":2}\n`;
    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining("duplicate key") });
  });

  it("aggregates escaped-key duplicate errors with line numbers", () => {
    const jsonl = `{"a":1,"\\u0061":2}\n`;
    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining("invalid JSON: duplicate key") });
  });

  it("reports schema errors separately from parse errors", () => {
    const jsonl = `{"not":"record"}\n`;
    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(1);
  });

  it("labels malformed JSON with an invalid JSON prefix", () => {
    const { errors } = parseCausalJsonl(`{`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("invalid JSON:")
    });
  });

  it("accepts valid leap-day JSONL records", () => {
    const { errors, events } = parseCausalJsonl(
      `{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"moltnet:m3","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2024-02-29T00:00:00Z","cause_event_ids":[],"payload":{}}\n`
    );
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("admits a bare cause id through the JSONL ingest gate", () => {
    const { errors, events } = parseCausalJsonl(
      `${JSON.stringify({ ...goldenRecord, cause_event_ids: ["fixture-turn-1"] })}\n`
    );
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.cause_event_ids).toEqual(["fixture-turn-1"]);
  });

  it("rejects impossible recorded_at dates in JSONL parsing", () => {
    const { errors } = parseCausalJsonl(
      `{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"moltnet:m4","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2026-04-31T00:00:00Z","cause_event_ids":[],"payload":{}}\n`
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.not.stringContaining("invalid JSON:")
    });
  });

  it("reports malformed bytes as invalid JSON", () => {
    const { errors } = parseCausalJsonlBytes(Uint8Array.from([0xff]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("invalid JSON:")
    });
  });

  it("rejects BOM-prefixed JSONL bytes", () => {
    const bytes = new TextEncoder().encode(
      `\uFEFF{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"moltnet:m5","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2026-07-09T00:00:00.000Z","cause_event_ids":[],"payload":{}}`
    );
    const { errors } = parseCausalJsonlBytes(bytes);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("invalid JSON:")
    });
  });

  it("accepts ordinary UTF-8 JSONL bytes", () => {
    const { errors, events } = parseCausalJsonlBytes(
      new TextEncoder().encode(
        `${JSON.stringify({
          ...goldenRecord,
          event_id: "moltnet:m6",
          emitter: { ...goldenRecord.emitter, stream_id: "network:room-1", seq: 1 }
        })}\n`
      )
    );
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("rejects a runtime hostile JSON number", () => {
    const jsonl = `{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"moltnet:m1","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2026-07-09T00:00:00.000Z","cause_event_ids":[],"payload":{"value":-0}}\n`;
    const { errors, events } = parseCausalJsonl(jsonl);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(1);
  });

  it("rejects lone surrogate in keys as a JSON parse error", () => {
    const { errors } = parseCausalJsonl(`{"\\uD800":1}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      line: 1,
      message: expect.stringContaining("invalid JSON:")
    });
  });

  it("keeps malformed id in schema validation layer", () => {
    const { errors } = parseCausalJsonl(`{"version":"${CAUSAL_EVENT_VERSION}","run_id":"run","event_id":"bad","emitter":{"system":"moltnet","stream_id":"network:room-1","seq":1},"type":"message.accepted","principal_id":"agent:agent-1","recorded_at":"2026-07-09T00:00:00.000Z","cause_event_ids":[],"payload":{}}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 1, message: expect.not.stringContaining("invalid JSON:") });
  });
});

describe("canonical hashing", () => {
  it("is deterministic across key order", () => {
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
    };

    expect(hashCausalEvent(goldenRecord)).toBe(hashCausalEvent(reordered));
  });

  it("differs when payload data differs", () => {
    const mutated = {
      ...goldenRecord,
      payload: { ...goldenRecord.payload, content_sha256: "b".repeat(64) }
    };
    expect(hashCausalEvent(goldenRecord)).not.toBe(hashCausalEvent(mutated));
  });
});

describe("causalJsonStringify", () => {
  it("sorts keys and rejects non-finite values through the canonical helper", () => {
    expect(canonicalJsonStringify(goldenRecord)).toContain('"cause_event_ids":[]');
  });
});
