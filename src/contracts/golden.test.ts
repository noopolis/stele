import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJsonStringify, parseCanonicalJson } from "./canonicalJson.js";
import { parseCausalBundle } from "./bundle.js";

interface GoldenCase {
  name: string;
  accept: boolean;
  canonical_hex: string | null;
  raw_jsonl: string;
  sha256: string | null;
}

const EXPECTED_MANIFEST_KEYS = ["accept", "canonical_hex", "name", "raw_jsonl", "sha256"];

const validateParsedCase = (entry: unknown): GoldenCase => {
  expect(typeof entry).toBe("object");
  expect(entry).not.toBeNull();

  const manifest = entry as Record<string, unknown>;
  expect(Object.keys(manifest).sort()).toEqual(EXPECTED_MANIFEST_KEYS);

  expect(typeof manifest.name).toBe("string");
  expect(typeof manifest.accept).toBe("boolean");
  const canonical = manifest.canonical_hex;
  expect(canonical === null || typeof canonical === "string").toBe(true);
  expect(typeof manifest.raw_jsonl).toBe("string");
  const sha = manifest.sha256;
  expect(sha === null || typeof sha === "string").toBe(true);

  return manifest as unknown as GoldenCase;
};

const loadGoldenCases = (): GoldenCase[] => {
  const fileUrl = new URL("./goldens/causal-contract.v1.json", import.meta.url);
  const raw = readFileSync(fileUrl, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  expect(Array.isArray(parsed)).toBe(true);
  const cases = parsed as unknown[];
  for (const entry of cases) {
    validateParsedCase(entry);
  }

  const normalized = cases as GoldenCase[];
  expect(normalized.length).toBeGreaterThan(0);

  const canonicalHexPattern = /^[0-9a-f]{2,}$/u;
  const shaPattern = /^[0-9a-f]{64}$/u;

  for (const entry of normalized) {
    if (entry.accept) {
      expect(entry.canonical_hex).not.toBeNull();
      expect(entry.sha256).not.toBeNull();
      if (entry.canonical_hex !== null) {
        expect(canonicalHexPattern.test(entry.canonical_hex)).toBe(true);
      }
      if (entry.sha256 !== null) {
        expect(shaPattern.test(entry.sha256)).toBe(true);
      }
      continue;
    }

    expect(entry.canonical_hex).toBeNull();
    expect(entry.sha256).toBeNull();
  }

  return normalized;
};

const cases = loadGoldenCases();

const expectedAccepted = [
  "accept-normative-event",
  "accept-nested-reordering-and-unicode",
  "accept-empty-payload",
  "accept-finite-fraction",
  "accept-positive-1e-6-fixed",
  "accept-negative-1e-6-fixed",
  "accept-positive-1e-7-exponent",
  "accept-negative-1e-7-exponent",
  "accept-positive-below-1e-6",
  "accept-negative-below-1e-6",
  "accept-positive-above-1e-6",
  "accept-negative-above-1e-6",
  "accept-digest-domain-causal-event",
  "accept-digest-domain-exact-utf8",
  "accept-digest-domain-exact-bytes",
  "accept-final-seq-zero",
  "accept-non-empty-final",
  "accept-multi-stream",
  "accept-nested-numeric-key-order"
];

const expectedRejected = [
  "reject-unknown-event-top-level",
  "reject-unknown-event-emitter-field",
  "reject-unknown-final-top-level",
  "reject-unknown-final-emitter-field",
  "reject-unknown-digest-top-level",
  "reject-wrong-version-event",
  "reject-wrong-version-final",
  "reject-wrong-version-digest",
  "reject-malformed-event-id",
  "reject-unrecognized-event-id-system",
  "reject-mismatched-event-id-prefix",
  "reject-unrecognized-cause-id",
  "reject-repeated-causes",
  "reject-duplicate-event-id",
  "reject-duplicate-stream-slot",
  "reject-present-cross-run-cause",
  "reject-duplicate-final",
  "reject-below-observed-final",
  "reject-empty-final-contradiction",
  "reject-unknown-digest-domain",
  "reject-altered-digest-hash",
  "reject-altered-digest-subject-bytes",
  "reject-altered-digest-output",
  "reject-duplicate-decoded-key",
  "reject-escaped-equivalent-keys",
  "reject-negative-zero",
  "reject-unsafe-integer",
  "reject-invalid-unicode",
  "reject-invalid-json-spelling",
  "reject-non-finite-json-spelling",
  "reject-lone-high-surrogate-runtime-key",
  "reject-lone-low-surrogate-runtime-key"
];

  const normalizeNameInventory = (values: string[]) => new Set(values);

describe("causal contract golden corpus", () => {
  it("validates strict manifest shape and unique names", () => {
    expect(cases.length).toBe(expectedAccepted.length + expectedRejected.length);
    expect(
      cases.map((entry) => entry.name).filter((name, index, all) => all.indexOf(name) !== index)
    ).toEqual([]);

    const seen = new Set<string>();
    const accepted = [];
    const rejected = [];
    for (const entry of cases) {
      if (entry.accept) {
        accepted.push(entry.name);
        expect(entry.canonical_hex).not.toBeNull();
        expect(entry.sha256).not.toBeNull();
        expect(/^[0-9a-f]{2,}$/.test(entry.canonical_hex!)).toBe(true);
        expect(/^[0-9a-f]{64}$/.test(entry.sha256!)).toBe(true);
      } else {
        rejected.push(entry.name);
        expect(entry.canonical_hex).toBeNull();
        expect(entry.sha256).toBeNull();
      }

      expect(typeof entry.raw_jsonl).toBe("string");
      expect(entry.raw_jsonl.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      seen.add(entry.name);
    }
    expect(seen.size).toBe(cases.length);

    expect(new Set(accepted)).toEqual(normalizeNameInventory(expectedAccepted));
    expect(new Set(rejected)).toEqual(normalizeNameInventory(expectedRejected));
    for (const name of expectedAccepted) {
      const found = accepted.includes(name);
      expect(found).toBe(true);
    }
    for (const name of expectedRejected) {
      const found = rejected.includes(name);
      expect(found).toBe(true);
    }
  });

  it("validates accepted cases through the bundle preflight and literal hash oracles", () => {
    const accepted = new Map(cases.filter((entry) => entry.accept).map((entry) => [entry.name, entry]));

    for (const name of expectedAccepted) {
      const entry = accepted.get(name);
      if (!entry) {
        throw new Error(`missing accepted case ${name}`);
      }

      const result = parseCausalBundle(entry.raw_jsonl);
      expect(result.errors).toEqual([]);
      if (result.events.length > 0 || result.streamFinals.length > 0 || result.digestDomains.length > 0) {
        expect(result.events.length + result.streamFinals.length + result.digestDomains.length).toBeGreaterThan(0);
      }

      const canonicalLines = entry.raw_jsonl
        .split("\n")
        .map((line) => parseCanonicalJson(line))
        .map((value) => canonicalJsonStringify(value));
      const canonicalJoined = canonicalLines.join("\n");

      expect(Buffer.from(canonicalJoined).toString("hex")).toBe(entry.canonical_hex);
      expect(createHash("sha256").update(canonicalJoined).digest("hex")).toBe(entry.sha256);
    }
  });

  it("validates rejected cases through bundle preflight and placeholder null oracles", () => {
    const rejected = new Map(cases.filter((entry) => !entry.accept).map((entry) => [entry.name, entry]));

    for (const name of expectedRejected) {
      const entry = rejected.get(name);
      if (!entry) {
        throw new Error(`missing rejected case ${name}`);
      }

      const result = parseCausalBundle(entry.raw_jsonl);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(entry.accept).toBe(false);
      expect(entry.canonical_hex).toBeNull();
      expect(entry.sha256).toBeNull();

      expect(entry.raw_jsonl).toMatch(/\S/);
    }
  });

  it("enforces exact manifest keys for parsed manifest cases", () => {
    const sampleCase = cases[0];
    const exactKeysCase = {
      accept: sampleCase.accept,
      canonical_hex: sampleCase.canonical_hex,
      name: sampleCase.name,
      raw_jsonl: sampleCase.raw_jsonl,
      sha256: sampleCase.sha256
    };
    expect(() => validateParsedCase(exactKeysCase)).not.toThrow();

    const extraKeyCase = {
      ...exactKeysCase,
      unexpected: "unexpected"
    };
    expect(() => validateParsedCase(extraKeyCase)).toThrow();

    const missingKeyCase = {
      accept: sampleCase.accept,
      canonical_hex: sampleCase.canonical_hex,
      raw_jsonl: sampleCase.raw_jsonl,
      sha256: sampleCase.sha256
    };
    expect(() => validateParsedCase(missingKeyCase)).toThrow();
  });
});
