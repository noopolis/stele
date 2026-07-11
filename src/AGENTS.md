# Stele Src Guide

```text
src/
├── index.ts             # Barrel for package exports
├── envelope.ts           # CausalEvent type + zod validator + parseCausalJsonl + canonical hashing
├── reconcile.ts           # Pure reconciler + backward cause-chain tracer
├── seq.ts                 # Per-(run_id, system:stream_id) contiguity checker
├── envelope.test.ts
├── reconcile.test.ts
├── reconcile.perf.test.ts
└── seq.test.ts
```

Keep this package read/verify-only. Emit-side logic and fixture/conformance
harnesses belong in Spawnfile's `src/ledger/`, not here.
