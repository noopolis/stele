# @noopolis/stele

## Reconciliation compatibility notes

`streamKey(runId, system, streamId)` is an opaque JSON tuple encoding.  Do
not parse it by delimiters; callers that persist or compare keys must treat
the complete returned string as the identity.

`checkSeqContiguity().gaps[*].missing` contains sorted inclusive
`{ from, to }` ranges rather than one entry per missing sequence number. This
keeps sparse streams (including `Number.MAX_SAFE_INTEGER`) bounded in memory.

**The shared causal-event schema and reconciler for the Noopolis ecosystem.**

Stele defines the canonical shape of a *causal event*, the rules for parsing and
hashing it, and a deterministic reconciler that turns a stream of events into
causal chains. It is runtime-neutral (no browser or Node globals), depends only
on [`zod`](https://www.npmjs.com/package/zod), and is consumed by tools like
[Simfile](https://github.com/noopolis/simfile) to observe and replay runs.

```bash
npm install @noopolis/stele
```

## What it gives you

- **Envelope** — the `CausalEvent` schema (`causalEventSchema`), plus
  `parseCausalEvent` / `validateCausalEvent`, canonical JSON
  (`canonicalJsonStringify`), stable hashing (`hashCausalEvent`), JSONL parsing
  (`parseCausalJsonl`), the principal grammar, and `CAUSAL_EVENT_VERSION`.
- **Reconcile** — `reconcileEvents` groups events into complete vs incomplete
  causal chains and never invents a missing link; `traceCausesBackward` walks an
  event's causes. Returns `ReconciledRecord[]`, `CausalEdge[]`, and a
  `ReconciliationState`.
- **Seq** — `checkSeqContiguity` and `streamKey` detect gaps in a per-stream
  sequence, surfacing `SeqGap`s instead of silently stitching over them.

## Example

```ts
import { parseCausalJsonl, reconcileEvents } from "@noopolis/stele";

const { events, errors } = parseCausalJsonl(await readFile("ledger.jsonl", "utf8"));
const { records, edges, incomplete } = reconcileEvents(events);

// records: complete causal chains, in causal (not wall-clock) order.
// incomplete: chains with a missing cause — reported, never stitched.
```

## Design

- **Deterministic.** The same events reconcile to the same records and hashes,
  every time.
- **Honest.** A missing causal link is reported as incomplete, not papered over.
- **Neutral.** Pure data + math; no I/O, no environment assumptions.

---

**[github.com/noopolis/stele](https://github.com/noopolis/stele)** · part of the Noopolis ecosystem
