declare module 'qrcode-terminal' {
  export function generate(text: string, options?: { small?: boolean }, cb?: (qr: string) => void): void;
}
