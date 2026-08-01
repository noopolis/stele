export const RECOGNIZED_CAUSAL_SYSTEMS = ["simfile", "moltnet", "mneme", "daimon"] as const;

export type CausalEventSystem = (typeof RECOGNIZED_CAUSAL_SYSTEMS)[number];

export interface CausalEventId {
  local: string;
  system: CausalEventSystem;
}

export interface CausalCauseId {
  local: string;
  namespace: string;
}

export const isRecognizedCausalSystem = (value: string): value is CausalEventSystem =>
  (RECOGNIZED_CAUSAL_SYSTEMS as readonly string[]).includes(value);

export const parseCausalEventId = (value: unknown): CausalEventId => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("causal event id must be a non-empty string");
  }

  const separator = value.indexOf(":");
  if (separator < 0) {
    throw new Error("causal event id must be <system>:<local>");
  }

  const system = value.slice(0, separator);
  const local = value.slice(separator + 1);
  if (local.length === 0) {
    throw new Error("causal event id local suffix must be non-empty");
  }
  if (!isRecognizedCausalSystem(system)) {
    throw new Error(`unrecognized causal system ${system}`);
  }

  return { local, system };
}

/**
 * Parses RECONCILIATION content per B169 D4. Cause namespaces are open, so
 * foreign namespaces are legal. Throwing here must never be wired into a
 * parse-fatal admission path for the carrying event.
 */
export const parseCausalCauseId = (value: unknown): CausalCauseId => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("causal cause id must be a non-empty string");
  }

  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error("causal cause id must be <namespace>:<local>");
  }

  const namespace = value.slice(0, separator);
  const local = value.slice(separator + 1);
  if (local.length === 0) {
    throw new Error("causal cause id local suffix must be non-empty");
  }

  return { local, namespace };
};

export const assertUniqueCauseEventIds = (causeEventIds: readonly string[]): void => {
  const seen = new Set<string>();
  for (const causeEventId of causeEventIds) {
    if (seen.has(causeEventId)) {
      throw new Error(`duplicate cause_event_ids entry: ${causeEventId}`);
    }
    seen.add(causeEventId);
  }
};

export const eventIdMatchesEmitterSystem = (eventId: string, system: CausalEventSystem): boolean => {
  const separator = eventId.indexOf(":");
  if (separator < 0) {
    return false;
  }
  return eventId.slice(0, separator) === system;
};
