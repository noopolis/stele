import { z } from "zod";

import type { CausalEventSystem } from "./ids.js";

export const CAUSAL_STREAM_FINAL_VERSION = "noopolis.causal-stream-final.v1" as const;

const streamFinalSchema = z
  .object({
    final_seq: z
      .number()
      .int()
      .min(0)
      .superRefine((value, context) => {
        if (!Number.isSafeInteger(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "must be a safe integer",
            path: ["final_seq"]
          });
        }
    }),
    emitter: z
      .object({
        stream_id: z.string().min(1),
        system: z.enum(["simfile", "moltnet", "mneme", "daimon"] as const)
      })
      .strict(),
    run_id: z.string().min(1),
    version: z.literal(CAUSAL_STREAM_FINAL_VERSION)
  })
  .strict()
  .transform((value) => ({
    ...value,
    emitter: {
      system: value.emitter.system,
      stream_id: value.emitter.stream_id
    }
  }));

export interface CausalStreamFinal {
  version: typeof CAUSAL_STREAM_FINAL_VERSION;
  run_id: string;
  emitter: {
    system: CausalEventSystem;
    stream_id: string;
  };
  final_seq: number;
}

export type CausalStreamFinalSafeParseResult = z.ZodSafeParseResult<CausalStreamFinal>;

export const validateCausalStreamFinal = (value: unknown): CausalStreamFinalSafeParseResult =>
  streamFinalSchema.safeParse(value) as CausalStreamFinalSafeParseResult;

export const parseCausalStreamFinal = (value: unknown): CausalStreamFinal => {
  const result = validateCausalStreamFinal(value);
  if (!result.success) {
    throw new Error(
      `invalid stream final: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  return result.data;
};
