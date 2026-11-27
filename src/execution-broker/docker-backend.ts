import { err, ok, type Result } from 'neverthrow';

import { ExecutionBrokerError } from './errors.js';
import { createDockerDemuxer, demuxDockerStream } from './docker-stream.js';
import type { DockerBackendConfig, DockerEngineClient } from './docker-types.js';
import type {
  BackendCapabilities,
  BackendExecRequest,
  BackendExecSession,
  BackendStreamExecRequest,
  ContainerBackend,
  ContainerSpec,
  RawExecOutput,
} from './types.js';

/** Digest-pinned image reference: `<name>@sha256:<64 lowercase hex>`. Tags are rejected. */
const IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** Non-root `uid:gid`. */
const USER_RE = /^(\d+):(\d+)$/;

/** Absolute path without ':' or whitespace, safe inside a `host:container:mode` bind string. */
const BIND_PATH_RE = /^\/[^:\s]*$/;

/** Container IDs we are willing to interpolate into a URL path segment. */
const CONTAINER_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** Backend-side cap on collected stderr of a streaming exec. */
const STREAM_STDERR_CAP = 65_536;

const FIXED_CMD = ['sleep', 'infinity'];

/** Every broker container carries this label, so a reaper can find it and only it. */
export const BROKER_LABEL = 'talon.broker';
/** The process id of the daemon that created the container. */
export const BROKER_PID_LABEL = 'talon.broker.pid';

function invalidArgument(detail: string): ExecutionBrokerError {
  return new ExecutionBrokerError('INVALID_ARGUMENT', detail);
}

function backendFailure(detail: string): ExecutionBrokerError {
  return new ExecutionBrokerError('BACKEND_FAILURE', detail);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateConfig(config: DockerBackendConfig): Result<void, ExecutionBrokerError> {
  if (!IMAGE_DIGEST_RE.test(config.image)) {
    return err(invalidArgument('worker image must be pinned by sha256 digest'));
  }
  const userMatch = USER_RE.exec(config.user);
  if (!userMatch) {
    return err(invalidArgument('worker user must be a numeric uid:gid pair'));
  }
  if (Number(userMatch[1]) === 0) {
    return err(invalidArgument('worker user must not be root'));
  }
  if (!isPositiveInteger(config.memoryBytes)) {
    return err(invalidArgument('memoryBytes must be a positive integer'));
  }
  if (!isPositiveInteger(config.pidsLimit)) {
    return err(invalidArgument('pidsLimit must be a positive integer'));
  }
  if (!isPositiveInteger(config.nanoCpus)) {
    return err(invalidArgument('nanoCpus must be a positive integer'));
  }
  if (!isPositiveInteger(config.tmpfsSizeBytes)) {
    return err(invalidArgument('tmpfsSizeBytes must be a positive integer'));
  }
  return ok(undefined);
}

/** Container IDs come from callers and from the daemon; never let one shape a path traversal. */
function validateContainerId(containerId: string): Result<void, ExecutionBrokerError> {
  if (!CONTAINER_ID_RE.test(containerId) || containerId === '.' || containerId === '..') {
    return err(invalidArgument('container id is not safe for a URL path'));
  }
  return ok(undefined);
}

/** Defensive JSON parse: any malformed body is a backend failure, never echoed. */
function parseJsonBody(body: Buffer): Result<unknown, ExecutionBrokerError> {
  try {
    return ok(JSON.parse(body.toString('utf8')) as unknown);
  } catch {
    return err(backendFailure('docker engine returned a malformed JSON body'));
  }
}

function asRecord(value: unknown): Result<Record<string, unknown>, ExecutionBrokerError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(backendFailure('docker engine returned an unexpected JSON shape'));
  }
  return ok(value as Record<string, unknown>);
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): Result<string, ExecutionBrokerError> {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    return err(backendFailure(`docker engine response is missing ${field}`));
  }
  return ok(value);
}

/** Creates an exec and returns its validated ID. Shared by `exec` and `execStream`. */
async function createExec(
  client: DockerEngineClient,
  containerId: string,
  request: BackendExecRequest,
  attachStdin: boolean,
): Promise<Result<string, ExecutionBrokerError>> {
  const execCreated = await client.request({
    method: 'POST',
    path: `/containers/${containerId}/exec`,
    body: {
      Cmd: [...request.argv],
      WorkingDir: request.cwd,
      ...(attachStdin ? { AttachStdin: true } : {}),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    },
    signal: request.signal,
  });
  if (execCreated.isErr()) {
    return err(backendFailure('docker exec create request failed'));
  }
  if (execCreated.value.status !== 201) {
    return err(backendFailure('docker exec create was rejected'));
  }

  const parsed = asRecord(parseJsonBody(execCreated.value.body).unwrapOr(null));
  if (parsed.isErr()) {
    return err(parsed.error);
  }
  const idResult = readStringField(parsed.value, 'Id');
  if (idResult.isErr()) {
    return err(idResult.error);
  }
  if (validateContainerId(idResult.value).isErr()) {
    return err(backendFailure('docker engine returned an unusable exec id'));
  }
  return ok(idResult.value);
}

/** Reads the exit code of a finished exec. Shared by `exec` and `execStream`. */
async function readExecExitCode(
  client: DockerEngineClient,
  execId: string,
  signal: AbortSignal,
): Promise<Result<number, ExecutionBrokerError>> {
  const inspected = await client.request({ method: 'GET', path: `/exec/${execId}/json`, signal });
  if (inspected.isErr()) {
    return err(backendFailure('docker exec inspect request failed'));
  }
  if (inspected.value.status !== 200) {
    return err(backendFailure('docker exec inspect was rejected'));
  }

  const inspectRecord = asRecord(parseJsonBody(inspected.value.body).unwrapOr(null));
  if (inspectRecord.isErr()) {
    return err(inspectRecord.error);
  }
  const { ExitCode: exitCode, Running: running } = inspectRecord.value;
  if (running === true) {
    return err(backendFailure('docker exec still running after its stream ended'));
  }
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    return err(backendFailure('docker exec inspect is missing an integer exit code'));
  }
  return ok(exitCode);
}

export function createDockerBackend(
  client: DockerEngineClient,
  config: DockerBackendConfig,
): Result<ContainerBackend, ExecutionBrokerError> {
  const validated = validateConfig(config);
  if (validated.isErr()) {
    return err(validated.error);
  }

  const backend: ContainerBackend = {
    capabilities(): BackendCapabilities {
      return { diskQuotaEnforced: config.diskQuotaEnforced };
    },

    async createContainer(
      spec: ContainerSpec,
    ): Promise<Result<{ containerId: string }, ExecutionBrokerError>> {
      // A ':' or a relative path would let a path string add or change bind options.
      const { hostPath, mountTarget } = spec.workspace;
      if (!BIND_PATH_RE.test(hostPath) || !BIND_PATH_RE.test(mountTarget)) {
        return err(
          invalidArgument('workspace paths must be absolute and must not contain a colon'),
        );
      }

      const body = {
        Image: config.image,
        Cmd: [...FIXED_CMD],
        User: config.user,
        NetworkDisabled: true,
        Labels: { [BROKER_LABEL]: '1', [BROKER_PID_LABEL]: String(process.pid) },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Binds: [
            `${spec.workspace.hostPath}:${spec.workspace.mountTarget}:${spec.workspace.mode}`,
          ],
          Memory: config.memoryBytes,
          PidsLimit: config.pidsLimit,
          NanoCpus: config.nanoCpus,
          Tmpfs: { '/tmp': `rw,noexec,nosuid,size=${config.tmpfsSizeBytes}` },
        },
      };

      const created = await client.request({ method: 'POST', path: '/containers/create', body });
      if (created.isErr()) {
        return err(backendFailure('docker container create request failed'));
      }
      if (created.value.status !== 201) {
        return err(backendFailure('docker container create was rejected'));
      }

      const parsed = asRecord(parseJsonBody(created.value.body).unwrapOr(null));
      if (parsed.isErr()) {
        return err(parsed.error);
      }
      const idResult = readStringField(parsed.value, 'Id');
      if (idResult.isErr()) {
        return err(idResult.error);
      }
      const containerId = idResult.value;
      if (validateContainerId(containerId).isErr()) {
        // The ID came from the daemon, so this is a backend problem, not caller input.
        return err(backendFailure('docker engine returned an unusable container id'));
      }

      const started = await client.request({
        method: 'POST',
        path: `/containers/${containerId}/start`,
      });
      const startFailed = started.isErr() || started.value.status !== 204;
      if (startFailed) {
        // Best-effort cleanup so a half-created container does not linger.
        await client.request({
          method: 'DELETE',
          path: `/containers/${containerId}?force=true&v=true`,
        });
        return err(backendFailure('docker container start was rejected'));
      }

      return ok({ containerId });
    },

    async exec(
      containerId: string,
      request: BackendExecRequest,
    ): Promise<Result<RawExecOutput, ExecutionBrokerError>> {
      const idCheck = validateContainerId(containerId);
      if (idCheck.isErr()) {
        return err(idCheck.error);
      }

      const created = await createExec(client, containerId, request, false);
      if (created.isErr()) {
        return err(created.error);
      }
      const execId = created.value;

      const started = await client.request({
        method: 'POST',
        path: `/exec/${execId}/start`,
        body: { Detach: false, Tty: false },
        signal: request.signal,
      });
      if (started.isErr()) {
        return err(backendFailure('docker exec start request failed'));
      }
      if (started.value.status !== 200) {
        return err(backendFailure('docker exec start was rejected'));
      }

      const demuxed = demuxDockerStream(started.value.body);
      if (demuxed.isErr()) {
        return err(demuxed.error);
      }

      const exitCode = await readExecExitCode(client, execId, request.signal);
      if (exitCode.isErr()) {
        return err(exitCode.error);
      }

      return ok({
        exitCode: exitCode.value,
        stdout: demuxed.value.stdout,
        stderr: demuxed.value.stderr,
      });
    },

    async execStream(
      containerId: string,
      request: BackendStreamExecRequest,
    ): Promise<Result<BackendExecSession, ExecutionBrokerError>> {
      const idCheck = validateContainerId(containerId);
      if (idCheck.isErr()) {
        return err(idCheck.error);
      }

      const created = await createExec(client, containerId, request, true);
      if (created.isErr()) {
        return err(created.error);
      }
      const execId = created.value;

      const opened = await client.openStream({
        method: 'POST',
        path: `/exec/${execId}/start`,
        body: { Detach: false, Tty: false },
        signal: request.signal,
      });
      if (opened.isErr()) {
        return err(backendFailure('docker exec start request failed'));
      }
      const duplex = opened.value;
      const demuxer = createDockerDemuxer();

      let ended = false;
      let closed = false;
      let stdinEnded = false;
      let stderr = '';
      let resolveDone!: (
        result: Result<{ exitCode: number; stderr: string }, ExecutionBrokerError>,
      ) => void;
      const done = new Promise<Result<{ exitCode: number; stderr: string }, ExecutionBrokerError>>(
        (resolve) => {
          resolveDone = resolve;
        },
      );

      const finish = (
        result: Result<{ exitCode: number; stderr: string }, ExecutionBrokerError>,
      ): void => {
        if (ended) {
          return;
        }
        ended = true;
        request.signal.removeEventListener('abort', onAbort);
        resolveDone(result);
      };
      const fail = (error: ExecutionBrokerError): void => {
        if (ended) {
          return;
        }
        finish(err(error));
        duplex.destroy();
      };
      const onAbort = (): void => {
        duplex.destroy();
      };

      const deliver = (frames: { stream: 'stdout' | 'stderr'; text: string }[]): void => {
        for (const frame of frames) {
          if (frame.stream === 'stdout') {
            try {
              request.onStdout(frame.text);
            } catch {
              fail(backendFailure('stdout consumer failed'));
              return;
            }
          } else if (stderr.length < STREAM_STDERR_CAP) {
            stderr += frame.text.slice(0, STREAM_STDERR_CAP - stderr.length);
          }
        }
      };

      const readExitCode = async (): Promise<
        Result<{ exitCode: number; stderr: string }, ExecutionBrokerError>
      > =>
        (await readExecExitCode(client, execId, request.signal)).map((exitCode) => ({
          exitCode,
          stderr,
        }));

      duplex.onData((chunk) => {
        if (ended || closed) {
          return;
        }
        const frames = demuxer.push(chunk);
        if (frames.isErr()) {
          fail(frames.error);
          return;
        }
        deliver(frames.value);
      });

      duplex.onClose((error) => {
        if (ended || closed) {
          return;
        }
        closed = true;
        if (error) {
          finish(err(backendFailure('docker exec stream failed')));
          return;
        }
        const flushed = demuxer.end();
        if (flushed.isErr()) {
          finish(err(flushed.error));
          return;
        }
        deliver(flushed.value);
        void readExitCode().then(finish);
      });

      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      const session: BackendExecSession = {
        writeStdin(text: string): void {
          if (ended || stdinEnded) {
            return;
          }
          duplex.write(Buffer.from(text, 'utf8'));
        },
        endStdin(): void {
          if (ended || stdinEnded) {
            return;
          }
          stdinEnded = true;
          duplex.endInput();
        },
        done,
      };
      return ok(session);
    },

    async removeContainer(containerId: string): Promise<Result<void, ExecutionBrokerError>> {
      const idCheck = validateContainerId(containerId);
      if (idCheck.isErr()) {
        return err(idCheck.error);
      }

      const removed = await client.request({
        method: 'DELETE',
        path: `/containers/${containerId}?force=true&v=true`,
      });
      if (removed.isErr()) {
        return err(backendFailure('docker container remove request failed'));
      }
      // 404 counts as success: cleanup must stay idempotent.
      if (removed.value.status !== 204 && removed.value.status !== 404) {
        return err(backendFailure('docker container remove was rejected'));
      }
      return ok(undefined);
    },
  };

  return ok(backend);
}

/**
 * Force-removes the broker containers that mount `hostPath`: containers that an
 * earlier process left behind. A container is removed only if the daemon lists
 * it with the broker label and a mount of `hostPath`. Returns the number removed.
 */
export async function reapBrokerContainers(
  client: DockerEngineClient,
  hostPath: string,
): Promise<Result<number, ExecutionBrokerError>> {
  if (!BIND_PATH_RE.test(hostPath)) {
    return err(invalidArgument('the host path must be absolute and must not contain a colon'));
  }
  const filters = JSON.stringify({ label: [`${BROKER_LABEL}=1`], volume: [hostPath] });
  const listed = await client.request({
    method: 'GET',
    path: `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
  });
  if (listed.isErr()) return err(backendFailure('docker container list request failed'));
  if (listed.value.status !== 200) return err(backendFailure('docker container list was rejected'));
  const parsed = parseJsonBody(listed.value.body);
  if (parsed.isErr()) return err(parsed.error);
  if (!Array.isArray(parsed.value)) {
    return err(backendFailure('docker engine returned an unexpected JSON shape'));
  }

  let removed = 0;
  let failed = false;
  for (const item of parsed.value as unknown[]) {
    const record = asRecord(item);
    if (record.isErr()) continue;
    const { Id: id, Labels: labels, Mounts: mounts } = record.value;
    // The filters run in the daemon; check again here, so nothing else is ever removed.
    const labelled =
      typeof labels === 'object' &&
      labels !== null &&
      (labels as Record<string, unknown>)[BROKER_LABEL] === '1';
    const mountsRoot =
      Array.isArray(mounts) &&
      mounts.some(
        (mount: unknown) =>
          typeof mount === 'object' &&
          mount !== null &&
          (mount as Record<string, unknown>).Source === hostPath,
      );
    if (typeof id !== 'string' || validateContainerId(id).isErr() || !labelled || !mountsRoot) {
      continue;
    }
    const deleted = await client.request({
      method: 'DELETE',
      path: `/containers/${id}?force=true&v=true`,
    });
    if (deleted.isOk() && (deleted.value.status === 204 || deleted.value.status === 404)) {
      removed++;
    } else {
      failed = true;
    }
  }
  if (failed) return err(backendFailure('docker could not remove every broker container'));
  return ok(removed);
}
