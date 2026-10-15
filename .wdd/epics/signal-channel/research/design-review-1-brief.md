# Signal design adversarial review brief

Reviewer: Claude, requested externally by Ivo. Exact model and selected profile
have not yet been supplied. Authoring model: unknown — treat as the current
Codex controller model. No review outcome is implied by this brief.

Review the full design in `research/design-review-1-input.md`; it is an unchanged
snapshot of `design.md`. Compare it with the approved `spec.md`,
`shared-context/contract-inventory.md`, and `research/contract-constraints.md`.
The inventory defines its source-root shorthand and pins actual bridge source.
Use those references to challenge assumptions without treating source-derived
fixtures as live Signal behavior. Review every component, interface,
integration surface and deliverable, including unchanged sections.

## Reviewer charter

- Your job is to **break this document**, not improve it. Suggestions
  are out of scope; failures are the deliverable.
- Every finding carries a **concrete failure scenario**: the inputs,
  state, or sequence under which the text produces the wrong outcome.
- Findings are **P1** (implementing as written produces a defect, or it
  cannot be implemented as written) or **P2** (a reader can reasonably
  build the wrong thing; underspecified boundary; untestable
  criterion). No style notes, no praise.
- If you cannot break a section, say what you tried. An empty report
  with no attack log is a non-review.

## Profile checklists

General: ambiguity; acceptance-criterion testability; ordering, idempotency,
concurrency and encoding assumptions; bounded sends/retries/loops; state-table
coverage; on-disk contract citations; failure-path parity.

Security: authentication/authorization per operation; injection into JSON,
paths, commands and prompts; secrets in logs/errors/evidence; account and thread
isolation; bounded parsing and input buffers; dependency/version boundaries.

Apply the profile Ivo selects. Return original numbered findings with severity,
document/source anchors, and concrete failure scenarios, plus an attack log of
sections tested. Do not edit implementation or approve the design. Findings
will be preserved verbatim; coordinator dispositions will be recorded separately.

## Round outcome received

On 2026-10-14 Ivo supplied Claude Opus 5.5's (claude-opus-5-5) full
general+security report. Round 1 reviewed the frozen input above, not subsequent
revisions. Original findings and coordinator dispositions are in
research/spec-review-1.md. Codex has revised the active design; independent
confirmation and human convergence/sign-off are pending.
