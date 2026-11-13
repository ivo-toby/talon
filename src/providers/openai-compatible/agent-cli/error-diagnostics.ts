const categories = [
  'timeout',
  'auth',
  'rate-limit',
  'network',
  'provider',
  'tool',
  'unknown',
] as const;
const codes = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'TimeoutError',
  'AI_APICallError',
  'AI_ToolExecutionError',
] as const;
const stages = ['wrapper-stream', 'wrapper-execution', 'provider-process', 'agent-query'] as const;

export interface ProviderErrorDiagnostic {
  category: (typeof categories)[number];
  code?: (typeof codes)[number];
  httpStatus?: number;
  stage?: (typeof stages)[number];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function dataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function allowed<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function hasPriorityStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status === 504;
}

function classify(code: (typeof codes)[number] | undefined, status: number | undefined): ProviderErrorDiagnostic['category'] {
  return status === 401 || status === 403
    ? 'auth'
    : status === 429
      ? 'rate-limit'
      : status === 408 ||
          status === 504 ||
          code === 'ETIMEDOUT' ||
          code === 'UND_ERR_CONNECT_TIMEOUT' ||
          code === 'UND_ERR_HEADERS_TIMEOUT' ||
          code === 'UND_ERR_BODY_TIMEOUT' ||
          code === 'TimeoutError'
        ? 'timeout'
        : code === 'AI_ToolExecutionError'
          ? 'tool'
          : code && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
            ? 'network'
            : 'provider';
}

function nestedError(value: object): Record<string, unknown> | undefined {
  return (
    record(dataProperty(value, 'cause')) ??
    record(dataProperty(value, 'error')) ??
    record(dataProperty(value, 'lastError'))
  );
}

function mergePreservedDiagnostic(
  diagnostic: ProviderErrorDiagnostic,
  status: number | undefined,
  stage: ProviderErrorDiagnostic['stage'] | undefined,
): ProviderErrorDiagnostic {
  return {
    ...diagnostic,
    ...(hasPriorityStatus(status) ? { category: classify(diagnostic.code, status) } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(stage ? { stage } : {}),
  };
}

/** Only bounded, allowlisted fields may cross the voice privacy boundary. */
export function extractProviderErrorDiagnostic(
  value: unknown,
  stage?: ProviderErrorDiagnostic['stage'],
): ProviderErrorDiagnostic | undefined {
  let current = record(value);
  const seen = new Set<object>();
  let preservedStatus: number | undefined;
  let preservedStage: ProviderErrorDiagnostic['stage'] | undefined;
  let preservedDiagnostic: ProviderErrorDiagnostic | undefined;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const metadata = record(dataProperty(current, 'diagnostic'));
    if (metadata) {
      const category = allowed(dataProperty(metadata, 'category'), categories);
      if (category) {
        const code = allowed(dataProperty(metadata, 'code'), codes);
        const status = httpStatus(dataProperty(metadata, 'httpStatus'));
        const safeStage = allowed(dataProperty(metadata, 'stage'), stages) ?? stage;
        const effectiveStatus = preservedStatus ?? status;
        const diagnostic: ProviderErrorDiagnostic = {
          category:
            code ||
            hasPriorityStatus(effectiveStatus)
              ? classify(code, effectiveStatus)
              : category,
          ...(code ? { code } : {}),
          ...(status ? { httpStatus: status } : {}),
          ...(safeStage ? { stage: safeStage } : {}),
        };
        if (code !== 'AI_APICallError') {
          return {
            ...diagnostic,
            ...(preservedStatus !== undefined ? { httpStatus: preservedStatus } : {}),
            ...(!diagnostic.stage && preservedStage ? { stage: preservedStage } : {}),
          };
        }
        preservedStatus ??=
          status ??
          httpStatus(dataProperty(current, 'statusCode')) ??
          httpStatus(dataProperty(current, 'status'));
        preservedStage ??= safeStage;
        preservedDiagnostic ??= diagnostic;
        const nested = nestedError(current);
        if (nested) {
          current = nested;
          continue;
        }
        return mergePreservedDiagnostic(preservedDiagnostic, preservedStatus, preservedStage);
      }
    }

    const code =
      allowed(dataProperty(current, 'code'), codes) ??
      allowed(dataProperty(current, 'name'), codes);
    const status =
      httpStatus(dataProperty(current, 'statusCode')) ??
      httpStatus(dataProperty(current, 'status'));
    if (code || status) {
      const diagnostic: ProviderErrorDiagnostic = {
        category: classify(code, preservedStatus ?? status),
        ...(code ? { code } : {}),
        ...(status ? { httpStatus: status } : {}),
        ...(stage ? { stage } : {}),
      };
      if (code !== 'AI_APICallError') {
        return {
          ...diagnostic,
          ...(preservedStatus !== undefined ? { httpStatus: preservedStatus } : {}),
          ...(preservedStage ? { stage: preservedStage } : {}),
        };
      }
      preservedStatus ??= status;
      preservedStage ??= stage;
      preservedDiagnostic ??= diagnostic;
      const nested = nestedError(current);
      if (nested) {
        current = nested;
        continue;
      }
      return mergePreservedDiagnostic(preservedDiagnostic, preservedStatus, preservedStage);
    }

    const nested = nestedError(current);
    if (!nested) break;
    current = nested;
  }
  if (preservedDiagnostic) {
    return mergePreservedDiagnostic(preservedDiagnostic, preservedStatus, preservedStage);
  }
  return stage ? { category: 'unknown', stage } : undefined;
}
