import { chmodSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';

export const OWNER_ONLY_DIR_MODE = 0o700;
export const OWNER_ONLY_FILE_MODE = 0o600;

export async function ensureOwnerOnlyDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  await fs.chmod(path, OWNER_ONLY_DIR_MODE);
}

export function ensureOwnerOnlyDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  chmodSync(path, OWNER_ONLY_DIR_MODE);
}

export async function ensureOwnerOnlyFile(path: string): Promise<void> {
  await fs.chmod(path, OWNER_ONLY_FILE_MODE);
}
