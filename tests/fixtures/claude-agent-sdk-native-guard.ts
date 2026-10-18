import nodeModule from 'node:module';
import { dirname, normalize, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const registrationKey = Symbol.for('talon.tests.claude-agent-sdk-native-guard');

/** Retain one hook across Vitest cache/setup reloads for this Node worker's lifetime. */
export function installSdkNativeGuard(): void {
  if (Object.hasOwn(process, registrationKey)) return;

  // Resolution reads public package metadata only; no SDK module is loaded.
  const sdkMetadataRoot = dirname(
    nodeModule.createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
  );
  const hook = nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      let path: string;
      try {
        path = normalize(fileURLToPath(url));
      } catch {
        return nextLoad(url, context);
      }
      const components = path.split(sep);
      const hasSdkIdentity = components.some(
        (part, index) => part === '@anthropic-ai' && components[index + 1] === 'claude-agent-sdk',
      );
      if (path === sdkMetadataRoot || path.startsWith(sdkMetadataRoot + sep) || hasSdkIdentity) {
        throw new Error('Claude Agent SDK is disabled in unit tests; provide an explicit mock.');
      }
      return nextLoad(url, context);
    },
  });
  // Keep the public handle private and installed: deferred native loads may outlive a test file.
  Object.defineProperty(process, registrationKey, { value: hook });
}

// setupFiles consumers must import this before collecting SDK-dependent tests.
// Already-evaluated modules and arbitrary child workers are not retroactively fenced.
installSdkNativeGuard();
