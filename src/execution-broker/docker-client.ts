import { request as httpRequest, type ClientRequest, type ClientRequestArgs } from 'node:http';
import { Buffer } from 'node:buffer';
import { err, ok, type Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type { DockerEngineClient, DockerRequest, DockerResponse } from './docker-types.js';

/** Default response cap: 8 MiB. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface DockerEngineClientOptions {
  socketPath: string;
  maxResponseBytes?: number;
}

function backendFailure(detail: string, cause?: Error): ExecutionBrokerError {
  return new ExecutionBrokerError('BACKEND_FAILURE', detail, cause);
}

/**
 * Docker Engine transport over a unix socket. Any HTTP status resolves `ok`;
 * only transport failures (connect error, abort, oversize response) are
 * `BACKEND_FAILURE`. Error detail never carries the socket path or bodies.
 */
export function createDockerEngineClient(options: DockerEngineClientOptions): DockerEngineClient {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    request(request: DockerRequest): Promise<Result<DockerResponse, ExecutionBrokerError>> {
      return new Promise((resolve) => {
        // Settle-once guard: abort, error and completion can race.
        let settled = false;
        let detachAbort: (() => void) | undefined;
        const settle = (result: Result<DockerResponse, ExecutionBrokerError>): void => {
          if (settled) return;
          settled = true;
          detachAbort?.();
          resolve(result);
        };

        if (request.signal?.aborted) {
          // Already aborted: send nothing.
          settle(err(backendFailure('request aborted before send')));
          return;
        }

        const body: Buffer | undefined =
          request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8');

        const args: ClientRequestArgs = {
          socketPath: options.socketPath,
          // Docker ignores the host line on a unix socket; required by node:http.
          path: request.path,
          method: request.method,
          headers:
            body === undefined
              ? { host: 'docker' }
              : { host: 'docker', 'content-type': 'application/json', 'content-length': String(body.length) },
        };

        const req: ClientRequest = httpRequest(args, (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              // Oversize response: tear down the request, do not buffer further.
              req.destroy();
              settle(err(backendFailure('docker response exceeded size limit')));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            settle(ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          });
          res.on('error', (cause: Error) => {
            req.destroy();
            settle(err(backendFailure('docker response stream failed', cause)));
          });
        });

        const onAbort = (): void => {
          req.destroy();
          settle(err(backendFailure('docker request aborted')));
        };

        req.on('error', (cause: Error) => {
          settle(err(backendFailure('docker request failed', cause)));
        });

        if (request.signal) {
          request.signal.addEventListener('abort', onAbort, { once: true });
          detachAbort = (): void => {
            request.signal?.removeEventListener('abort', onAbort);
          };
        }

        if (body === undefined) {
          req.end();
        } else {
          req.end(body);
        }
      });
    },
  };
}
