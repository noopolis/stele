import type { CausalEvent } from "./envelope.js";
import { reconcileGraph } from "./reconcileGraph.js";

export type ReconciliationState = "complete" | "divergent" | "partial" | "stale" | "unknown";

export interface ReconciledRecord {
  event: CausalEvent;
  localState: ReconciliationState;
  /** Stable, machine-readable explanations for local state. */
  reasonCodes: string[];
  /** Compatibility projection of reasonCodes. */
  reasons: string[];
  /** Highest-precedence local or reachable-cause state. */
  state: ReconciliationState;
}

export interface ReconcileOptions {
  /**
   * Compatibility-only final hints, keyed by streamKey(). This does not seal a
   * bundle and must not be used as production final authority.
   */
  declaredFinalSeq?: Record<string, number>;
}

export interface ReconcileResult {
  byEventId: Map<string, ReconciledRecord>;
  /** Canonically ordered, isolated copies of every raw occurrence per id. */
  occurrencesByEventId: Map<string, CausalEvent[]>;
}

export interface CausalEdge { from: string; to: string; }

/** Pure reconciliation over parsed events; it never mutates or retains caller data. */
export const reconcileEvents = (events: CausalEvent[], options: ReconcileOptions = {}): ReconcileResult =>
  reconcileGraph(events, options.declaredFinalSeq ?? {});

/** Iterative depth-first backward tracing, preserving declared cause order. */
export const traceCausesBackward = (result: ReconcileResult | Map<string, CausalEvent>, startEventId: string): CausalEdge[] => {
  const lookup = result instanceof Map ? result : new Map([...result.byEventId].map(([id, record]) => [id, record.event]));
  const edges: CausalEdge[] = [];
  const visited = new Set<string>();
  const stack: Array<{ id: string; next: number }> = [{ id: startEventId, next: -1 }];
  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.next === -1) {
      if (visited.has(frame.id) || !lookup.has(frame.id)) { stack.pop(); continue; }
      visited.add(frame.id);
      frame.next = 0;
    }
    const causes = lookup.get(frame.id)!.cause_event_ids;
    if (frame.next >= causes.length) { stack.pop(); continue; }
    const cause = causes[frame.next++]!;
    edges.push({ from: frame.id, to: cause });
    if (!visited.has(cause) && lookup.has(cause)) stack.push({ id: cause, next: -1 });
  }
  return edges;
};
