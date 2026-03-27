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
    console.log(`WhatsApp Web version: ${version.join('.')}`);
  } catch {
    console.log('Could not fetch latest version, using bundled default.');
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Check if already authenticated.
  if (state.creds.registered) {
    console.log(`Already authenticated. Credentials found in "${authDir}".`);
    console.log('To re-authenticate, delete the auth directory and run this command again.');
    return;
  }

  console.log('Waiting for QR code...\n');

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.appropriate('Talon'),
    printQRInTerminal: true,
    // Silence Baileys' internal logging — CLI output is handled by us.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { level: 'silent', child: () => ({ level: 'silent' }) } as any,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  const timeoutMs = timeout * 1000;

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error(`\nTimeout: no scan received within ${timeout}s. Try again.`);
      sock.end(undefined);
      reject(new Error('timeout'));
    }, timeoutMs);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        clearTimeout(timer);
        console.log('\nAuthenticated successfully!');
        console.log(`Credentials saved to "${authDir}".`);
        console.log('You can now start talond — no QR code will be needed.');
        sock.end(undefined);
        resolve();
      }

      if (connection === 'close') {
        clearTimeout(timer);
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.error('WhatsApp rejected the session. Delete the auth directory and try again.');
        } else {
          console.error(`Connection closed (status ${statusCode ?? 'unknown'}). Try again.`);
        }
        reject(new Error(`connection closed: ${statusCode}`));
      }
    });
  });
}
