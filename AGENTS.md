# Stele Working Guide

This repository contains `@noopolis/stele`, the narrow shared contract
package for the `noopolis.causal-event.v1` envelope's READ/VERIFY side.

Both Spawnfile (root) and Simfile reconcile causal chains through this
package so Simfile never needs to import Spawnfile internals to do it
(Decision 20 / contracts.md permits exactly this: a narrow, versioned,
transport-neutral shared contract package). See `specs/CAUSAL.md` in the
Spawnfile repo for the normative envelope semantics this package implements.

This package owns parsing, schema validation, and reconciliation only. It
must stay independent of every product implementation — no Daimon, Mneme,
Moltnet, or Spawnfile imports. `zod` is its only real dependency.

Producer-side emission (`emitters.ts`), the fixtures-only conformance
harness (`conformance.ts`'s `stitchInteractionChain`), and the principal
grammar's per-event conformance checks (`principal.ts`) stay in Spawnfile's
`src/ledger/` — they are producer/product concerns, not shared read
contract.

## Structure

- `src/envelope.ts` — the `CausalEvent` type, the zod schema
  (`causalEventSchema`), `parseCausalJsonl`, `canonicalJsonStringify`,
  `hashCausalEvent`, and the principal grammar source
  (`PRINCIPAL_GRAMMAR_SOURCE`).
- `src/reconcile.ts` — the pure reconciler (`reconcileEvents`) and the
  backward cause-chain tracer (`traceCausesBackward`).
- `src/seq.ts` — per-(run_id, system:stream_id) seq contiguity helpers
  (`streamKey`, `checkSeqContiguity`).
- `src/index.ts` — barrel re-exporting the three modules above.

## Rules

- Read/verify only. No emit-side logic, no fixture/conformance harness, no
  product implementation imports.
- `reconcile.ts` stays a pure function over already-parsed `CausalEvent[]`
  — no I/O.
- The wire JSON is the contract: everything here goes through
  `parseCausalJsonl`/`causalEventSchema` on serialized text/records, never
  assumes in-process objects from another repo.
- Keep files under 400 lines; split further before that limit.
