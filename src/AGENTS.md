# Stele Src Guide

```text
src/
├── index.ts                     # Barrel export for package public API
├── envelope.ts                  # Compatibility facade re-exporting contract exports
├── reconcile.ts                 # Pure reconciler + backward cause-chain tracing
├── reconcileGraph.ts            # Iterative graph indexing, SCCs, and state propagation
├── bundleReconcile.ts           # Raw bundle parsing, authoritative finals, and bundle verdict
├── seq.ts                       # Per-(run_id, system:stream_id) contiguity checker
├── AGENTS.md                    # This guide
└── contracts/                   # Contract-level canonical envelope/finality/digest/bundle parsers
    ├── AGENTS.md               # Contracts guide
    ├── CLAUDE.md               # Compatibility guide symlink to AGENTS.md
    ├── canonicalJson.ts         # Canonical JSON parser/stringifier/helpers
    ├── canonicalJson.test.ts
    ├── ids.ts                  # Recognized systems and causal-id helpers
    ├── ids.test.ts
    ├── envelope.ts             # noopolis.causal-event.v1 validation and JSONL parser
    ├── envelope.test.ts
    ├── streamFinal.ts           # noopolis.causal-stream-final.v1 validation
    ├── streamFinal.test.ts
    ├── digestDomain.ts          # noopolis.causal-digest-domain.v1 declaration/hash helpers
    ├── digestDomain.test.ts
    ├── bundle.ts                # Bundle preflight over mixed contract records
    ├── bundle.test.ts
    ├── index.ts                 # Contracts barrel export
    ├── golden.test.ts           # Golden corpus coverage/invariant tests
    └── goldens/
        └── causal-contract.v1.json  # Sole approved corpus manifest
```

Keep this package read/verify-only. Emit-side logic and fixture/conformance
harnesses belong in Spawnfile's `src/ledger/`, not here.

`reconcileCausalBundle` is the sealed raw-wire entry point. It must use only
the contract bundle parsers and parsed stream-final records as final authority;
compatibility `declaredFinalSeq` hints remain confined to `reconcileEvents`.
