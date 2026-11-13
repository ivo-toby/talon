# Actual host-tools bridge ownership

## Confirmed boundary

Controller inspected complete actual source at accepted integration
`2759c369b849c2d6541c59fc954374e218b8f5be`, tree
`9c737e6884d0f93d178b3693037bac404bc2104d`:

- `src/tools/host-tools-bridge.ts:95–124` constructs the actual channel send/list/broadcast handlers from daemon dependencies.
- `:206–221` owns registered run authentication; `:440–503` validates the registered secret and exact run/thread/persona against actual repositories.
- `:594–601` dispatches real authenticated channel calls to those handler instances.
- `src/daemon/agent-runner.ts:66–70,285–290,1272–1274` owns the early background branch and registration/unregistration lifetime. Its existing query-attempt wrapper at `:35–43,739–745,892–895` loses original typed error identity; the approved TASK-010 already owns that correction.
- `src/tools/host-tools/channel-send.ts:60–75` defines the serialized execution context. Model-supplied queue/delivery fields cannot substitute for a live guard issued by the trusted runner.
- `tests/unit/tools/host-tools-bridge.test.ts` already exercises the real socket bridge and registered-authentication boundary (836 lines at this base). It is the existing focused test location, not a new test framework.

A programmatic match of both paths against every applied task conflict-domain
pattern returned no owner. `src/tools/host-tools/**` does not cover its sibling
`src/tools/host-tools-bridge.ts`. TASK-012 explicitly promises injection through
real bootstrap/runner/host-tools and is the integration sink, but omitted this
source/test pair from its enumerated ownership.

## Approved correction

Ivo answered **“Add both paths (recommended)”** to the focused ownership question.
Add only these existing paths to TASK-012:

- `src/tools/host-tools-bridge.ts`
- `tests/unit/tools/host-tools-bridge.test.ts`

Include the existing bridge test file in TASK-012's focused verification command.
Clarify that runtime bridge injection/registered-execution composition belongs to
TASK-012; TASK-010 keeps its existing runner/tool primitives and optional typed
dependency seams. Exact implementation APIs remain subject to actual producer
handoffs and review, not invented here.

No new task, feature, model, concurrency, schema, daemon operation, global cache,
private-handle workaround, model-argument authority or security relaxation is
approved. Other eighteen task definitions/state and active dispatch snapshots,
approved spec/design, config, constitution and historical evidence must remain
unchanged. No source/test implementation was changed by this ownership decision.
