import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertUniqueCauseEventIds,
  parseCausalCauseId,
  parseCausalEventId,
  type CausalEventSystem
} from "./ids.js";
import { canonicalJsonBytes, parseCanonicalJson } from "./canonicalJson.js";
import { TextDecoder } from "node:util";

export { canonicalJsonStringify } from "./canonicalJson.js";

export type { CausalEventSystem } from "./ids.js";

export const CAUSAL_EVENT_VERSION = "noopolis.causal-event.v1" as const;

export const PRINCIPAL_GRAMMAR_SOURCE = "^(agent|operator|system):.+";
const DATE_TIME_ZONED_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/;
const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year: number, month: number) => {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
};
const isValidCalendarDate = (year: number, month: number, day: number) => day >= 1 && day <= daysInMonth(year, month);
const isRecordedAt = (value: string) => {
  const match = value.match(DATE_TIME_ZONED_PATTERN);
  if (!match) return false;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!isValidCalendarDate(year, month, day)) return false;
  return true;
};
const isJsonWhitespace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const trimJsonWhitespace = (input: string) => {
  let start = 0;
  while (isJsonWhitespace(input[start] ?? "")) start += 1;
  let end = input.length;
  while (end > start && isJsonWhitespace(input[end - 1])) end -= 1;
  return input.slice(start, end);
};

export interface CausalEventEmitter {
  system: CausalEventSystem;
  seq: number;
  stream_id: string;
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

const causalEventEmitterSchema = z.object({
  seq: z.number().int().min(1).superRefine((value, context) => {
    if (!Number.isSafeInteger(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a safe integer",
        path: ["seq"]
      });
    }
  }),
  stream_id: z.string().min(1),
  system: z.enum(["simfile", "moltnet", "mneme", "daimon"] as const)
});

export const causalEventSchema = z
  .object({
    cause_event_ids: z
      .array(z.string().min(1))
      .superRefine((causes, context) => {
        try {
          for (const cause of causes) {
            parseCausalCauseId(cause);
          }
          assertUniqueCauseEventIds(causes);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
            path: ["cause_event_ids"]
          });
        }
      }),
    emitter: causalEventEmitterSchema.strict(),
    event_id: z.string().min(2),
    payload: z.record(z.string(), z.unknown()),
    principal_id: z.string().regex(new RegExp(PRINCIPAL_GRAMMAR_SOURCE)),
    recorded_at: z.string().refine(isRecordedAt, "recorded_at must be an RFC 3339 compatible timestamp"),
    run_id: z.string().min(1),
    type: z.string().min(1),
    version: z.literal(CAUSAL_EVENT_VERSION)
  })
  .strict()
  .superRefine((value, context) => {
    try {
      parseCausalEventId(value.event_id);
      const eventId = value.event_id;
      if (!eventId.startsWith(`${value.emitter.system}:`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "event_id system prefix must match emitter.system",
          path: ["event_id"]
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
        path: ["event_id"]
      });
    }

    return;
  });

export const validateCausalEvent = (value: unknown): z.ZodSafeParseResult<CausalEvent> =>
  causalEventSchema.safeParse(value) as z.ZodSafeParseResult<CausalEvent>;

export const parseCausalEvent = (value: unknown): CausalEvent => {
  const result = validateCausalEvent(value);
  if (!result.success) {
    throw new Error(
      `invalid causal event: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
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

export const parseCausalJsonl = (jsonl: string): CausalJsonlParseResult => {
  const events: CausalEvent[] = [];
  const errors: CausalJsonlParseError[] = [];

  const lines = jsonl.split("\n");
  lines.forEach((rawLine, index) => {
    const line = trimJsonWhitespace(rawLine);
    if (line.length === 0) {
      return;
    }

    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = parseCanonicalJson(line);
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
        message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      });
      return;
    }
    events.push(result.data);
  });

  return { errors, events };
};

export const parseCausalJsonlBytes = (jsonl: Uint8Array): CausalJsonlParseResult => {
  const hasBom = jsonl.length >= 3 && jsonl[0] === 0xef && jsonl[1] === 0xbb && jsonl[2] === 0xbf;
  try {
    if (hasBom) throw new Error("invalid UTF-8: leading BOM is not allowed");
    return parseCausalJsonl(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(jsonl));
  } catch (error) {
    return {
      events: [],
      errors: [{ line: 1, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
};

export const hashCausalEvent = (event: CausalEvent): string =>
  createHash("sha256").update(canonicalJsonBytes(event)).digest("hex");
