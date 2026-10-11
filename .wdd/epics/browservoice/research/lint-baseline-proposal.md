# Proposed browservoice verification exception

Status: awaiting Ivo's explicit approval; not active.

For SCOPE-browservoice only, a failing full-repository lint run may be treated as
nonblocking when the task base and head produce exactly the same diagnostics
under the same dependencies and Node version. Any added or changed diagnostic
blocks integration. Changed source files must pass scoped lint, and typecheck,
targeted tests and build must pass. Record the full lint failure and baseline
comparison explicitly; never report full lint as passed. Do not repair unrelated
lint defects. This exception does not waive code review, live feasibility,
acceptance criteria or final integration verification.

Evidence: TASK-01 base abab3f2 and head e4f2080 were linted separately with the
same installed dependencies under Node 24.15.0. Both produced exactly 96
diagnostics in the same 20 files: 75 errors and 21 warnings. File-relative
diagnostic objects were identical. The voice type file was clean.
