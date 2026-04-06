# Issue 184: requireApproval Enforcement

## Summary

Fix the authorization gap where host tools listed under a persona's `requireApproval` capabilities execute immediately.

## Deliverables

- Keep `requireApproval` tools discoverable to the agent at tool-listing time.
- Block execution of those tools in the host-tools bridge unless they are directly allowed.
- Add unit coverage for policy resolution and bridge rejection behavior.

## Out of Scope

- Building a full runtime approval workflow or in-channel approval UX.
- Fixing any other findings from issue `#184`.
- Changing the capability-merging model outside the execution gate.

## Design

- Leave MCP tool exposure unchanged so the capability model remains visible to the agent.
- Add a three-state policy decision at dispatch time: `allow`, `require_approval`, or `deny`.
- Treat `require_approval` as fail-closed and return an explicit error before handler dispatch.

## Test Plan

- Red: add unit tests that fail because approval-gated tools still dispatch today.
- Green: implement bridge enforcement so approval-gated tools return an error and are not dispatched.
- Regression: verify directly allowed tools still execute and persona capability resolution behavior remains intact.
