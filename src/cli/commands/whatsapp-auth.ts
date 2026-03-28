/**
 * `talonctl whatsapp-auth` command.
 *
 * Standalone authentication flow for the WhatsApp Baileys connector.
 * Imports Baileys, fetches the latest WA Web version, opens a connection,
 * prints a QR code to the terminal, and waits for the user to scan it.
 * Once authenticated, credentials are saved to `authDir` and the process exits.
 *
 * The daemon itself never needs to show a QR — it just uses the saved auth state.
 */

export interface WhatsAppAuthOptions {
  authDir: string;
  timeout: number;
}

export async function whatsappAuthCommand(options: WhatsAppAuthOptions): Promise<void> {
  const { authDir, timeout } = options;

  // Dynamic import — Baileys is an optional dependency.
  const baileys = await import('@whiskeysockets/baileys').catch(() => {
    console.error(
      'Error: @whiskeysockets/baileys is not installed.\nRun: npm install @whiskeysockets/baileys',
    );
    process.exit(1);
  });

  const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;

  // Fetch latest WA Web version to avoid 405 protocol rejections.
  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log(`WhatsApp Web version: ${fetched.version.join('.')}`);
  } catch {
    console.log('Could not fetch latest version, using bundled default.');
  }

  // Dynamic import — qrcode-terminal is an optional dependency like Baileys itself.
  const qrMod = await import('qrcode-terminal').catch(() => null);
  // CJS module — generate lives on .default when imported via ESM dynamic import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qrTerminal: any = qrMod && ('default' in qrMod ? qrMod.default : qrMod);

  // Build a noop logger that satisfies Baileys' pino interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noop = (): any => {};
  const noopLogger = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'level') return 'silent';
      if (prop === 'child') return () => noopLogger;
      return noop;
    },
  });

  const timeoutMs = timeout * 1000;
  const deadline = Date.now() + timeoutMs;

  // Baileys often closes with status 515 ("restart required") after QR scan.
  // This is normal — the socket must reconnect to complete authentication.
  // We loop: create socket → wait for open/close → reconnect on transient closes.
  while (Date.now() < deadline) {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // If a prior iteration already completed auth (creds saved by saveCreds callback):
    if (state.creds.registered) {
      console.log('\nAuthenticated successfully!');
      console.log(`Credentials saved to "${authDir}".`);
      console.log('You can now start talond — no QR code will be needed.');
      return;
    }

    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.appropriate('Talon'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: noopLogger as any,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Wait for this socket attempt to resolve.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await new Promise<{ status: 'open' } | { status: 'retry'; code?: number } | { status: 'fatal'; message: string }>((resolve) => {
      const timer = setTimeout(() => {
        sock.end(undefined);
        resolve({ status: 'fatal', message: `Timeout: no scan received within ${timeout}s.` });
      }, Math.max(deadline - Date.now(), 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (qrTerminal) {
            qrTerminal.generate(qr, { small: true });
            console.log('Scan the QR code above with WhatsApp > Settings > Linked Devices\n');
          } else {
            console.log('QR code ready but qrcode-terminal is not installed.');
            console.log('Install it: npm install qrcode-terminal');
            console.log(`Or scan this manually: ${qr}\n`);
          }
        }

        if (connection === 'open') {
          clearTimeout(timer);
          resolve({ status: 'open' });
        }

        if (connection === 'close') {
          clearTimeout(timer);
          const statusCode = (
            lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            resolve({ status: 'fatal', message: 'WhatsApp rejected the session. Delete the auth directory and try again.' });
          } else {
            // 515 = restart required (normal after QR scan), other transient codes also retry.
            resolve({ status: 'retry', code: statusCode });
          }
        }
      });
    });

    // Clean up this socket before potentially creating a new one.
    try { sock.end(undefined); } catch { /* already closed */ }

    if (result.status === 'open') {
      console.log('\nAuthenticated successfully!');
      console.log(`Credentials saved to "${authDir}".`);
      console.log('You can now start talond — no QR code will be needed.');
      return;
    }

    if (result.status === 'fatal') {
      console.error(result.message);
      process.exit(1);
    }

    // Transient close — reconnect.
    console.log(`Reconnecting (status ${result.code ?? 'unknown'})...`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error(`Timeout: no successful connection within ${timeout}s.`);
  process.exit(1);
}
