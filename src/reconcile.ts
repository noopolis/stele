import type { CausalEvent, CausalEventSystem } from "./envelope.js";
import { hashCausalEvent } from "./envelope.js";
import { streamKey } from "./seq.js";

export type ReconciliationState = "complete" | "divergent" | "partial" | "stale" | "unknown";

export interface ReconciledRecord {
  event: CausalEvent;
  reasons: string[];
  state: ReconciliationState;
}

export interface ReconcileOptions {
  /**
   * Declared final seq per (run_id, system:stream_id) stream, keyed by
   * `streamKey(run_id, system, stream_id)`. When a stream's declared final
   * seq exceeds the maximum seq actually ingested, the stream (and any
   * dangling cause that resolves to it) is reported `stale` rather than
   * `partial` or `unknown` — the gap is explained, not merely observed.
   */
  declaredFinalSeq?: Record<string, number>;
}

export interface ReconcileResult {
  byEventId: Map<string, ReconciledRecord>;
  /** Every raw occurrence seen per event_id, in ingestion order. Exposed so callers can inspect divergent duplicates. */
  occurrencesByEventId: Map<string, CausalEvent[]>;
}

export interface CausalEdge {
  from: string;
  to: string;
}

const buildSlotKey = (event: CausalEvent): string =>
  `${streamKey(event.run_id, event.emitter.system, event.emitter.stream_id)}#${event.emitter.seq}`;

/**
 * Pure, single-pass reconciler over parsed CausalEvent[] gathered from N
 * sources. See specs/CAUSAL.md §4-§5 for the state definitions and
 * precedence (divergent > unknown > partial > stale > complete).
 */
export const reconcileEvents = (
  events: CausalEvent[],
  options: ReconcileOptions = {}
): ReconcileResult => {
  const declaredFinalSeq = options.declaredFinalSeq ?? {};

  // 1. Index by event_id; track every raw occurrence to detect divergence.
  const occurrencesByEventId = new Map<string, CausalEvent[]>();
  for (const event of events) {
    const occurrences = occurrencesByEventId.get(event.event_id) ?? [];
    occurrences.push(event);
    occurrencesByEventId.set(event.event_id, occurrences);
  }

  const index = new Map<string, CausalEvent>();
  const divergentEventIds = new Set<string>();
  for (const [eventId, occurrences] of occurrencesByEventId) {
    const hashes = new Set(occurrences.map(hashCausalEvent));
    if (hashes.size > 1) {
      divergentEventIds.add(eventId);
    }
    // First occurrence wins as the canonical record for graph traversal;
    // divergence is still reported via divergentEventIds regardless.
    index.set(eventId, occurrences[0]!);
  }

  // 2a. Same (run_id, system:stream_id, seq) slot occupied by different
  // event_ids is also divergent, even if neither event_id repeats on its own.
  const bySlot = new Map<string, CausalEvent[]>();
  for (const event of events) {
    const key = buildSlotKey(event);
    const occupants = bySlot.get(key) ?? [];
    occupants.push(event);
    bySlot.set(key, occupants);
  }
  for (const occupants of bySlot.values()) {
    const distinctEventIds = new Set(occupants.map((occupant) => occupant.event_id));
    if (distinctEventIds.size > 1) {
      for (const occupant of occupants) {
        divergentEventIds.add(occupant.event_id);
      }
    }
  }

  // 2b. Conflicting fact hashes across stores: moltnet message.accepted
  // content_sha256 vs. daimon turn.input.submitted input_content_sha256 for
  // the same message_id.
  const contentHashByMessageId = new Map<string, string>();
  for (const event of index.values()) {
    if (event.emitter.system === "moltnet" && event.type === "message.accepted") {
      const messageId = event.payload.message_id;
      const contentHash = event.payload.content_sha256;
      if (typeof messageId === "string" && typeof contentHash === "string") {
        contentHashByMessageId.set(messageId, contentHash);
      }
    }
  }
  for (const event of index.values()) {
    if (event.emitter.system !== "daimon" || event.type !== "turn.input.submitted") {
      continue;
    }
    const inputMessageIds = event.payload.input_message_ids;
    const inputContentHash = event.payload.input_content_sha256;
    if (!Array.isArray(inputMessageIds) || typeof inputContentHash !== "string") {
      continue;
    }
    for (const messageId of inputMessageIds) {
      if (typeof messageId !== "string") {
        continue;
      }
      const knownHash = contentHashByMessageId.get(messageId);
      if (knownHash !== undefined && knownHash !== inputContentHash) {
        divergentEventIds.add(event.event_id);
      }
    }
  }

  // Systems we have any ingested telemetry from at all, for the
  // unknown-vs-partial distinction on dangling causes.
  const seenSystems = new Set<CausalEventSystem>(events.map((event) => event.emitter.system));

  const streamMaxSeq = new Map<string, number>();
  for (const event of events) {
    const key = streamKey(event.run_id, event.emitter.system, event.emitter.stream_id);
    streamMaxSeq.set(key, Math.max(streamMaxSeq.get(key) ?? 0, event.emitter.seq));
  }

  const staleStreamKeys = new Set<string>();
  for (const [key, declared] of Object.entries(declaredFinalSeq)) {
    const maxSeq = streamMaxSeq.get(key) ?? 0;
    if (declared > maxSeq) {
      staleStreamKeys.add(key);
    }
  }

  const byEventId = new Map<string, ReconciledRecord>();

  for (const [eventId, event] of index) {
    const reasons: string[] = [];

    let hasUnknownCause = false;
    let hasPartialCause = false;
    let hasStaleCause = false;

    for (const causeId of event.cause_event_ids) {
      if (index.has(causeId)) {
        continue;
      }

      const causeSystem = causeId.split(":")[0] ?? "";
      const resolvesToStaleStream = [...staleStreamKeys].some((key) =>
        key.startsWith(`${event.run_id}::${causeSystem}:`)
      );

      if (resolvesToStaleStream) {
        hasStaleCause = true;
      } else if (!seenSystems.has(causeSystem as CausalEventSystem)) {
        hasUnknownCause = true;
      } else {
        hasPartialCause = true;
      }
    }

    const ownStreamKey = streamKey(event.run_id, event.emitter.system, event.emitter.stream_id);
    const ownStreamIsStale = staleStreamKeys.has(ownStreamKey);

    let state: ReconciliationState;
    if (divergentEventIds.has(eventId)) {
      state = "divergent";
      reasons.push(
        "duplicate event_id, conflicting (run_id, stream_id, seq) slot, or conflicting cross-store fact hash"
      );
    } else if (hasUnknownCause) {
      state = "unknown";
      reasons.push("cause_event_ids references a system with no ingested events");
    } else if (hasPartialCause) {
      state = "partial";
      reasons.push("cause_event_ids references an event not yet ingested");
    } else if (hasStaleCause || ownStreamIsStale) {
      state = "stale";
      reasons.push(
        hasStaleCause
          ? "cause_event_ids references a stream behind its declared final seq"
          : "stream is behind its declared final seq"
      );
    } else {
      state = "complete";
    }

    byEventId.set(eventId, { event, reasons, state });
  }

  return { byEventId, occurrencesByEventId };
};

/**
 * Walks cause_event_ids backward from startEventId only — never
 * recorded_at, never a trace_id — collecting edges in deterministic
 * depth-first order (each event's own cause_event_ids order, recursing
 * before moving to the next sibling cause). Stops at any cause_event_id
 * that cannot be resolved in the index (the edge is still emitted so
 * callers can see the dangling reference).
 */
export const traceCausesBackward = (
  result: ReconcileResult | Map<string, CausalEvent>,
  startEventId: string
): CausalEdge[] => {
  const lookup =
    result instanceof Map
      ? result
      : new Map([...result.byEventId].map(([eventId, record]) => [eventId, record.event]));

  const edges: CausalEdge[] = [];
  const visited = new Set<string>();

  const visit = (eventId: string): void => {
    if (visited.has(eventId)) {
      return;
    }
    visited.add(eventId);

    const event = lookup.get(eventId);
    if (!event) {
      return;
    }

    for (const causeId of event.cause_event_ids) {
      edges.push({ from: eventId, to: causeId });
      visit(causeId);
    }
  };

  visit(startEventId);

  return edges;
};
