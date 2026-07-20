import {
  parseCausalBundle,
  parseCausalBundleBytes,
  type BundleParseError,
  type CausalDigestDomain,
  type CausalStreamFinal
} from "./contracts/index.js";
import { reconcileGraph } from "./reconcileGraph.js";
import type { ReconcileResult } from "./reconcile.js";
import { checkSeqContiguity, compareUtf16, streamKey, type SeqRange } from "./seq.js";

export type CausalBundleVerdict = "invalid" | "incomplete" | "valid";
export type CausalBundleStreamStatus = "complete" | "partial" | "stale";

export interface CausalBundleDiagnostic {
  code: "duplicate-digest-domain" | "parser-error";
  line?: number;
  message: string;
}

export interface CausalBundleStreamDiagnostic {
  declaredFinalSeq?: number;
  missing: SeqRange[];
  observedMaxSeq: number;
  runId: string;
  status: CausalBundleStreamStatus;
  streamId: string;
  system: string;
}

export interface CausalBundleReconciliation {
  diagnostics: CausalBundleDiagnostic[];
  digestDomains: CausalDigestDomain[];
  graph: ReconcileResult;
  streamFinals: CausalStreamFinal[];
  streams: CausalBundleStreamDiagnostic[];
  verdict: CausalBundleVerdict;
}

const compareStream = (left: CausalBundleStreamDiagnostic, right: CausalBundleStreamDiagnostic): number =>
  compareUtf16(left.runId, right.runId) || compareUtf16(left.system, right.system) || compareUtf16(left.streamId, right.streamId);

const copyRanges = (ranges: SeqRange[]): SeqRange[] => ranges.map(({ from, to }) => ({ from, to }));
const copyFinal = (value: CausalStreamFinal): CausalStreamFinal => ({
  emitter: { ...value.emitter }, final_seq: value.final_seq, run_id: value.run_id, version: value.version
});
const copyDomain = (value: CausalDigestDomain): CausalDigestDomain => ({ ...value });
const parserDiagnostics = (errors: BundleParseError[]): CausalBundleDiagnostic[] =>
  errors.map(({ line, message }) => ({ code: "parser-error", line, message }));

/** Reconciles a raw mixed causal bundle without assigning any product policy. */
export const reconcileCausalBundle = (input: string | Uint8Array): CausalBundleReconciliation => {
  const parsed = typeof input === "string" ? parseCausalBundle(input) : parseCausalBundleBytes(input);
  const diagnostics = parserDiagnostics(parsed.errors);
  const finalByKey = new Map<string, CausalStreamFinal>();
  for (const final of parsed.streamFinals) {
    const key = streamKey(final.run_id, final.emitter.system, final.emitter.stream_id);
    if (!finalByKey.has(key)) finalByKey.set(key, final);
  }
  const domainsByLabel = new Map<string, number>();
  for (const domain of parsed.digestDomains) domainsByLabel.set(domain.label, (domainsByLabel.get(domain.label) ?? 0) + 1);
  for (const [label, count] of [...domainsByLabel].sort(([left], [right]) => compareUtf16(left, right))) {
    if (count > 1) diagnostics.push({ code: "duplicate-digest-domain", message: `duplicate digest-domain declaration for ${label}` });
  }

  const contiguity = checkSeqContiguity(parsed.events);
  const gapsByKey = new Map(contiguity.gaps.map((gap) => [streamKey(gap.runId, gap.system, gap.streamId), gap]));
  const streamKeys = new Set([...contiguity.maxSeqByStream.keys(), ...finalByKey.keys()]);
  const streams: CausalBundleStreamDiagnostic[] = [];
  for (const key of streamKeys) {
    const final = finalByKey.get(key);
    const gap = gapsByKey.get(key);
    const tuple = JSON.parse(key) as [string, string, string];
    const observedMaxSeq = contiguity.maxSeqByStream.get(key) ?? 0;
    const status: CausalBundleStreamStatus = !final ? "partial" :
      final.final_seq > observedMaxSeq || final.final_seq < observedMaxSeq || Boolean(gap) ? "stale" : "complete";
    streams.push({
      ...(final ? { declaredFinalSeq: final.final_seq } : {}),
      missing: copyRanges(gap?.missing ?? []), observedMaxSeq, runId: tuple[0], status, streamId: tuple[2], system: tuple[1]
    });
  }
  streams.sort(compareStream);

  const graph = reconcileGraph(parsed.events, { finals: new Map(), invalid: false }, {
    finals: new Map([...finalByKey].map(([key, value]) => [key, value.final_seq])), requireFinals: true
  });
  const hasDivergence = [...graph.byEventId.values()].some((record) => record.state === "divergent");
  const hasIncompleteGraph = [...graph.byEventId.values()].some((record) => record.state !== "complete");
  const hasIncompleteStream = streams.some((stream) => stream.status !== "complete");
  const verdict: CausalBundleVerdict = diagnostics.length || hasDivergence ? "invalid" :
    hasIncompleteGraph || hasIncompleteStream ? "incomplete" : "valid";
  return {
    diagnostics, digestDomains: parsed.digestDomains.map(copyDomain), graph,
    streamFinals: parsed.streamFinals.map(copyFinal), streams, verdict
  };
};
