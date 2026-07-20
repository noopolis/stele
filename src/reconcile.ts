import type { CausalEvent } from "./envelope.js";
import { reconcileGraph } from "./reconcileGraph.js";
import { types } from "node:util";

export interface CheckedFinalHints {
  finals: Map<string, number>;
  invalid: boolean;
}

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

const systems = new Set(["moltnet", "daimon", "mneme", "simfile"]);

/**
 * Reads compatibility hints only through own data descriptors.  `isProxy`
 * rejects proxies before reflection, so getters and proxy `get` traps are
 * never used as part of reconciliation.
 */
export const checkDeclaredFinalHints = (options: unknown): CheckedFinalHints => {
  const empty = (): CheckedFinalHints => ({ finals: new Map(), invalid: false });
  if (options === undefined) return empty();
  try {
    if (options === null || typeof options !== "object" || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) return { finals: new Map(), invalid: true };
    const optionKeys = Reflect.ownKeys(options);
    if (optionKeys.some((key) => key !== "declaredFinalSeq")) return { finals: new Map(), invalid: true };
    const optionDescriptor = Object.getOwnPropertyDescriptor(options, "declaredFinalSeq");
    if (!optionDescriptor) return empty();
    if (!("value" in optionDescriptor) || types.isProxy(optionDescriptor.value)) return { finals: new Map(), invalid: true };
    const hints = optionDescriptor.value;
    if (hints === null || typeof hints !== "object" || Object.getPrototypeOf(hints) !== Object.prototype || Reflect.ownKeys(hints).some((key) => typeof key !== "string")) return { finals: new Map(), invalid: true };
    const finals = new Map<string, number>();
    for (const key of Object.keys(hints)) {
      const descriptor = Object.getOwnPropertyDescriptor(hints, key);
      if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return { finals: new Map(), invalid: true };
      const tuple = JSON.parse(key);
      if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some((item) => typeof item !== "string") || tuple.some((item) => item.length === 0) || !systems.has(tuple[1]) || JSON.stringify(tuple) !== key) return { finals: new Map(), invalid: true };
      finals.set(key, descriptor.value);
    }
    return { finals, invalid: false };
  } catch {
    return { finals: new Map(), invalid: true };
  }
};

/** Pure reconciliation over parsed events; it never mutates or retains caller data. */
export const reconcileEvents = (events: CausalEvent[], options?: ReconcileOptions): ReconcileResult => {
  // Empty input has no indexed records, so compatibility input is irrelevant.
  if (events.length === 0) return { byEventId: new Map(), occurrencesByEventId: new Map() };
  return reconcileGraph(events, checkDeclaredFinalHints(options));
};

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
