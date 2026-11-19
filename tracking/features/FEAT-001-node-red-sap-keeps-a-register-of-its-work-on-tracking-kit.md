---
id: FEAT-001
title: node-red-sap keeps a register of its work on tracking-kit
status: in-progress
priority: P2
opened: 2026-11-20
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
