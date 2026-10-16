#!/usr/bin/env node

/**
 * Reference Asterisk AGI signer for the incoming SIP authority envelope.
 *
 * The signer is dependency-free and only reads operator-owned
 * environment variables/private-key files. It does not accept key material or
 * a subject in process arguments, and it never writes the assertion to logs.
 */

import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const VERSION = 'talon-sip-v1';
const ALGORITHM = 'Ed25519';
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ASSERTION_LIFETIME_SECONDS = 60;
const MIN_NONCE_BYTES = 16;
const MAX_AGI_LINE_BYTES = 1024;

export function createAssertion({
  privateKey,
  issuer,
  keyId,
  audience,
  subject,
  issuedAt = Math.floor(Date.now() / 1000),
  lifetimeSeconds = MAX_ASSERTION_LIFETIME_SECONDS,
  nonce = randomBytes(MIN_NONCE_BYTES).toString('base64url'),
  callBinding,
}) {
  const values = { issuer, keyId, audience, subject, nonce, callBinding };
  for (const [name, value] of Object.entries(values)) {
    if (!isBoundedText(value)) throw new Error(`invalid ${name}`);
  }
  if (!Number.isSafeInteger(issuedAt)) throw new Error('invalid issuedAt');
  if (!Number.isSafeInteger(issuedAt + lifetimeSeconds)) throw new Error('invalid expiry');
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    throw new Error('invalid lifetimeSeconds');
  }
  if (Buffer.byteLength(nonce, 'utf8') < MIN_NONCE_BYTES) throw new Error('nonce is too short');

  const claims = {
    version: 1,
    algorithm: ALGORITHM,
    issuer,
    keyId,
    audience,
    subject,
    nonce,
    callBinding,
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signedBytes = Buffer.from(`${VERSION}.${payload}`, 'utf8');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  const signature = sign(null, signedBytes, key).toString('base64url');
  return `${VERSION}.${payload}.${signature}`;
}

/** Parse bounded AGI environment text in tests without trusting arbitrary input. */
export function parseAgiEnvironment(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024) {
    throw new Error('AGI environment is oversized');
  }
  const environment = Object.create(null);
  for (const line of text.split(/\r?\n/u)) {
    if (line === '') break;
    if (Buffer.byteLength(line, 'utf8') > MAX_AGI_LINE_BYTES) throw new Error('AGI line is oversized');
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('AGI environment line is malformed');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /u, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new Error('AGI environment field is malformed');
    }
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new Error('AGI environment field is duplicated');
    }
    environment[name] = value;
  }
  return environment;
}

export async function runAgi({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (process.argv.length > 2) throw new Error('AGI signer does not accept arguments');
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const agiEnvironment = Object.create(null);
  let line = await nextLine(iterator);
  let environmentBytes = 0;
  while (line !== null && line !== '') {
    environmentBytes += Buffer.byteLength(line, 'utf8');
    if (environmentBytes > 16 * 1024) throw new Error('AGI environment is oversized');
    const parsed = parseAgiEnvironment(`${line}\n`);
    for (const [name, value] of Object.entries(parsed)) {
      if (Object.prototype.hasOwnProperty.call(agiEnvironment, name)) {
        throw new Error('AGI environment field is duplicated');
      }
      agiEnvironment[name] = value;
    }
    line = await nextLine(iterator);
  }
  if (line === null) throw new Error('AGI environment ended early');

  output.write('GET VARIABLE TALON_SIP_ENDPOINT_SUBJECT\n');
  const subjectResponse = await nextLine(iterator);
  const subject = parseVariableResponse(subjectResponse);
  output.write('GET VARIABLE TALON_SIP_CALL_BINDING\n');
  const callBindingResponse = await nextLine(iterator);
  const callBinding = parseVariableResponse(callBindingResponse);
  const privateKeyPath = requiredEnvironment(environment, 'TALON_SIP_PRIVATE_KEY_FILE');
  const keyMaterial = readFileSync(privateKeyPath);
  if (keyMaterial.length > 16 * 1024) throw new Error('private key is oversized');
  const assertion = createAssertion({
    privateKey: keyMaterial,
    issuer: requiredEnvironment(environment, 'TALON_SIP_ISSUER'),
    keyId: requiredEnvironment(environment, 'TALON_SIP_KEY_ID'),
    audience: requiredEnvironment(environment, 'TALON_SIP_AUDIENCE'),
    subject,
    callBinding,
    issuedAt: now(),
  });

  output.write(`SET VARIABLE TALON_VOICE_ASSERTION ${assertion}\n`);
  const setResponse = await nextLine(iterator);
  if (!/^200 result=1(?:\s|$)/u.test(setResponse ?? '')) {
    throw new Error('Asterisk rejected the SIP assertion variable');
  }
  lines.close();
  return assertion;
}

async function nextLine(iterator) {
  const next = await iterator.next();
  if (next.done) return null;
  const line = String(next.value).replace(/\r$/u, '');
  if (Buffer.byteLength(line, 'utf8') > MAX_AGI_LINE_BYTES) throw new Error('AGI response is oversized');
  return line;
}

function parseVariableResponse(line) {
  const match = /^(?:200) result=1 \(([^()\r\n]{1,256})\)$/u.exec(line ?? '');
  if (!match || !isBoundedText(match[1])) throw new Error('Asterisk returned no authenticated endpoint');
  return match[1];
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!isBoundedText(value) || /[\r\n]/u.test(value)) throw new Error(`missing ${name}`);
  return value;
}

function isBoundedText(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgi().catch(() => {
    process.stderr.write('Talon SIP signer failed\n');
    process.exitCode = 1;
  });
}
