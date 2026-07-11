import { createHash } from "node:crypto";

import { z } from "zod";

export const CAUSAL_EVENT_VERSION = "noopolis.causal-event.v1" as const;

/**
 * B62 principal grammar (specs/CAUSAL.md §3), verbatim from
 * `specs/causal-event.v1.schema.json`'s `principal_id.pattern`:
 * `agent:<agentId>` | `operator:<credentialKey|name>` |
 * `system:<system>[.<component>]`. This is the single source of truth for
 * the grammar — `causalEventSchema` enforces it directly on the wire
 * (below), and `principal.ts`'s `parsePrincipal`/`isAuthenticatedPrincipal`
 * import this constant rather than hardcoding a second copy of the pattern.
 */
export const PRINCIPAL_GRAMMAR_SOURCE = "^(agent|operator|system):.+";

const CAUSAL_EVENT_SYSTEMS = ["simfile", "moltnet", "mneme", "daimon"] as const;

export type CausalEventSystem = (typeof CAUSAL_EVENT_SYSTEMS)[number];

export interface CausalEventEmitter {
  system: CausalEventSystem;
  stream_id: string;
  seq: number;
}

export interface CausalEvent<TPayload = Record<string, unknown>> {
  cause_event_ids: string[];
  emitter: CausalEventEmitter;
  event_id: string;
  payload: TPayload;
  principal_id: string;
  recorded_at: string;
  run_id: string;
  type: string;
  version: typeof CAUSAL_EVENT_VERSION;
}

const causalEventEmitterSchema = z
  .object({
    seq: z.number().int().min(1),
    stream_id: z.string().min(1),
    system: z.enum(CAUSAL_EVENT_SYSTEMS)
  })
  .strict();

export const causalEventSchema = z
  .object({
    cause_event_ids: z.array(z.string().min(1)),
    emitter: causalEventEmitterSchema,
    event_id: z.string().regex(/^[^:]+:.+$/, "event_id must be <system>:<local>"),
    payload: z.record(z.string(), z.unknown()),
    principal_id: z.string().regex(new RegExp(PRINCIPAL_GRAMMAR_SOURCE), "principal_id must match <agent|operator|system>:<id> (specs/CAUSAL.md §3)"),
    recorded_at: z.string().min(1),
    run_id: z.string().min(1),
    type: z.string().min(1),
    version: z.literal(CAUSAL_EVENT_VERSION)
  })
  .strict()
  .superRefine((value, context) => {
    if (Number.isNaN(Date.parse(value.recorded_at))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recorded_at must be a valid ISO 8601 timestamp",
        path: ["recorded_at"]
      });
    }

    if (!value.event_id.startsWith(`${value.emitter.system}:`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event_id system prefix must match emitter.system",
        path: ["event_id"]
      });
    }
  });

export const validateCausalEvent = (value: unknown): z.ZodSafeParseResult<CausalEvent> =>
  causalEventSchema.safeParse(value) as z.ZodSafeParseResult<CausalEvent>;

export const parseCausalEvent = (value: unknown): CausalEvent => {
  const result = validateCausalEvent(value);
  if (!result.success) {
    throw new Error(
      `invalid causal event: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return result.data;
};

export interface CausalJsonlParseError {
  line: number;
  message: string;
}

export interface CausalJsonlParseResult {
  errors: CausalJsonlParseError[];
  events: CausalEvent[];
}

/**
 * Parses newline-delimited CausalEvent JSON records. Malformed JSON and
 * schema violations are collected as errors keyed by 1-based line number
 * rather than thrown, so callers (in particular the conformance harness)
 * can report every problem in a fixture instead of stopping at the first.
 */
export const parseCausalJsonl = (jsonl: string): CausalJsonlParseResult => {
  const events: CausalEvent[] = [];
  const errors: CausalJsonlParseError[] = [];

  const lines = jsonl.split("\n");
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0) {
      return;
    }

    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({
        line: lineNumber,
        message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    const result = validateCausalEvent(parsed);
    if (!result.success) {
      errors.push({
        line: lineNumber,
        message: result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")
      });
      return;
    }

    events.push(result.data);
  });

  return { errors, events };
};

/**
 * Deterministically stringifies a value with object keys sorted
 * recursively, so structurally identical records hash the same regardless
 * of key order in the source JSON.
 */
export const canonicalJsonStringify = (value: unknown): string => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }

    if (input !== null && typeof input === "object") {
      const sortedEntries = Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sort(entryValue)] as const);
      return Object.fromEntries(sortedEntries);
    }

    return input;
  };

  return JSON.stringify(sort(value));
};

export const hashCausalEvent = (event: CausalEvent): string =>
  createHash("sha256").update(canonicalJsonStringify(event)).digest("hex");
