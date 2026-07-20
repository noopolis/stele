import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJsonBytes, parseCanonicalJson } from "./canonicalJson.js";
import { parseCausalEvent } from "./envelope.js";

export const CAUSAL_DIGEST_DOMAIN_VERSION = "noopolis.causal-digest-domain.v1" as const;

const encoder = new TextEncoder();

export const SUPPORTED_CAUSAL_DIGEST_DECLARATIONS = [
  {
    hash: "sha-256",
    label: "causal-event/canonical-json",
    output: "lowercase-hex",
    subject_bytes: "noopolis.canonical-json.v1:utf-8",
    version: CAUSAL_DIGEST_DOMAIN_VERSION
  },
  {
    hash: "sha-256",
    label: "content/exact-utf8",
    output: "lowercase-hex",
    subject_bytes: "exact-utf8",
    version: CAUSAL_DIGEST_DOMAIN_VERSION
  },
  {
    hash: "sha-256",
    label: "content/exact-bytes",
    output: "lowercase-hex",
    subject_bytes: "exact-bytes",
    version: CAUSAL_DIGEST_DOMAIN_VERSION
  }
] as const;

export type CausalDigestLabel = (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number]["label"];
export type CausalDigestTupleHash = (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number]["hash"];
export type CausalDigestTupleOutput = (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number]["output"];
export type CausalDigestSubjectBytesType = (typeof SUPPORTED_CAUSAL_DIGEST_DECLARATIONS)[number]["subject_bytes"];

const CAUSAL_DIGEST_LABELS = SUPPORTED_CAUSAL_DIGEST_DECLARATIONS.map((entry) => entry.label) as [
  "causal-event/canonical-json",
  "content/exact-utf8",
  "content/exact-bytes"
];

export const RECOGNIZED_DIGEST_LABELS = CAUSAL_DIGEST_LABELS;

export interface CausalDigestDomain {
  version: typeof CAUSAL_DIGEST_DOMAIN_VERSION;
  label: CausalDigestLabel;
  hash: CausalDigestTupleHash;
  subject_bytes: CausalDigestSubjectBytesType;
  output: CausalDigestTupleOutput;
}

const canonicalEventDigestDeclarationSchema = z
  .object({
    hash: z.literal("sha-256"),
    label: z.literal("causal-event/canonical-json"),
    output: z.literal("lowercase-hex"),
    subject_bytes: z.literal("noopolis.canonical-json.v1:utf-8"),
    version: z.literal(CAUSAL_DIGEST_DOMAIN_VERSION)
  })
  .strict();

const exactUtf8DigestDeclarationSchema = z
  .object({
    hash: z.literal("sha-256"),
    label: z.literal("content/exact-utf8"),
    output: z.literal("lowercase-hex"),
    subject_bytes: z.literal("exact-utf8"),
    version: z.literal(CAUSAL_DIGEST_DOMAIN_VERSION)
  })
  .strict();

const exactBytesDigestDeclarationSchema = z
  .object({
    hash: z.literal("sha-256"),
    label: z.literal("content/exact-bytes"),
    output: z.literal("lowercase-hex"),
    subject_bytes: z.literal("exact-bytes"),
    version: z.literal(CAUSAL_DIGEST_DOMAIN_VERSION)
  })
  .strict();

const causalDigestDomainSchema = z.discriminatedUnion("label", [
  canonicalEventDigestDeclarationSchema,
  exactUtf8DigestDeclarationSchema,
  exactBytesDigestDeclarationSchema
]);

const hashSha256 = (input: Uint8Array): string => createHash("sha256").update(input).digest("hex");

const validateUtf16String = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("subject text contains a lone surrogate");
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("subject text contains a lone surrogate");
    }
  }
};

const canonicalBytesFromDomain = (domain: CausalDigestDomain): Uint8Array =>
  canonicalJsonBytes({
    hash: domain.hash,
    label: domain.label,
    output: domain.output,
    subject_bytes: domain.subject_bytes,
    version: domain.version
  });

const areCanonicalBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

export const getCanonicalDigestDeclarationBytes = (value: unknown): Uint8Array => {
  const result = validateCausalDigestDomain(value);
  if (!result.success) {
    throw new Error(
      `invalid digest domain: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return canonicalBytesFromDomain(result.data);
};

export const areCausalDigestDeclarationsComparable = (left: unknown, right: unknown): boolean => {
  try {
    const leftBytes = getCanonicalDigestDeclarationBytes(left);
    const rightBytes = getCanonicalDigestDeclarationBytes(right);
    return areCanonicalBytesEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
};

export const validateCausalDigestDomain = (value: unknown): z.ZodSafeParseResult<CausalDigestDomain> =>
  causalDigestDomainSchema.safeParse(value) as z.ZodSafeParseResult<CausalDigestDomain>;

export const parseCausalDigestDomain = (value: unknown): CausalDigestDomain => {
  const result = validateCausalDigestDomain(value);
  if (!result.success) {
    throw new Error(
      `invalid digest domain: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  return result.data;
};

const subjectBytesForCanonicalJson = (subject: unknown): Uint8Array => {
  if (typeof subject === "string") {
    return canonicalJsonBytes(parseCausalEvent(parseCanonicalJson(subject)));
  }
  return canonicalJsonBytes(parseCausalEvent(subject));
};

const subjectBytesForExactUtf8 = (subject: unknown): Uint8Array => {
  if (typeof subject !== "string") {
    throw new Error("subject must be a UTF-8 string");
  }
  validateUtf16String(subject);
  return encoder.encode(subject);
};

const subjectBytesForExactBytes = (subject: unknown): Uint8Array => {
  if (!(subject instanceof Uint8Array)) {
    throw new Error("subject must be a byte sequence");
  }
  return subject;
};

const subjectBytesForDigestDomain = (domain: CausalDigestDomain, subject: unknown): Uint8Array => {
  const parsedDomain = parseCausalDigestDomain(domain);
  if (parsedDomain.label === "causal-event/canonical-json") {
    return subjectBytesForCanonicalJson(subject);
  }
  if (parsedDomain.label === "content/exact-utf8") {
    return subjectBytesForExactUtf8(subject);
  }
  if (parsedDomain.label === "content/exact-bytes") {
    return subjectBytesForExactBytes(subject);
  }
  throw new Error(`unsupported digest label ${parsedDomain.label}`);
};

export const subjectHashBytesFromDigestDomain = (domain: CausalDigestDomain, subject: unknown): Uint8Array => {
  return subjectBytesForDigestDomain(domain, subject);
};

export const subjectHashFromDigestDomain = (domain: CausalDigestDomain, subject: unknown): string => {
  return hashSha256(subjectBytesForDigestDomain(domain, subject));
};

export type CausalDigestComparison =
  | { digest: string; matches: true }
  | { matches: false; reason: "digest-mismatch" | "invalid-domain" | "invalid-expected-hash" | "invalid-subject" };

/** Pure, fail-closed comparison in one recognized digest domain. */
export const compareCausalDigest = (domain: unknown, subject: unknown, expectedSha256: unknown): CausalDigestComparison => {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return { matches: false, reason: "invalid-expected-hash" };
  }
  let parsed: CausalDigestDomain;
  try {
    parsed = parseCausalDigestDomain(domain);
  } catch {
    return { matches: false, reason: "invalid-domain" };
  }
  try {
    const digest = subjectHashFromDigestDomain(parsed, subject);
    return digest === expectedSha256 ? { digest, matches: true } : { matches: false, reason: "digest-mismatch" };
  } catch {
    return { matches: false, reason: "invalid-subject" };
  }
};
