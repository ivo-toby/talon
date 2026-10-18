import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const deniedSdk = resolve(import.meta.dirname, 'tests/fixtures/claude-agent-sdk-denied.ts');
// Existing filesystem requests retain separators/dot segments before native externalization.
// Conservatively reject paths carrying both SDK identity components, even across intermediates.
const realSdkId = /(?:^|\/)@anthropic-ai\/+(?:[^?#]*\/)?claude-agent-sdk(?:[/?#]|$)/;

function rejectRealSdk(id: string): void {
  if (realSdkId.test(id)) {
    throw new Error('Real Claude Agent SDK loading is forbidden in unit tests');
  }
}

export default defineConfig({
  plugins: [
    {
      name: 'unit-test-claude-sdk-fence',
      enforce: 'pre',
      resolveId(id): { id: string; external: false } | null {
        if (id === deniedSdk) return { id, external: false };
        rejectRealSdk(id);
        return null;
      },
      load(id): null {
        rejectRealSdk(id);
        return null;
      },
      transform(_code, id): null {
        rejectRealSdk(id);
        return null;
      },
    },
  ],
  test: {
    setupFiles: ['tests/fixtures/claude-agent-sdk-native-guard.ts'],
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: ['tests/**/*.{test,spec}.ts'],
    // vite-node checks inline before externalization; absolute files may bypass resolveId.
    server: { deps: { inline: [realSdkId], inlineFiles: [deniedSdk] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@anthropic-ai\/claude-agent-sdk$/, replacement: deniedSdk },
      { find: '@talon', replacement: resolve(import.meta.dirname, './src') },
    ],
  },
});
