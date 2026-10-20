/**
 * Environment allowlisting for the openai-compatible wrapper and its
 * workspace sandbox.
 *
 * The daemon's environment holds provider API keys, channel tokens and other
 * secrets. Neither the wrapper process nor the model-driven shell sandbox may
 * inherit it wholesale: anything in the wrapper's env is readable through
 * workspace tools (`env`, `/proc/self/environ`). Only the variables below, plus
 * names the operator explicitly lists in `options.envPassthrough`, are passed.
 *
 * Standalone module — imported by both the daemon-side provider and the
 * wrapper subprocess entrypoint, so it must not import from src/core.
 */

/** Variables a shell or Node process needs to behave normally. No secrets. */
export const SANDBOX_BASE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
];

/**
 * Additional variables the wrapper needs to reach the model endpoint (TLS
 * trust and outbound proxy). Not forwarded into the sandbox, since proxy URLs
 * can carry credentials.
 */
export const WRAPPER_EXTRA_ENV_KEYS: readonly string[] = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Env var the provider uses to tell the wrapper which extra names to forward to the sandbox. */
export const ENV_PASSTHROUGH_VAR = 'TALOND_SANDBOX_ENV_PASSTHROUGH';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalises an operator-supplied passthrough list, dropping invalid names. */
export function normalizeEnvPassthrough(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && ENV_NAME_PATTERN.test(entry.trim())) {
      names.add(entry.trim());
    }
  }
  return [...names];
}

/** Copies only the listed keys that are set in `source`. */
export function pickEnv(source: NodeJS.ProcessEnv, keys: Iterable<string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Environment for the wrapper subprocess, spawned by the daemon. */
export function buildWrapperEnv(
  source: NodeJS.ProcessEnv,
  passthrough: readonly string[],
): Record<string, string> {
  const env = pickEnv(source, [
    ...SANDBOX_BASE_ENV_KEYS,
    ...WRAPPER_EXTRA_ENV_KEYS,
    ...passthrough,
  ]);
  if (passthrough.length > 0) {
    env[ENV_PASSTHROUGH_VAR] = passthrough.join(',');
  }
  return env;
}

/** Environment for the model-driven workspace shell, built inside the wrapper. */
export function buildSandboxEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const passthrough = normalizeEnvPassthrough((source[ENV_PASSTHROUGH_VAR] ?? '').split(','));
  return pickEnv(source, [...SANDBOX_BASE_ENV_KEYS, ...passthrough]);
}
