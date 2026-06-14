import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TALOND_BRIDGE_SECRET_ENV = 'TALOND_BRIDGE_SECRET';

export function generateBridgeSecret(): string {
  return randomBytes(32).toString('hex');
}

export function bridgeSecretsMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
