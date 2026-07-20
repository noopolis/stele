import { canonicalJsonStringify, hashCausalEvent, type CausalEvent, type CausalEventSystem } from "./envelope.js";
import type { ReconcileResult, ReconciledRecord, ReconciliationState } from "./reconcile.js";
import { streamKey, streamSlotKey } from "./seq.js";

type Occurrence = { canonical: string; event: CausalEvent; hash: string };
const rank: Record<ReconciliationState, number> = { complete: 0, stale: 1, partial: 2, unknown: 3, divergent: 4 };
const compare = (a: string, b: string) => a.localeCompare(b);
const copy = (event: CausalEvent): CausalEvent => JSON.parse(canonicalJsonStringify(event)) as CausalEvent;
const reasonText: Record<string, string> = {
  "conflicting-event-id": "duplicate event_id has conflicting facts",
  "cross-run-event-id": "event_id occurs in more than one run",
  "conflicting-stream-slot": "stream sequence slot has conflicting event ids",
  "conflicting-cross-store-fact": "cross-store message content hash conflicts",
  "self-cause": "event references itself as a cause",
  cycle: "event is a member of a causal cycle",
  "cross-run-cause": "cause is present only in another run",
  "missing-cause-unknown": "cause references a system with no events in this run",
  "missing-cause-partial": "cause event is not ingested in this run",
  "stream-behind-declared-final": "stream is behind its declared final seq",
  "cause-behind-declared-final": "cause stream is behind its declared final seq"
};
const reasonRank: Record<string, number> = {
  "conflicting-event-id": 0, "conflicting-stream-slot": 1, "conflicting-cross-store-fact": 2,
  "cross-run-cause": 3, "cross-run-event-id": 4, "self-cause": 5, cycle: 6,
  "missing-cause-unknown": 10, "missing-cause-partial": 20,
  "cause-behind-declared-final": 30, "stream-behind-declared-final": 31
};
const maxState = (left: ReconciliationState, right: ReconciliationState) => rank[left] >= rank[right] ? left : right;

/** Graph-only implementation kept separate from the compatibility façade. */
export const reconcileGraph = (events: CausalEvent[], declaredFinalSeq: Record<string, number>): ReconcileResult => {
  const byId = new Map<string, Occurrence[]>();
  const slots = new Map<string, Set<string>>();
  const maxByStream = new Map<string, number>();
  const systemsByRun = new Map<string, Set<CausalEventSystem>>();
  for (const raw of events) {
    const hash = hashCausalEvent(raw); // exactly once per input occurrence
    const canonical = canonicalJsonStringify(raw);
    const occurrence = { canonical, event: copy(raw), hash };
    const group = byId.get(raw.event_id) ?? [];
    group.push(occurrence); byId.set(raw.event_id, group);
    const slot = streamSlotKey(raw.run_id, raw.emitter.system, raw.emitter.stream_id, raw.emitter.seq);
    const occupants = slots.get(slot) ?? new Set<string>(); occupants.add(raw.event_id); slots.set(slot, occupants);
    const key = streamKey(raw.run_id, raw.emitter.system, raw.emitter.stream_id);
    maxByStream.set(key, Math.max(maxByStream.get(key) ?? 0, raw.emitter.seq));
    const systems = systemsByRun.get(raw.run_id) ?? new Set<CausalEventSystem>(); systems.add(raw.emitter.system); systemsByRun.set(raw.run_id, systems);
  }
  const occurrencesByEventId = new Map<string, CausalEvent[]>();
  const reps = new Map<string, Occurrence>();
  const localCodes = new Map<string, Set<string>>();
  for (const id of [...byId.keys()].sort(compare)) {
    const occurrences = byId.get(id)!;
    occurrences.sort((a, b) => compare(`${a.event.run_id}\u0000${a.hash}\u0000${a.canonical}`, `${b.event.run_id}\u0000${b.hash}\u0000${b.canonical}`));
    occurrencesByEventId.set(id, occurrences.map(({ event }) => copy(event)));
    reps.set(id, occurrences[0]!);
    const codes = new Set<string>(); localCodes.set(id, codes);
    if (new Set(occurrences.map(({ hash }) => hash)).size > 1) codes.add("conflicting-event-id");
    if (new Set(occurrences.map(({ event }) => event.run_id)).size > 1) codes.add("cross-run-event-id");
  }
  for (const ids of slots.values()) if (ids.size > 1) for (const id of ids) localCodes.get(id)?.add("conflicting-stream-slot");
  const staleSystemsByRun = new Map<string, Set<string>>();
  for (const [key, finalSeq] of Object.entries(declaredFinalSeq)) {
    const max = maxByStream.get(key) ?? 0;
    if (finalSeq > max) {
      const tuple = JSON.parse(key) as unknown[];
      if (tuple.length === 3 && typeof tuple[0] === "string" && typeof tuple[1] === "string") {
        const set = staleSystemsByRun.get(tuple[0]) ?? new Set<string>(); set.add(tuple[1]); staleSystemsByRun.set(tuple[0], set);
      }
    }
  }
  for (const [id, rep] of reps) {
    const event = rep.event;
    const own = streamKey(event.run_id, event.emitter.system, event.emitter.stream_id);
    if ((declaredFinalSeq[own] ?? 0) > (maxByStream.get(own) ?? 0)) localCodes.get(id)!.add("stream-behind-declared-final");
  }
  const moltnet = new Map<string, Set<string>>();
  for (const { event } of reps.values()) if (event.emitter.system === "moltnet" && event.type === "message.accepted") {
    const { message_id, content_sha256 } = event.payload;
    if (typeof message_id === "string" && typeof content_sha256 === "string") {
      const key = JSON.stringify([event.run_id, message_id]);
      (moltnet.get(key) ?? moltnet.set(key, new Set()).get(key)!).add(content_sha256);
    }
  }
  for (const [id, { event }] of reps) if (event.emitter.system === "daimon" && event.type === "turn.input.submitted") {
    const { input_message_ids, input_content_sha256 } = event.payload;
    if (Array.isArray(input_message_ids) && typeof input_content_sha256 === "string" && input_message_ids.some((messageId) => typeof messageId === "string" && [...(moltnet.get(JSON.stringify([event.run_id, messageId])) ?? [])].some((value) => value !== input_content_sha256))) localCodes.get(id)!.add("conflicting-cross-store-fact");
  }
  const causes = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of reps.keys()) reverse.set(id, []);
  for (const [id, { event }] of reps) {
    const resolved: string[] = [];
    for (const cause of event.cause_event_ids) {
      const target = reps.get(cause);
      if (!target) {
        const system = cause.split(":", 1)[0] ?? "";
        if (staleSystemsByRun.get(event.run_id)?.has(system)) localCodes.get(id)!.add("cause-behind-declared-final");
        else if (systemsByRun.get(event.run_id)?.has(system as CausalEventSystem)) localCodes.get(id)!.add("missing-cause-partial");
        else localCodes.get(id)!.add("missing-cause-unknown");
      } else if (cause === id) localCodes.get(id)!.add("self-cause");
      else if (byId.get(cause)!.some(({ event: occurrence }) => occurrence.run_id !== event.run_id) || target.event.run_id !== event.run_id) localCodes.get(id)!.add("cross-run-cause");
      else { resolved.push(cause); reverse.get(cause)!.push(id); }
    }
    causes.set(id, resolved);
  }
  // Iterative Kosaraju SCC: no call-stack dependence.
  const order: string[] = []; const seen = new Set<string>();
  for (const start of [...reps.keys()].sort(compare)) if (!seen.has(start)) {
    const stack: Array<[string, number]> = [[start, 0]]; seen.add(start);
    while (stack.length) { const top = stack.at(-1)!; const next = causes.get(top[0])![top[1]]; if (next !== undefined) { top[1] += 1; if (!seen.has(next)) { seen.add(next); stack.push([next, 0]); } } else { order.push(top[0]); stack.pop(); } }
  }
  const assigned = new Set<string>();
  for (const start of order.reverse()) if (!assigned.has(start)) {
    const component: string[] = []; const stack = [start]; assigned.add(start);
    while (stack.length) { const id = stack.pop()!; component.push(id); for (const parent of reverse.get(id)!) if (!assigned.has(parent)) { assigned.add(parent); stack.push(parent); } }
    if (component.length > 1) for (const id of component) localCodes.get(id)!.add("cycle");
  }
  const localState = new Map<string, ReconciliationState>();
  for (const [id, codes] of localCodes) localState.set(id, codes.has("conflicting-event-id") || codes.has("cross-run-event-id") || codes.has("conflicting-stream-slot") || codes.has("conflicting-cross-store-fact") || codes.has("self-cause") || codes.has("cycle") || codes.has("cross-run-cause") ? "divergent" : codes.has("missing-cause-unknown") ? "unknown" : codes.has("missing-cause-partial") ? "partial" : codes.size ? "stale" : "complete");
  const state = new Map(localState); const remaining = new Map<string, number>(); const queue: string[] = []; const queued = new Set<string>();
  for (const [id, deps] of causes) { remaining.set(id, deps.length); if (!deps.length || localState.get(id) === "divergent") { queue.push(id); queued.add(id); } }
  queue.sort(compare);
  for (let index = 0; index < queue.length; index += 1) { const id = queue[index]!; for (const child of reverse.get(id)!) { state.set(child, maxState(state.get(child)!, state.get(id)!)); const count = remaining.get(child)! - 1; remaining.set(child, count); if (!count && !queued.has(child)) { queue.push(child); queued.add(child); } } }
  const byEventId = new Map<string, ReconciledRecord>();
  for (const id of [...reps.keys()].sort(compare)) { const codes = [...localCodes.get(id)!].sort((left, right) => reasonRank[left] - reasonRank[right] || compare(left, right)); byEventId.set(id, { event: copy(reps.get(id)!.event), localState: localState.get(id)!, reasonCodes: codes, reasons: codes.map((code) => reasonText[code]!), state: state.get(id)! }); }
  return { byEventId, occurrencesByEventId };
};
