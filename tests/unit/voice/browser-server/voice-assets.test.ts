import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { BrowserVoiceServer } from '../../../../src/voice/transports/browser/browser-server.js';
import type { VoiceSessionService } from '../../../../src/voice/voice-types.js';

interface MockResponse {
  readonly response: ServerResponse;
  readonly writeHead: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

function makeResponse(): MockResponse {
  const writeHead = vi.fn();
  const end = vi.fn();
  return {
    response: { writeHead, end } as unknown as ServerResponse,
    writeHead,
    end,
  };
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const assetDirectory = resolve(fileURLToPath(new URL('../../../../src/voice/web/', import.meta.url)));
  const server = new BrowserVoiceServer(
    { accessToken: 'test-access-token', staticDirectory: assetDirectory },
    {} as VoiceSessionService,
  );
  await (server as unknown as {
    serveAsset(path: string, response: ServerResponse): Promise<void>;
  }).serveAsset(pathname, response);
}

describe('browser voice static assets', () => {
  it.each(['/voice/assets/hal-lens.png', '/voice/assets/talon-logo.png'])(
    'serves %s as a PNG without opening a listener',
    async (pathname) => {
      const mock = makeResponse();
      await serveAsset(pathname, mock.response);

      expect(mock.writeHead).toHaveBeenCalledWith(200, {
        'cache-control': 'no-cache',
        'content-type': 'image/png',
      });
      const body = mock.end.mock.calls[0]?.[0];
      expect(Buffer.isBuffer(body)).toBe(true);
      expect((body as Buffer).length).toBeGreaterThan(0);
    },
  );
});
