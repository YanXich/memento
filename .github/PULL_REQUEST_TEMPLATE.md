## What

Summary of the change, one or two sentences.

Closes #<!-- issue number -->

## Why

The problem this solves. Link the issue; describe the failure mode.

## How

- [ ] `npm run check` green (typecheck + tests)
- [ ] Tests added / updated — describe which behavior they prove
- [ ] Session log + workbench UI updated together, if agent behavior changed
- [ ] Docs touched (`README.md` / `README.zh-CN.md` / `docs/`), if the CLI
      surface or config schema changed
- [ ] Security review: fail-safe defaults preserved; no new runtime deps
      without justification

## Screenshots

If this touches `src/web/` or terminal UI, attach before/after captures.

## Checklist for reviewers

- [ ] Mutating paths go through approval and write-serialization
- [ ] Deterministic code paths still never call a model
- [ ] New tool abuse cases are covered by the guard classifier
