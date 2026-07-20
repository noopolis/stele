import type { CausalEvent } from "./envelope.js";

/** Opaque, collision-safe identity for a causal stream. */
export const streamKey = (runId: string, system: string, streamId: string): string =>
  JSON.stringify([runId, system, streamId]);

/** Opaque, collision-safe identity for one stream sequence slot. */
export const streamSlotKey = (runId: string, system: string, streamId: string, seq: number): string =>
  JSON.stringify([runId, system, streamId, seq]);

export interface SeqRange {
  from: number;
  to: number;
}

export interface SeqGap {
  maxSeq: number;
  /** Sorted inclusive missing ranges; this never expands sparse sequence space. */
  missing: SeqRange[];
  runId: string;
  streamId: string;
  system: string;
}

export interface SeqContiguityResult {
  gaps: SeqGap[];
  maxSeqByStream: Map<string, number>;
}

/** Checks contiguity with memory proportional to observed sequence values. */
export const checkSeqContiguity = (events: CausalEvent[]): SeqContiguityResult => {
  const streams = new Map<string, { runId: string; seqs: number[]; streamId: string; system: string }>();
  for (const event of events) {
    const { run_id: runId, emitter } = event;
    const key = streamKey(runId, emitter.system, emitter.stream_id);
    const entry = streams.get(key) ?? { runId, seqs: [], streamId: emitter.stream_id, system: emitter.system };
    entry.seqs.push(emitter.seq);
    streams.set(key, entry);
  }
  const gaps: SeqGap[] = [];
  const maxSeqByStream = new Map<string, number>();
  for (const [key, entry] of [...streams].sort(([left], [right]) => left.localeCompare(right))) {
    const seqs = [...new Set(entry.seqs)].sort((left, right) => left - right);
    const maxSeq = seqs.at(-1) ?? 0;
    maxSeqByStream.set(key, maxSeq);
    const missing: SeqRange[] = [];
    let expected = 1;
    for (const seq of seqs) {
      if (seq > expected) missing.push({ from: expected, to: seq - 1 });
      expected = seq + 1;
    }
    if (missing.length) gaps.push({ maxSeq, missing, runId: entry.runId, streamId: entry.streamId, system: entry.system });
  }
  return { gaps, maxSeqByStream };
};
