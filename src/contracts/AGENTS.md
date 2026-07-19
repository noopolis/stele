# Contracts Guide

```text
src/contracts/
├── AGENTS.md         # This guide
├── CLAUDE.md         # Compatibility guide symlink to AGENTS.md
├── canonicalJson.ts
├── canonicalJson.test.ts
├── ids.ts
├── ids.test.ts
├── envelope.ts
├── envelope.test.ts
├── streamFinal.ts
├── streamFinal.test.ts
├── digestDomain.ts
├── digestDomain.test.ts
├── bundle.ts
├── bundle.test.ts
├── golden.test.ts
├── index.ts
└── goldens/
    └── causal-contract.v1.json
```

This folder owns the cross-project contract surfaces:
- `noopolis.causal-event.v1`
- `noopolis.causal-stream-final.v1`
- `noopolis.causal-digest-domain.v1`
- shared bundle preflight
- canonical JSON utilities

Rules for all files in this folder:
- Keep every source and test file under 400 lines.
- Use named exports only.
- Keep behavior deterministic and transport-neutral.
- Preserve strict schema and parsing rules from previous implementation steps.
- Keep public names non-conflicting at the folder barrel level.

`src/contracts/CLAUDE.md` is a required exact symlink to this file and must
remain the canonical local compatibility pointer.
