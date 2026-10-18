// Refusal-only fallback behind explicit unit-test mocks; never import the real SDK here.
function denySdkAccess(): never {
  throw new Error('Claude Agent SDK is disabled in unit tests; provide an explicit mock.');
}

export { denySdkAccess as query, denySdkAccess as createSdkMcpServer, denySdkAccess as tool };
