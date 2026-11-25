import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from 'neverthrow';
import { ScriptError } from './types.js';

const ASSET_FILES = ['package.json', 'index.js', 'index.d.ts', 'run.js'] as const;

/** Resolved from this file, so it works from `src` (tsx, vitest) and from `dist`. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sdk-assets');

/**
 * Write the in-container `talon` module to `<scriptsRoot>/node_modules/talon/`,
 * replacing an older copy. Files are 0o644 and directories 0o755 so a container
 * user with another uid can read them.
 */
export function installScriptSdk(scriptsRoot: string): Result<void, ScriptError> {
  if (!isAbsolute(scriptsRoot) || !existsSync(scriptsRoot)) {
    return err(
      new ScriptError('INVALID_ARGUMENT', 'scripts root must be an existing absolute path'),
    );
  }
  try {
    const modulesDir = join(scriptsRoot, 'node_modules');
    const target = join(modulesDir, 'talon');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true, mode: 0o755 });
    // mkdir applies the umask; make the modes explicit.
    chmodSync(modulesDir, 0o755);
    chmodSync(target, 0o755);
    for (const file of ASSET_FILES) {
      const path = join(target, file);
      writeFileSync(path, readFileSync(join(ASSETS_DIR, file)), { mode: 0o644 });
      chmodSync(path, 0o644);
    }
    return ok(undefined);
  } catch (error) {
    return err(
      new ScriptError(
        'SANDBOX',
        'could not install the script SDK',
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }
}
