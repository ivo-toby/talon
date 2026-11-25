import { request as httpRequest, type ClientRequest, type ClientRequestArgs } from 'node:http';
import { Buffer } from 'node:buffer';
import { err, ok, type Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type { Duplex } from 'node:stream';
import type { DockerDuplex, DockerEngineClient, DockerRequest, DockerResponse } from './docker-types.js';

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
function createDuplex(socket: Duplex, head: Buffer, onSettled: () => void): DockerDuplex {
  let dataListener: ((chunk: Buffer) => void) | undefined;
  const pending: Buffer[] = head.length > 0 ? [head] : [];
  let closed = false;
  let closeError: ExecutionBrokerError | undefined;
  let closeDelivered = false;
  let closeListener: ((error?: ExecutionBrokerError) => void) | undefined;

  const deliverClose = (): void => {
    if (!closed || closeDelivered || closeListener === undefined) return;
    closeDelivered = true;
    closeListener(closeError);
  };
  const markClosed = (error?: ExecutionBrokerError): void => {
    if (closed) return;
    closed = true;
    closeError = error;
    onSettled();
    deliverClose();
  };

  socket.on('data', (chunk: Buffer) => {
    if (dataListener) dataListener(chunk);
    else pending.push(chunk);
  });
  socket.on('error', (cause: Error) => {
    markClosed(backendFailure('docker stream failed', cause));
  });
  socket.on('close', () => {
    markClosed();
  });

  return {
    write(chunk: Buffer): void {
      if (!closed && socket.writable) socket.write(chunk);
    },
    endInput(): void {
      if (!closed && socket.writable) socket.end();
    },
    onData(listener: (chunk: Buffer) => void): void {
      dataListener = listener;
      for (const chunk of pending.splice(0)) listener(chunk);
    },
    onClose(listener: (error?: ExecutionBrokerError) => void): void {
      closeListener = listener;
      deliverClose();
    },
    destroy(): void {
      socket.destroy();
    },
  };
}

export function createDockerEngineClient(options: DockerEngineClientOptions): DockerEngineClient {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    openStream(request: DockerRequest): Promise<Result<DockerDuplex, ExecutionBrokerError>> {
      return new Promise((resolve) => {
        let settled = false;
        let socketRef: Duplex | undefined;
        const settle = (result: Result<DockerDuplex, ExecutionBrokerError>): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        if (request.signal?.aborted) {
          settle(err(backendFailure('stream aborted before send')));
          return;
        }

        const body: Buffer | undefined =
          request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8');

        const req: ClientRequest = httpRequest({
          socketPath: options.socketPath,
          path: request.path,
          method: request.method,
          headers: {
            host: 'docker',
            connection: 'Upgrade',
            upgrade: 'tcp',
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': String(body.length) }),
          },
        });

        const onAbort = (): void => {
          const aborted = backendFailure('docker stream aborted');
          if (socketRef) socketRef.destroy(aborted);
          else req.destroy();
          settle(err(aborted));
        };
        const detachAbort = (): void => {
          request.signal?.removeEventListener('abort', onAbort);
        };

        req.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
          socketRef = socket;
          // Abort stays attached for the life of the stream; detached on close.
          settle(ok(createDuplex(socket, head, detachAbort)));
        });
        req.on('response', (res) => {
          // Not upgraded: the status is never a stream.
          res.resume();
          req.destroy();
          detachAbort();
          settle(err(backendFailure(`docker did not upgrade the connection (status ${res.statusCode ?? 0})`)));
        });
        req.on('error', (cause: Error) => {
          detachAbort();
          settle(err(backendFailure('docker stream request failed', cause)));
        });

        if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });

        if (body === undefined) req.end();
        else req.end(body);
      });
    },
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
