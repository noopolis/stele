import { parseCausalEvent, type CausalEvent } from "./envelope.js";
import { parseCausalDigestDomain, type CausalDigestDomain } from "./digestDomain.js";
import { CAUSAL_STREAM_FINAL_VERSION, parseCausalStreamFinal, type CausalStreamFinal } from "./streamFinal.js";
import { parseCanonicalJson } from "./canonicalJson.js";

export interface BundleParseError {
  line: number;
  message: string;
}

export interface BundleParseResult {
  digestDomains: CausalDigestDomain[];
  errors: BundleParseError[];
  events: CausalEvent[];
  streamFinals: CausalStreamFinal[];
}

type BundleRecordKind = "causal-event" | "causal-stream-final" | "causal-digest-domain";

type BundleLineRecord = {
  kind: BundleRecordKind;
  value: unknown;
};

const isJsonWhitespace = (character: string) =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

const trimJsonWhitespace = (input: string) => {
  let start = 0;
  while (isJsonWhitespace(input[start] ?? "")) start += 1;
  let end = input.length;
  while (end > start && isJsonWhitespace(input[end - 1])) end -= 1;
  return input.slice(start, end);
};

const classifyRecord = (value: unknown): BundleRecordKind | "invalid" => {
  if (typeof value !== "object" || value === null) return "invalid";
  if (!("version" in value) || typeof value.version !== "string") return "invalid";

  if (value.version === "noopolis.causal-event.v1") return "causal-event";
  if (value.version === CAUSAL_STREAM_FINAL_VERSION) return "causal-stream-final";
  if (value.version === "noopolis.causal-digest-domain.v1") return "causal-digest-domain";
  return "invalid";
};

const parseBundleLine = (line: string, lineNumber: number): BundleLineRecord | BundleParseError | null => {
  const trimmed = trimJsonWhitespace(line);
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(trimmed);
  } catch (error) {
    return {
      line: lineNumber,
      message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const kind = classifyRecord(parsed);
  if (kind === "invalid") {
    return {
      line: lineNumber,
      message: "invalid record: unknown version or malformed record shape"
    };
  }

  return { kind, value: parsed };
};

const parseStreamKey = (runId: string, system: string, streamId: string): string =>
  JSON.stringify([runId, system, streamId]);

const parseStreamSlotKey = (runId: string, system: string, streamId: string, seq: number): string =>
  JSON.stringify([runId, system, streamId, seq]);

const streamPairLabel = (runId: string, system: string, streamId: string): string =>
  `${runId}::${system}:${streamId}`;

const streamSlotLabel = (runId: string, system: string, streamId: string, seq: number): string =>
  `${streamPairLabel(runId, system, streamId)}:${seq}`;

const parseLineEvent = (lineNumber: number, value: unknown): CausalEvent | BundleParseError => {
  try {
    return parseCausalEvent(value);
  } catch (error) {
    return {
      line: lineNumber,
      message: error instanceof Error ? error.message : String(error)
    };
  }
};

const parseLineFinal = (lineNumber: number, value: unknown): CausalStreamFinal | BundleParseError => {
  try {
    return parseCausalStreamFinal(value);
  } catch (error) {
    return {
      line: lineNumber,
      message: error instanceof Error ? error.message : String(error)
    };
  }
};

const parseLineDigestDomain = (
  lineNumber: number,
  value: unknown
): CausalDigestDomain | BundleParseError => {
  try {
    return parseCausalDigestDomain(value);
  } catch (error) {
    return {
      line: lineNumber,
      message: error instanceof Error ? error.message : String(error)
    };
  }
};

const addError = (errors: BundleParseError[], error: BundleParseError) => {
  errors.push(error);
};

export const parseCausalBundle = (jsonl: string): BundleParseResult => {
  const result: BundleParseResult = {
    digestDomains: [],
    errors: [],
    events: [],
    streamFinals: []
  };

  const eventById = new Map<string, CausalEvent>();
  const eventLineById = new Map<string, number>();
  const streamFinalByKey = new Map<string, CausalStreamFinal>();
  const streamFinalLineByKey = new Map<string, number>();
  const seenEventSlots = new Set<string>();

  const lines = jsonl.split("\n");
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const parsedLine = parseBundleLine(line, lineNumber);
    if (parsedLine === null) {
      return;
    }
    if ("kind" in parsedLine) {
      if (parsedLine.kind === "causal-event") {
        const parsed = parseLineEvent(lineNumber, parsedLine.value);
        if ("line" in parsed) {
          addError(result.errors, parsed);
          return;
        }

        if (eventById.has(parsed.event_id)) {
          addError(result.errors, {
            line: lineNumber,
            message: `duplicate event_id: ${parsed.event_id}`
          });
        } else {
          eventById.set(parsed.event_id, parsed);
          eventLineById.set(parsed.event_id, lineNumber);
        }

        const slotWithSeq = parseStreamSlotKey(
          parsed.run_id,
          parsed.emitter.system,
          parsed.emitter.stream_id,
          parsed.emitter.seq
        );
        if (seenEventSlots.has(slotWithSeq)) {
          addError(result.errors, {
            line: lineNumber,
            message: `duplicate event slot: ${streamSlotLabel(
              parsed.run_id,
              parsed.emitter.system,
              parsed.emitter.stream_id,
              parsed.emitter.seq
            )}`
          });
        } else {
          seenEventSlots.add(slotWithSeq);
        }

        result.events.push(parsed);
        return;
      }

      if (parsedLine.kind === "causal-stream-final") {
        const parsed = parseLineFinal(lineNumber, parsedLine.value);
        if ("line" in parsed) {
          addError(result.errors, parsed);
          return;
        }

        const key = parseStreamKey(parsed.run_id, parsed.emitter.system, parsed.emitter.stream_id);
        if (streamFinalByKey.has(key)) {
          addError(result.errors, {
            line: lineNumber,
            message: `duplicate stream final for ${streamPairLabel(parsed.run_id, parsed.emitter.system, parsed.emitter.stream_id)}`
          });
        } else {
          streamFinalByKey.set(key, parsed);
          streamFinalLineByKey.set(key, lineNumber);
        }

        result.streamFinals.push(parsed);
        return;
      }

      const parsed = parseLineDigestDomain(lineNumber, parsedLine.value);
      if ("line" in parsed) {
        addError(result.errors, parsed);
        return;
      }
      result.digestDomains.push(parsed);
      return;
    }

    addError(result.errors, parsedLine);
  });

  const maxSeqByStream = new Map<string, number>();
  for (const event of result.events) {
    const key = parseStreamKey(event.run_id, event.emitter.system, event.emitter.stream_id);
    const previous = maxSeqByStream.get(key) ?? 0;
    maxSeqByStream.set(key, Math.max(previous, event.emitter.seq));
  }

  for (const event of result.events) {
    const line = eventLineById.get(event.event_id) ?? 0;
    for (const causeId of event.cause_event_ids) {
      const cause = eventById.get(causeId);
      if (!cause) {
        continue;
      }
      if (cause.run_id !== event.run_id) {
        addError(result.errors, {
          line,
          message: `cause ${causeId} for event ${event.event_id} belongs to another run`
        });
      }
    }
  }

  for (const streamFinal of result.streamFinals) {
    const key = parseStreamKey(streamFinal.run_id, streamFinal.emitter.system, streamFinal.emitter.stream_id);
    const maxObservedSeq = maxSeqByStream.get(key) ?? 0;
    const finalLine = streamFinalLineByKey.get(key) ?? 0;

    if (streamFinal.final_seq < maxObservedSeq) {
      addError(result.errors, {
        line: finalLine,
        message: `stream final for ${streamPairLabel(
          streamFinal.run_id,
          streamFinal.emitter.system,
          streamFinal.emitter.stream_id
        )} is below observed sequence ${maxObservedSeq}`
      });
    }

    if (streamFinal.final_seq === 0 && maxObservedSeq > 0) {
      addError(result.errors, {
        line: finalLine,
        message: `stream final for ${streamPairLabel(
          streamFinal.run_id,
          streamFinal.emitter.system,
          streamFinal.emitter.stream_id
        )} has final_seq 0 but stream has observed events`
      });
    }
  }

  return result;
};

export const parseCausalBundleBytes = (jsonl: Uint8Array): BundleParseResult => {
  const hasBom = jsonl.length >= 3 && jsonl[0] === 0xef && jsonl[1] === 0xbb && jsonl[2] === 0xbf;
  if (hasBom) {
    return {
      digestDomains: [],
      errors: [{ line: 1, message: "invalid JSON: leading BOM is not allowed" }],
      events: [],
      streamFinals: []
    };
  }

  try {
    return parseCausalBundle(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(jsonl));
  } catch (error) {
    return {
      digestDomains: [],
      errors: [{ line: 1, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
      events: [],
      streamFinals: []
    };
  }
};
