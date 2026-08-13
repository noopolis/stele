import { describe, expect, it } from "vitest";

import {
  CAUSAL_STREAM_FINAL_VERSION,
  parseCausalStreamFinal,
  validateCausalStreamFinal
} from "./streamFinal.js";

const goldenFinal = {
  emitter: {
    stream_id: "network:room-1",
    system: "moltnet"
  },
  final_seq: 0,
  run_id: "run-1",
  version: CAUSAL_STREAM_FINAL_VERSION
};

describe("causal stream final", () => {
  it("accepts a strict canonical final declaration", () => {
    const result = validateCausalStreamFinal(goldenFinal);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(goldenFinal);
  });

  it("rejects unexpected emitter fields", () => {
    const result = validateCausalStreamFinal({
      ...goldenFinal,
      emitter: { ...goldenFinal.emitter, seq: 4 }
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown emitter systems", () => {
    const result = validateCausalStreamFinal({
      ...goldenFinal,
      emitter: { ...goldenFinal.emitter, system: "bogus" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing top-level fields", () => {
    const result = validateCausalStreamFinal({
      emitter: goldenFinal.emitter,
      final_seq: 0,
      version: CAUSAL_STREAM_FINAL_VERSION
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid version", () => {
    const result = validateCausalStreamFinal({ ...goldenFinal, version: "noopolis.causal-stream-final.v0" });
    expect(result.success).toBe(false);
  });

  it("accepts every recognized emitter system", () => {
    for (const system of ["simfile", "moltnet", "mneme", "daimon"] as const) {
      const result = validateCausalStreamFinal({
        ...goldenFinal,
        emitter: { ...goldenFinal.emitter, system },
        final_seq: 1,
        run_id: `run-${system}`
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects negative final sequences", () => {
    expect(validateCausalStreamFinal({ ...goldenFinal, final_seq: -1 }).success).toBe(false);
  });

  it("rejects non-integer final sequences", () => {
    expect(validateCausalStreamFinal({ ...goldenFinal, final_seq: 1.5 }).success).toBe(false);
  });

  it("rejects unsafe integer final sequences", () => {
    const result = validateCausalStreamFinal({
      ...goldenFinal,
      final_seq: Number.MAX_SAFE_INTEGER + 1
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty run_id and stream_id", () => {
    expect(validateCausalStreamFinal({ ...goldenFinal, run_id: "" }).success).toBe(false);
    expect(validateCausalStreamFinal({ ...goldenFinal, emitter: { ...goldenFinal.emitter, stream_id: "" } }).success).toBe(false);
  });

  it("parses a valid final declaration via parseCausalStreamFinal", () => {
    expect(parseCausalStreamFinal(goldenFinal)).toEqual(goldenFinal);
  });
});
