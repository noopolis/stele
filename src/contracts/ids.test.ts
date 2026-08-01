import { describe, expect, it } from "vitest";

import {
  assertUniqueCauseEventIds,
  CausalEventSystem,
  eventIdMatchesEmitterSystem,
  parseCausalCauseId,
  parseCausalEventId,
  RECOGNIZED_CAUSAL_SYSTEMS
} from "./ids.js";

describe("causal event and cause ids", () => {
  it("parses valid event ids and preserves local suffix", () => {
    const parsed = parseCausalEventId("moltnet:network:room-1");
    expect(parsed.system).toBe("moltnet");
    expect(parsed.local).toBe("network:room-1");
    expect(parsed.local.startsWith("network")).toBe(true);
  });

  it.each(RECOGNIZED_CAUSAL_SYSTEMS)("accepts recognized system %s", (system) => {
    const parsed = parseCausalEventId(`${system}:local`);
    expect(parsed.system).toBe(system);
  });

  it("rejects unknown systems", () => {
    expect(() => parseCausalEventId("unknown:local")).toThrow(/unrecognized causal system/);
  });

  describe("cause ids", () => {
    it("accepts foreign namespaces and splits only at the first colon", () => {
      expect(parseCausalCauseId("driver:turn:7")).toEqual({ namespace: "driver", local: "turn:7" });
    });

    it("accepts a recognized namespace", () => {
      expect(parseCausalCauseId("moltnet:message-1")).toEqual({ namespace: "moltnet", local: "message-1" });
    });

    it("rejects malformed values", () => {
      expect(() => parseCausalCauseId("foo")).toThrow(/must be <namespace>:<local>/);
      expect(() => parseCausalCauseId(":local")).toThrow(/must be <namespace>:<local>/);
      expect(() => parseCausalCauseId("ns:")).toThrow(/local suffix/);
      expect(() => parseCausalCauseId(42)).toThrow(/non-empty string/);
      expect(() => parseCausalCauseId("")).toThrow(/non-empty string/);
    });
  });

  it("rejects empty local suffix", () => {
    expect(() => parseCausalEventId("moltnet:")).toThrow(/local suffix/);
  });

  it("rejects missing separator", () => {
    expect(() => parseCausalEventId("moltnet")).toThrow(/must be <system>:<local>/);
  });

  it("preserves local text with additional colons", () => {
    const parsed = parseCausalEventId("simfile:team:agent:1");
    expect(parsed.local).toBe("team:agent:1");
  });

  it("enforces unique causes", () => {
    expect(() => assertUniqueCauseEventIds(["simfile:a", "simfile:a"])).toThrow(/duplicate cause_event_ids/);
  });

  it("checks event id prefix matching emitter system", () => {
    expect(eventIdMatchesEmitterSystem("daimon:event-1", "daimon" as CausalEventSystem)).toBe(true);
    expect(eventIdMatchesEmitterSystem("moltnet:event-1", "daimon" as CausalEventSystem)).toBe(false);
  });
});
