const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENVIRONMENT_VARIABLE_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const PROVIDER_ENVIRONMENT_VARIABLE_REFERENCE = /(?:\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})|%[A-Za-z_][A-Za-z0-9_]*%)/u;

/** Return environment-variable references in a `${NAME}` string. */
export function findEnvironmentVariableReferences(value: string): string[] {
  return [...value.matchAll(ENVIRONMENT_VARIABLE_PLACEHOLDER)].map((match) => match[1]);
}

/** Detect references that a downstream provider may expand in MCP config. */
export function hasProviderEnvironmentVariableReference(value: string): boolean {
  return PROVIDER_ENVIRONMENT_VARIABLE_REFERENCE.test(value);
}

/** Expand `${NAME}` references without exposing values in errors. */
export function expandEnvironmentVariables(
  value: string,
  context: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(ENVIRONMENT_VARIABLE_PLACEHOLDER, (_placeholder, name: string) =>
    requireEnvironmentVariable(name, context, environment),
  );
}

/** Resolve a required environment variable while keeping its value out of diagnostics. */
export function requireEnvironmentVariable(
  name: string,
  context: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
    throw new Error(`${context} has an invalid environment variable name`);
  }

  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${context} requires environment variable "${name}" to be set`);
  }

  return value;
}

/** Check whether a string is a valid environment-variable name. */
export function isEnvironmentVariableName(value: string): boolean {
  return ENVIRONMENT_VARIABLE_NAME.test(value);
}
