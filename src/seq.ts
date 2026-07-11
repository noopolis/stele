import type { CausalEvent } from "./envelope.js";

/**
 * Builds the (run_id, system:stream_id) grouping key used throughout the
 * ledger for contiguity checks, staleness detection, and reconciliation.
 */
export const streamKey = (runId: string, system: string, streamId: string): string =>
  `${runId}::${system}:${streamId}`;

export interface SeqGap {
  maxSeq: number;
  missing: number[];
  runId: string;
  streamId: string;
  system: string;
}

export interface SeqContiguityResult {
  gaps: SeqGap[];
  maxSeqByStream: Map<string, number>;
}

/**
 * Requires seq contiguity from 1..max within each (run_id, system:stream_id)
 * group. Duplicate seq values in the same stream do not themselves count as
 * a gap here — conflicting occupants of the same slot are a reconciler
 * concern (see reconcile.ts), not a contiguity concern.
 */
export const checkSeqContiguity = (events: CausalEvent[]): SeqContiguityResult => {
  const byStream = new Map<string, { runId: string; seqs: number[]; streamId: string; system: string }>();

  for (const event of events) {
    const key = streamKey(event.run_id, event.emitter.system, event.emitter.stream_id);
    const entry = byStream.get(key) ?? {
      runId: event.run_id,
      seqs: [],
      streamId: event.emitter.stream_id,
      system: event.emitter.system
    };
    entry.seqs.push(event.emitter.seq);
    byStream.set(key, entry);
  }

  const gaps: SeqGap[] = [];
  const maxSeqByStream = new Map<string, number>();

  for (const [key, entry] of byStream) {
    const sorted = [...new Set(entry.seqs)].sort((left, right) => left - right);
    const maxSeq = sorted[sorted.length - 1] ?? 0;
    maxSeqByStream.set(key, maxSeq);

    const present = new Set(sorted);
    const missing: number[] = [];
    for (let candidate = 1; candidate <= maxSeq; candidate += 1) {
      if (!present.has(candidate)) {
        missing.push(candidate);
      }
    }

    if (missing.length > 0) {
      gaps.push({
        maxSeq,
        missing,
        runId: entry.runId,
        streamId: entry.streamId,
        system: entry.system
      });
    }
  }

  return { gaps, maxSeqByStream };
};
