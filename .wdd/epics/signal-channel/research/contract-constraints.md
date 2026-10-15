# Signal contract constraints

The reference snapshot pins v0.14.9, not the newer master checkout used during
the initial feasibility survey. Contract rows cite the pinned files actually
opened. The upstream LICENSE is preserved alongside those reference files.

1. **Personal mode requires device provenance.** RPC listDevices omits the local
   marker shown by the standalone CLI. Setup runs that CLI while the bridge is
   stopped and records its current device ID. Runtime validates that ID remains
   present, but does not claim the JSON response can rediscover which device is
   local. Relinking requires refreshing the recorded metadata. Real-device
   evidence remains mandatory before declaring personal mode complete.
2. **Long text can create media implicitly.** The pinned implementation promotes
   text above 2,000 UTF-8 bytes to a long-text attachment. Outbound chunking must
   use bytes rather than JavaScript string length. No inbound long-text
   attachment reconstruction is added.
3. **Send failure can include a response payload.** All-failure errors can carry
   timestamp/results beneath error.data.response. Partial results and secret
   challenge tokens cannot be ignored or copied into model-visible diagnostics.
4. **Subscription wrappers differ.** Manual socket subscriptions wrap receive
   data under params.result with params.subscription. The automatic notification
   and HTTP/SSE examples are not interchangeable with that contract.
5. **Result errors need transactional rollback.** A new Result-returning
   transaction boundary must roll back on an Err, rather than letting an Err
   value commit a transcript with no queue item. This repair applies to new
   ingestion failures; historical duplicate/drop semantics are retained.
6. **Transport completion is not durable acknowledgement.** The existing
   connector callback cannot acknowledge acceptance to the Signal service.
   Pre-acceptance loss remains the spec's explicit boundary. Documentary
   research is complete; real-device behavior remains an implementation gate.

All cited source passages and exact response shapes are in
`shared-context/contract-inventory.md`. No Signal account was linked, queried,
registered or messaged while building this inventory.
