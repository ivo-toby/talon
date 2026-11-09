import type { Result } from 'neverthrow';
import type { ExecutionBrokerError } from './errors.js';

/** One Docker Engine API call. `path` includes the query string, e.g. `/containers/abc?force=true`. */
export interface DockerRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** JSON-serialized by the client; absent means no request body. */
  body?: unknown;
  signal?: AbortSignal;
}

export interface DockerResponse {
  status: number;
  body: Buffer;
}

/**
 * Transport seam: the only place that talks to the Docker daemon. Transport
 * failures (connect error, abort, oversize response) are returned as
 * `BACKEND_FAILURE`; any HTTP status is returned as `ok` for the caller to judge.
 */
export interface DockerEngineClient {
  request(request: DockerRequest): Promise<Result<DockerResponse, ExecutionBrokerError>>;
}

/** Operator-owned worker container posture. The model never supplies any of this. */
export interface DockerBackendConfig {
  /** Must be digest-pinned: `<name>@sha256:<64 hex>`. A tag is rejected. */
  image: string;
  /** Non-root `uid:gid`, e.g. `10001:10001`. */
  user: string;
  memoryBytes: number;
  pidsLimit: number;
  nanoCpus: number;
  /** Size bound of the `/tmp` tmpfs. */
  tmpfsSizeBytes: number;
  /** Reported by `capabilities()`; true only when the operator has a real quota mechanism. */
  diskQuotaEnforced: boolean;
}

export interface DemuxedOutput {
  stdout: string;
  stderr: string;
}
