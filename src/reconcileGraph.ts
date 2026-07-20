import { canonicalJsonStringify, hashCausalEvent, type CausalEvent, type CausalEventSystem } from "./envelope.js";
import type { CheckedFinalHints, ReconcileResult, ReconciledRecord, ReconciliationState } from "./reconcile.js";
import { checkSeqContiguity, compareUtf16, streamKey, streamSlotKey } from "./seq.js";

type Occurrence = { canonical: string; event: CausalEvent; hash: string };
const rank: Record<ReconciliationState, number> = { complete: 0, stale: 1, partial: 2, unknown: 3, divergent: 4 };
const copy = (event: CausalEvent): CausalEvent => JSON.parse(canonicalJsonStringify(event)) as CausalEvent;
const compareOccurrence = (left: Occurrence, right: Occurrence): number =>
  compareUtf16(left.event.event_id, right.event.event_id) || compareUtf16(left.event.run_id, right.event.run_id) || compareUtf16(left.hash, right.hash) || compareUtf16(left.canonical, right.canonical);
const reasonText: Record<string, string> = {
  "conflicting-event-id": "duplicate event_id has conflicting facts", "cross-run-event-id": "event_id occurs in more than one run",
  "conflicting-stream-slot": "stream sequence slot has conflicting event ids", "conflicting-cross-store-fact": "cross-store message content hash conflicts",
  "self-cause": "event references itself as a cause", cycle: "event is a member of a causal cycle", "cross-run-cause": "cause is present only in another run",
  "missing-cause-unknown": "cause references a system with no events in this run", "missing-cause-partial": "cause event is not ingested in this run",
  "stream-behind-declared-final": "stream is behind its declared final seq", "cause-behind-declared-final": "cause stream is behind its declared final seq",
  "invalid-declared-final-hints": "declared final hints have an invalid compatibility shape",
  "ancestor-divergent": "an ancestor is divergent", "ancestor-unknown": "an ancestor is unknown", "ancestor-partial": "an ancestor is partial", "ancestor-stale": "an ancestor is stale"
};
const reasonRank: Record<string, number> = {
  "invalid-declared-final-hints": 0, "conflicting-event-id": 1, "conflicting-stream-slot": 2, "conflicting-cross-store-fact": 3, "cross-run-cause": 4, "cross-run-event-id": 5, "self-cause": 6, cycle: 7,
  "missing-cause-unknown": 10, "missing-cause-partial": 20, "cause-behind-declared-final": 30, "stream-behind-declared-final": 31,
  "ancestor-divergent": 40, "ancestor-unknown": 41, "ancestor-partial": 42, "ancestor-stale": 43
};
const maxState = (left: ReconciliationState, right: ReconciliationState) => rank[left] >= rank[right] ? left : right;
const localStateFor = (codes: Set<string>): ReconciliationState =>
  codes.has("invalid-declared-final-hints") || ["conflicting-event-id", "cross-run-event-id", "conflicting-stream-slot", "conflicting-cross-store-fact", "self-cause", "cycle", "cross-run-cause"].some((code) => codes.has(code)) ? "divergent" :
    codes.has("missing-cause-unknown") ? "unknown" : codes.has("missing-cause-partial") ? "partial" : codes.size ? "stale" : "complete";

/**
 * Graph reconciliation uses one canonical O(V log V) occurrence/output pass;
 * SCC discovery and propagation are iterative O(V + E), with no traversal sort.
 */
export const reconcileGraph = (events: CausalEvent[], hints: CheckedFinalHints): ReconcileResult => {
  const occurrences = events.map((raw) => ({ canonical: canonicalJsonStringify(raw), event: copy(raw), hash: hashCausalEvent(raw) })); // exactly once per occurrence
  occurrences.sort(compareOccurrence);
  const byId = new Map<string, Occurrence[]>(); const slots = new Map<string, Set<string>>(); const systemsByRun = new Map<string, Set<CausalEventSystem>>();
  for (const occurrence of occurrences) {
    const event = occurrence.event; (byId.get(event.event_id) ?? byId.set(event.event_id, []).get(event.event_id)!).push(occurrence);
    const slot = streamSlotKey(event.run_id, event.emitter.system, event.emitter.stream_id, event.emitter.seq); (slots.get(slot) ?? slots.set(slot, new Set()).get(slot)!).add(event.event_id);
    (systemsByRun.get(event.run_id) ?? systemsByRun.set(event.run_id, new Set()).get(event.run_id)!).add(event.emitter.system);
  }
  const reps = new Map<string, Occurrence>(); const occurrencesByEventId = new Map<string, CausalEvent[]>(); const localCodes = new Map<string, Set<string>>();
  for (const [id, group] of byId) {
    reps.set(id, group[0]!); occurrencesByEventId.set(id, group.map(({ event }) => copy(event)));
    const codes = new Set<string>(); localCodes.set(id, codes);
    if (hints.invalid) codes.add("invalid-declared-final-hints");
    if (new Set(group.map(({ hash }) => hash)).size > 1) codes.add("conflicting-event-id");
    if (new Set(group.map(({ event }) => event.run_id)).size > 1) codes.add("cross-run-event-id");
  }
  for (const ids of slots.values()) if (ids.size > 1) for (const id of ids) localCodes.get(id)!.add("conflicting-stream-slot");
  const contiguity = checkSeqContiguity(occurrences.map(({ event }) => event));
  const gapped = new Set(contiguity.gaps.map((gap) => streamKey(gap.runId, gap.system, gap.streamId)));
  const staleSystemsByRun = new Map<string, Set<string>>();
  for (const [key, finalSeq] of hints.finals) {
    const tuple = JSON.parse(key) as [string, string, string]; const max = contiguity.maxSeqByStream.get(key) ?? 0;
    if (finalSeq > max || (finalSeq === max && gapped.has(key))) (staleSystemsByRun.get(tuple[0]) ?? staleSystemsByRun.set(tuple[0], new Set()).get(tuple[0])!).add(tuple[1]);
  }
  for (const [id, { event }] of reps) {
    const key = streamKey(event.run_id, event.emitter.system, event.emitter.stream_id); const finalSeq = hints.finals.get(key); const max = contiguity.maxSeqByStream.get(key) ?? 0;
    if (finalSeq !== undefined && (finalSeq > max || (finalSeq === max && gapped.has(key)))) localCodes.get(id)!.add("stream-behind-declared-final");
  }
  const moltnet = new Map<string, Set<string>>();
  for (const { event } of reps.values()) if (event.emitter.system === "moltnet" && event.type === "message.accepted") { const { message_id, content_sha256 } = event.payload; if (typeof message_id === "string" && typeof content_sha256 === "string") (moltnet.get(JSON.stringify([event.run_id, message_id])) ?? moltnet.set(JSON.stringify([event.run_id, message_id]), new Set()).get(JSON.stringify([event.run_id, message_id]))!).add(content_sha256); }
  for (const [id, { event }] of reps) if (event.emitter.system === "daimon" && event.type === "turn.input.submitted") { const { input_message_ids, input_content_sha256 } = event.payload; if (Array.isArray(input_message_ids) && typeof input_content_sha256 === "string" && input_message_ids.some((messageId) => typeof messageId === "string" && [...(moltnet.get(JSON.stringify([event.run_id, messageId])) ?? [])].some((value) => value !== input_content_sha256))) localCodes.get(id)!.add("conflicting-cross-store-fact"); }
  const causes = new Map<string, string[]>(); const reverse = new Map<string, string[]>(); for (const id of reps.keys()) reverse.set(id, []);
  for (const [id, { event }] of reps) { const resolved: string[] = []; for (const cause of event.cause_event_ids) { const target = reps.get(cause); if (!target) { const system = cause.split(":", 1)[0] ?? ""; if (staleSystemsByRun.get(event.run_id)?.has(system)) localCodes.get(id)!.add("cause-behind-declared-final"); else if (systemsByRun.get(event.run_id)?.has(system as CausalEventSystem)) localCodes.get(id)!.add("missing-cause-partial"); else localCodes.get(id)!.add("missing-cause-unknown"); } else if (cause === id) localCodes.get(id)!.add("self-cause"); else if (byId.get(cause)!.some(({ event: occurrence }) => occurrence.run_id !== event.run_id) || target.event.run_id !== event.run_id) localCodes.get(id)!.add("cross-run-cause"); else { resolved.push(cause); reverse.get(cause)!.push(id); } } causes.set(id, resolved); }
  const order: string[] = []; const seen = new Set<string>();
  for (const start of reps.keys()) if (!seen.has(start)) { const stack: Array<[string, number]> = [[start, 0]]; seen.add(start); while (stack.length) { const top = stack.at(-1)!; const next = causes.get(top[0])![top[1]]; if (next !== undefined) { top[1] += 1; if (!seen.has(next)) { seen.add(next); stack.push([next, 0]); } } else { order.push(top[0]); stack.pop(); } } }
  const assigned = new Set<string>();
  for (let index = order.length - 1; index >= 0; index -= 1) { const start = order[index]!; if (assigned.has(start)) continue; const component: string[] = []; const stack = [start]; assigned.add(start); while (stack.length) { const id = stack.pop()!; component.push(id); for (const parent of reverse.get(id)!) if (!assigned.has(parent)) { assigned.add(parent); stack.push(parent); } } if (component.length > 1) for (const id of component) localCodes.get(id)!.add("cycle"); }
  const localState = new Map<string, ReconciliationState>(); for (const [id, codes] of localCodes) localState.set(id, localStateFor(codes));
  const state = new Map(localState); const remaining = new Map<string, number>(); const queue: string[] = []; const queued = new Set<string>();
  for (const [id, deps] of causes) { remaining.set(id, deps.length); if (!deps.length || localState.get(id) === "divergent") { queue.push(id); queued.add(id); } }
  for (let index = 0; index < queue.length; index += 1) { const id = queue[index]!; for (const child of reverse.get(id)!) { state.set(child, maxState(state.get(child)!, state.get(id)!)); const count = remaining.get(child)! - 1; remaining.set(child, count); if (!count && !queued.has(child)) { queue.push(child); queued.add(child); } } }
  const byEventId = new Map<string, ReconciledRecord>();
  for (const [id, rep] of reps) { const local = localState.get(id)!; const final = state.get(id)!; const codes = new Set(localCodes.get(id)!); if (final !== local) codes.add(`ancestor-${final}`); const ordered = [...codes].sort((left, right) => (reasonRank[left] ?? 99) - (reasonRank[right] ?? 99) || compareUtf16(left, right)); byEventId.set(id, { event: copy(rep.event), localState: local, reasonCodes: ordered, reasons: ordered.map((code) => reasonText[code]!), state: final }); }
  return { byEventId, occurrencesByEventId };
};
