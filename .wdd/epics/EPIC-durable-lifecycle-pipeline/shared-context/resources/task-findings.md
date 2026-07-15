---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-task-findings
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: task-findings
updated_at: 2026-07-15
---

# Shared Context Resource: Task Findings

## Purpose

Collect only reconciled discoveries that later tasks, reviewers, or validators
need. Workers should propose concise updates; the controller owns reconciliation.

## Summary

No task findings yet. Epic definition confirmed the current name-based context
special cases and existing repository/queue patterns described in
`architecture.md`.

## Details

- Add findings after evidence is reviewed and merged into the epic branch.
- Include source task/PR, status, affected later tasks, and any changed
  assumption or validation requirement.

## Durable Memory

- None yet.
