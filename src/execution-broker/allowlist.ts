import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type {
  CreateLeaseInput,
  ExecuteInput,
  OperatorAllowlist,
  ProfileConfig,
  WorkspaceConfig,
} from './types.js';

/** Operator allowlist IDs: lowercase alphanumerics/hyphens, 1..63 chars, no leading hyphen. */
const ALLOWLIST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** taskId/personaId/leaseId are opaque, but the bound keeps logs and keys small. */
const MAX_OPAQUE_ID_CHARS = 256;

const CREATE_LEASE_KEYS = ['taskId', 'parentPersonaId', 'personaId', 'profile', 'workspace'] as const;
const EXECUTE_KEYS = ['leaseId', 'taskId', 'personaId', 'argv', 'cwd', 'timeoutMs'] as const;

/**
 * Request validation and operator grant lookup (pure; no I/O).
 *
 * Constraint: error details may name the failing field but never echo input
 * values (IDs, argv elements).
 */

function invalidArgument(detail: string): Result<never, ExecutionBrokerError> {
  return err(new ExecutionBrokerError('INVALID_ARGUMENT', detail));
}

/** Shared message for the bounded opaque string fields (taskId, personaId, leaseId). */
function boundedStringError(field: string): Result<never, ExecutionBrokerError> {
  return invalidArgument(
    `${field} must be a non-empty string of at most ${MAX_OPAQUE_ID_CHARS} characters`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact key-set match: any extra or missing key is a contract violation. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) {
    return false;
  }
  for (const key of actual) {
    if (!keys.includes(key)) {
      return false;
    }
  }
  return true;
}

/** Non-empty string within the opaque ID bound; undefined on violation. */
function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OPAQUE_ID_CHARS) {
    return undefined;
  }
  return value;
}

/** Parse and copy a create-lease request; exact keys, validated values. */
export function parseCreateLeaseInput(
  input: unknown,
): Result<CreateLeaseInput, ExecutionBrokerError> {
  if (!isPlainObject(input)) {
    return invalidArgument('create-lease input must be a plain object');
  }
  if (!hasExactKeys(input, CREATE_LEASE_KEYS)) {
    return invalidArgument('create-lease input has unexpected or missing fields');
  }
  const taskId = boundedString(input.taskId);
  if (taskId === undefined) {
    return boundedStringError('taskId');
  }
  const parentPersonaId = boundedString(input.parentPersonaId);
  if (parentPersonaId === undefined) {
    return boundedStringError('parentPersonaId');
  }
  const personaId = boundedString(input.personaId);
  if (personaId === undefined) {
    return boundedStringError('personaId');
  }
  const profile = input.profile;
  if (typeof profile !== 'string' || !ALLOWLIST_ID_PATTERN.test(profile)) {
    return invalidArgument('profile must be a lowercase allowlist ID');
  }
  const workspace = input.workspace;
  if (typeof workspace !== 'string' || !ALLOWLIST_ID_PATTERN.test(workspace)) {
    return invalidArgument('workspace must be a lowercase allowlist ID');
  }
  return ok({ taskId, parentPersonaId, personaId, profile, workspace });
}

/**
 * Parse an execute request (shape only). Bounds (argv count/length, cwd
 * policy, timeout vs profile max) are enforced by checkArgvBounds, path
 * validation, and the lifecycle — not here.
 */
export function parseExecuteInput(input: unknown): Result<ExecuteInput, ExecutionBrokerError> {
  if (!isPlainObject(input)) {
    return invalidArgument('execute input must be a plain object');
  }
  if (!hasExactKeys(input, EXECUTE_KEYS)) {
    return invalidArgument('execute input has unexpected or missing fields');
  }
  const leaseId = boundedString(input.leaseId);
  if (leaseId === undefined) {
    return boundedStringError('leaseId');
  }
  const taskId = boundedString(input.taskId);
  if (taskId === undefined) {
    return boundedStringError('taskId');
  }
  const personaId = boundedString(input.personaId);
  if (personaId === undefined) {
    return boundedStringError('personaId');
  }
  const argv = input.argv;
  if (!Array.isArray(argv)) {
    return invalidArgument('argv must be an array of strings');
  }
  const copiedArgv: string[] = [];
  for (const element of argv) {
    if (typeof element !== 'string') {
      return invalidArgument('argv must be an array of strings');
    }
    copiedArgv.push(element);
  }
  const cwd = input.cwd;
  if (typeof cwd !== 'string') {
    return invalidArgument('cwd must be a string');
  }
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return invalidArgument('timeoutMs must be a positive integer');
  }
  return ok({ leaseId, taskId, personaId, argv: copiedArgv, cwd, timeoutMs });
}

/** Enforce the profile argv bounds: 1..maxArgvCount elements, total length <= maxArgvChars. */
export function checkArgvBounds(
  argv: string[],
  profile: ProfileConfig,
): Result<void, ExecutionBrokerError> {
  if (argv.length < 1 || argv.length > profile.maxArgvCount) {
    return invalidArgument('argv element count is outside the profile bounds');
  }
  let totalChars = 0;
  for (const element of argv) {
    totalChars += element.length;
  }
  if (totalChars > profile.maxArgvChars) {
    return invalidArgument('argv total length exceeds the profile bound');
  }
  return ok(undefined);
}

/**
 * Resolve the granted profile and workspace configs for a parsed create-lease
 * input. Order is a constraint: UNKNOWN_PROFILE is checked before
 * UNKNOWN_WORKSPACE.
 */
export function findGrant(
  allowlist: OperatorAllowlist,
  input: CreateLeaseInput,
): Result<{ profile: ProfileConfig; workspace: WorkspaceConfig }, ExecutionBrokerError> {
  const profile = allowlist.profiles.find((candidate) => candidate.id === input.profile);
  if (profile === undefined) {
    return err(
      new ExecutionBrokerError('UNKNOWN_PROFILE', 'profile is not in the operator allowlist'),
    );
  }
  const workspace = allowlist.workspaces.find((candidate) => candidate.id === input.workspace);
  if (workspace === undefined) {
    return err(
      new ExecutionBrokerError('UNKNOWN_WORKSPACE', 'workspace is not in the operator allowlist'),
    );
  }
  const granted = allowlist.grants.some(
    (grant) =>
      grant.parentPersona === input.parentPersonaId &&
      grant.workerPersona === input.personaId &&
      grant.profile === input.profile &&
      grant.workspace === input.workspace,
  );
  if (!granted) {
    return err(
      new ExecutionBrokerError('GRANT_DENIED', 'the grant tuple is not in the operator allowlist'),
    );
  }
  return ok({ profile, workspace });
}
