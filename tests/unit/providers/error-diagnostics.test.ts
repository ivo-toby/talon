import { describe, expect, it } from 'vitest';
import { extractProviderErrorDiagnostic } from '../../../src/providers/openai-compatible/agent-cli/error-diagnostics.js';

describe('safe provider error diagnostics', () => {
  it('retains nested SDK HTTP evidence without copying sensitive payloads', () => {
    const error = Object.assign(new Error('SECRET_SENTINEL'), {
      cause: Object.assign(new Error('SECRET_SENTINEL'), {
        name: 'AI_APICallError',
        statusCode: 429,
        responseHeaders: { authorization: 'SECRET_SENTINEL' },
      }),
    });
    expect(extractProviderErrorDiagnostic(error, 'wrapper-stream')).toEqual({
      category: 'rate-limit',
      code: 'AI_APICallError',
      httpStatus: 429,
      stage: 'wrapper-stream',
    });
    expect(JSON.stringify(extractProviderErrorDiagnostic(error))).not.toContain('SECRET_SENTINEL');
  });

  it('retains the last SDK retry failure without reading retry payload arrays', () => {
    expect(
      extractProviderErrorDiagnostic(
        {
          name: 'AI_RetryError',
          message: 'PRIVATE',
          lastError: {
            name: 'AI_APICallError',
            statusCode: 503,
            responseBody: 'PRIVATE',
          },
        },
        'wrapper-stream',
      ),
    ).toEqual({
      category: 'provider',
      code: 'AI_APICallError',
      httpStatus: 503,
      stage: 'wrapper-stream',
    });
  });

  it('preserves only allowlisted serialized metadata across repeated wrapping', () => {
    const diagnostic = extractProviderErrorDiagnostic(
      JSON.parse(
        JSON.stringify({
          diagnostic: {
            category: 'auth',
            code: 'SECRET_SENTINEL',
            httpStatus: 401,
            stage: 'wrapper-stream',
            url: 'SECRET_SENTINEL',
          },
        }),
      ),
    );
    expect(diagnostic).toEqual({ category: 'auth', httpStatus: 401, stage: 'wrapper-stream' });
    expect(extractProviderErrorDiagnostic({ diagnostic })).toEqual(diagnostic);
  });

  it.each([99, 600, 401.5, '401', null, NaN, Infinity])(
    'rejects invalid HTTP status %s',
    (status) => {
      expect(extractProviderErrorDiagnostic({ statusCode: status })).toBeUndefined();
    },
  );

  it('rejects forged category, code and stage and does not infer from text', () => {
    expect(
      extractProviderErrorDiagnostic({
        diagnostic: { category: 'SECRET_SENTINEL', stage: 'SECRET_SENTINEL' },
        message: 'timeout after 318s',
      }),
    ).toBeUndefined();
    expect(
      extractProviderErrorDiagnostic({
        diagnostic: {
          category: 'unknown',
          code: 'SECRET_SENTINEL',
          stage: 'SECRET_SENTINEL',
          httpStatus: 999,
        },
      }),
    ).toEqual({ category: 'unknown' });
  });

  it('ignores accessors, inherited fields and throwing proxy traps', () => {
    const getter = () => {
      throw new Error('SECRET_SENTINEL');
    };
    expect(
      extractProviderErrorDiagnostic(Object.defineProperty({}, 'diagnostic', { get: getter })),
    ).toBeUndefined();
    expect(
      extractProviderErrorDiagnostic({
        diagnostic: Object.create({ category: 'auth', httpStatus: 401 }),
      }),
    ).toBeUndefined();
    expect(extractProviderErrorDiagnostic(Object.create({ statusCode: 401 }))).toBeUndefined();
    expect(
      extractProviderErrorDiagnostic(new Proxy({}, { getOwnPropertyDescriptor: getter })),
    ).toBeUndefined();
  });

  it('bounds cyclic errors and keeps unknown classification explicit', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(extractProviderErrorDiagnostic(error, 'wrapper-execution')).toEqual({
      category: 'unknown',
      stage: 'wrapper-execution',
    });
  });

  it.each([
    [{ code: 'ECONNRESET' }, 'network'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ name: 'AI_ToolExecutionError' }, 'tool'],
    [{ statusCode: 503 }, 'provider'],
  ])('classifies structured evidence %j', (error, category) => {
    expect(extractProviderErrorDiagnostic(error)?.category).toBe(category);
  });
});
