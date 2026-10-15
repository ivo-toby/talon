import { isAsyncFunction } from 'node:util/types';
import { Err, Ok, type Result } from 'neverthrow';

/**
 * Run a synchronous Result operation through an existing SQLite transaction runner.
 * All writes must use that runner's connection. Returned Err values roll back;
 * unexpected exceptions roll back and propagate unchanged to the caller.
 */
export function runResultTransaction<T, E>(
  transaction: <V>(callback: () => V) => V,
  operation: () => Result<T, E>,
): Result<T, E> {
  if (isAsyncFunction(operation)) {
    throw new TypeError('Transaction callback must return a synchronous Result');
  }

  // Per-invocation identity keeps nested transactions from swallowing one another.
  const rollback = new Error('Result transaction rollback');
  let failure: Result<T, E> | undefined;
  try {
    return transaction(() => {
      const result = operation();
      if (!(result instanceof Ok || result instanceof Err)) {
        throw new TypeError('Transaction callback must return a synchronous Result');
      }
      if (result.isErr()) {
        failure = result;
        throw rollback;
      }
      return result;
    });
  } catch (cause) {
    if (cause === rollback && failure !== undefined) {
      return failure;
    }
    throw cause;
  }
}
