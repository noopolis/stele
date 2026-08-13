import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CAUSAL_DIGEST_DOMAIN_VERSION,
  RECOGNIZED_DIGEST_LABELS,
  SUPPORTED_CAUSAL_DIGEST_DECLARATIONS,
  areCausalDigestDeclarationsComparable,
  getCanonicalDigestDeclarationBytes,
  parseCausalDigestDomain,
  subjectHashBytesFromDigestDomain,
  subjectHashFromDigestDomain,
  validateCausalDigestDomain
} from "./digestDomain.js";

import { canonicalJsonBytes, parseCanonicalJson } from "./canonicalJson.js";
import { parseCausalEvent } from "./envelope.js";
import type { CausalDigestDomain, CausalDigestLabel } from "./digestDomain.js";
import type { CausalEvent } from "./envelope.js";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const declarationByLabel = (label: (typeof RECOGNIZED_DIGEST_LABELS)[number]) =>
  SUPPORTED_CAUSAL_DIGEST_DECLARATIONS.find((declaration) => declaration.label === label);

const canonicalJsonDomain = () =>
  declarationByLabel("causal-event/canonical-json") as (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number];

const exactUtf8Domain = () => declarationByLabel("content/exact-utf8") as (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number];

const exactBytesDomain = () => declarationByLabel("content/exact-bytes") as (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number];

const goldenEvent: CausalEvent = {
  cause_event_ids: [],
  emitter: {
    seq: 4,
    stream_id: "network:room-1",
    system: "moltnet"
  },
  event_id: "moltnet:hashable-1",
  payload: {},
  principal_id: "agent:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: "noopolis.causal-event.v1"
};

const canonicalEventBytes = () =>
  canonicalJsonBytes(parseCausalEvent(goldenEvent));

describe("causal digest domain schema", () => {
  it("accepts all exact supported declaration tuples", () => {
    for (const declaration of SUPPORTED_CAUSAL_DIGEST_DECLARATIONS) {
      expect(validateCausalDigestDomain(declaration).success).toBe(true);
    }
  });

  it("rejects unknown labels", () => {
    expect(
      validateCausalDigestDomain({
        hash: "sha-256",
        label: "content/unknown",
        output: "lowercase-hex",
        subject_bytes: "exact-bytes",
        version: CAUSAL_DIGEST_DOMAIN_VERSION
      } as unknown).success
    ).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const result = validateCausalDigestDomain({
      hash: "sha-256",
      label: "content/exact-bytes",
      output: "lowercase-hex",
      subject_bytes: "exact-bytes",
      version: CAUSAL_DIGEST_DOMAIN_VERSION,
      extra: true
    } as {
      hash: string;
      label: string;
      output: string;
      subject_bytes: string;
      version: string;
      extra: boolean;
    });
    expect(result.success).toBe(false);
  });

  it("accepts all labels and rejects one-field declaration tuple mutation", () => {
    for (const declaration of SUPPORTED_CAUSAL_DIGEST_DECLARATIONS) {
      expect(validateCausalDigestDomain(declaration).success).toBe(true);
      expect(validateCausalDigestDomain({ ...declaration, hash: "sha-1" }).success).toBe(false);
      expect(validateCausalDigestDomain({ ...declaration, output: "lowercase-HEX" }).success).toBe(false);
      expect(validateCausalDigestDomain({ ...declaration, subject_bytes: "wrong-metadata" }).success).toBe(false);
    }
  });

  it("computes canonical declaration bytes that ignore object member order", () => {
    const declaration = declarationByLabel("content/exact-bytes");
    if (!declaration) throw new Error("missing exact-bytes declaration");

    const original = getCanonicalDigestDeclarationBytes(declaration);
    const reordered = getCanonicalDigestDeclarationBytes({
      output: declaration.output,
      subject_bytes: declaration.subject_bytes,
      version: declaration.version,
      hash: declaration.hash,
      label: declaration.label
    } as CausalDigestDomain);

    expect(original).toEqual(reordered);
    expect(Array.from(original)).toEqual(Array.from(reordered));
  });

  it("computes identical declaration bytes from whitespace-varied spellings", () => {
    const declaration = declarationByLabel("causal-event/canonical-json");
    if (!declaration) throw new Error("missing causal-event declaration");

    const dense = `{"version":"${CAUSAL_DIGEST_DOMAIN_VERSION}","label":"causal-event/canonical-json","hash":"sha-256","subject_bytes":"noopolis.canonical-json.v1:utf-8","output":"lowercase-hex"}`;
    const spaced = `  {  \n  "label": "causal-event/canonical-json" ,\n  "version" : "${CAUSAL_DIGEST_DOMAIN_VERSION}" ,\n  "subject_bytes" : "noopolis.canonical-json.v1:utf-8" ,\n  "hash" : "sha-256" ,\n  "output" : "lowercase-hex"\n }  `;

    const byDense = parseCanonicalJson(dense);
    const bySpaced = parseCanonicalJson(spaced);

    expect(areCausalDigestDeclarationsComparable(byDense, bySpaced)).toBe(true);
    expect(getCanonicalDigestDeclarationBytes(declaration)).toEqual(getCanonicalDigestDeclarationBytes(byDense));
    expect(getCanonicalDigestDeclarationBytes(declaration)).toEqual(getCanonicalDigestDeclarationBytes(bySpaced));
  });

  it("treats different declarations as not comparable", () => {
    const canonicalJson = declarationByLabel("causal-event/canonical-json");
    const exactUtf8 = declarationByLabel("content/exact-utf8");
    if (!canonicalJson || !exactUtf8) throw new Error("missing declarations");
    expect(areCausalDigestDeclarationsComparable(canonicalJson, exactUtf8)).toBe(false);
  });
});

describe("digest domain hashing", () => {
  const subjectsByLabel: Record<CausalDigestLabel, unknown> = {
    "causal-event/canonical-json": goldenEvent,
    "content/exact-utf8": "exact UTF-8 subject",
    "content/exact-bytes": new Uint8Array([0x00, 0x01, 0xff, 0x7a])
  };

  const subjectHashHelpers: Array<{
    name: string;
    fn: (domain: CausalDigestDomain, subject: unknown) => unknown;
  }> = [
    { name: "subjectHashBytesFromDigestDomain", fn: subjectHashBytesFromDigestDomain },
    { name: "subjectHashFromDigestDomain", fn: subjectHashFromDigestDomain }
  ];

  it("validates runtime digest declarations for both subject hash exports", () => {
    for (const declaration of SUPPORTED_CAUSAL_DIGEST_DECLARATIONS) {
      const subject = subjectsByLabel[declaration.label];
      for (const helper of subjectHashHelpers) {
        const expectThrow = (candidate: unknown): void => {
          expect(() => helper.fn(candidate as CausalDigestDomain, subject)).toThrow(/invalid digest domain|unsupported digest label|lone surrogate/);
        };

        expectThrow({ ...declaration, subject_bytes: "wrong-subject-bytes" } as unknown as CausalDigestDomain);
        expectThrow({ ...declaration, hash: "sha-1" } as unknown as CausalDigestDomain);
        expectThrow({ ...declaration, output: "base64" } as unknown as CausalDigestDomain);
        expectThrow({ ...declaration, version: "noopolis.causal-digest-domain.v2" } as unknown as CausalDigestDomain);
        expectThrow({ ...declaration, label: "content/unknown" } as unknown as CausalDigestDomain);
        expectThrow({ ...declaration, extra_field: true } as unknown as CausalDigestDomain);
      }
    }
  });

  it("hashes causal events from canonical-json declarations via canonical bytes", () => {
    const declaration = canonicalJsonDomain();
    const eventInputSorted = JSON.stringify(goldenEvent);
    const eventInputShuffled = `{"recorded_at":"${goldenEvent.recorded_at}","type":"${goldenEvent.type}","version":"noopolis.causal-event.v1","run_id":"${goldenEvent.run_id}","event_id":"${goldenEvent.event_id}","payload":{},"principal_id":"${goldenEvent.principal_id}","cause_event_ids":[],"emitter":{"system":"moltnet","stream_id":"network:room-1","seq":4}}`;

    const expected = sha256Hex(canonicalEventBytes());
    const objectInputHash = subjectHashFromDigestDomain(declaration as CausalDigestDomain, goldenEvent);
    const canonicalInputHash = subjectHashFromDigestDomain(declaration as CausalDigestDomain, eventInputSorted);
    const shuffledInputHash = subjectHashFromDigestDomain(declaration as CausalDigestDomain, eventInputShuffled);

    expect(objectInputHash).toBe(expected);
    expect(canonicalInputHash).toBe(expected);
    expect(shuffledInputHash).toBe(expected);
  });

  it("rejects non-object or malformed serialized canonical-json subjects", () => {
    const declaration = canonicalJsonDomain();
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, 12345)).toThrow();
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, "{\"recorded_at\":true}")).toThrow();
  });

  it("hashes exact UTF-8 strings preserving content and null/newline bytes", () => {
    const declaration = exactUtf8Domain();
    const composed = "café\nline-2\u0000©";
    const decomposed = "cafe\u0301\nline-2\u0000©";

    const composedHash = subjectHashFromDigestDomain(declaration as CausalDigestDomain, composed);
    const decomposedHash = subjectHashFromDigestDomain(declaration as CausalDigestDomain, decomposed);
    expect(composedHash).toBe(sha256Hex(new TextEncoder().encode(composed)));
    expect(decomposedHash).toBe(sha256Hex(new TextEncoder().encode(decomposed)));
    expect(composedHash).not.toBe(decomposedHash);
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, "valid text")).not.toThrow();
  });

  it("rejects exact UTF-8 subjects with lone surrogate", () => {
    const declaration = exactUtf8Domain();
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, "a\uD800")).toThrow("lone surrogate");
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, "\uDC00a")).toThrow("lone surrogate");
  });

  it("hashes exact byte subjects without transformation and rejects non-bytes", () => {
    const declaration = exactBytesDomain();
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x0a, 0x61, 0x62]);

    expect(subjectHashFromDigestDomain(declaration as CausalDigestDomain, bytes)).toBe(sha256Hex(bytes));
    expect(subjectHashBytesFromDigestDomain(declaration as CausalDigestDomain, bytes)).toEqual(bytes);
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, bytes.toString())).toThrow("byte sequence");
    expect(() => subjectHashFromDigestDomain(declaration as CausalDigestDomain, [0x00, 0xff, 0x10])).toThrow("byte sequence");
  });

  it("parses valid digest domains through parseCausalDigestDomain", () => {
    const declaration = canonicalJsonDomain();
    expect(parseCausalDigestDomain(declaration as CausalDigestDomain)).toEqual(declaration);
  });
});
