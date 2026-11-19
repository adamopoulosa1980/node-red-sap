---
id: FEAT-001
title: node-red-sap keeps a register of its work on tracking-kit
status: done
opened: 2026-11-20
closed: 2026-11-20
witness: .github/workflows/tracking.yml, CI run 44641172083
commits: 1f6ca4c, 9f716eb, 8662c2f
---

## What

node-red-sap gets a register of its work: `tracking.toml`, items under
`tracking/`, and a CI job that fails when the register breaks the
contract. It is set up by following tracking-kit's README, "Add a
project", step by step, as the trial that tracking-kit FEAT-009 asks
for.

## Done when

- `tracking check` ends with `✓` on the machine.
- The workflow `tracking` runs `tracking check --check` green on GitHub.
- The project is on the page, backlog.assert.gr.

## Done

2026-11-20. `tracking check` ends with `✓`; the workflow `tracking` ran
green (run 44641172083, tracking-kit 0.4.1); the page lists the project
and its CI runs.
