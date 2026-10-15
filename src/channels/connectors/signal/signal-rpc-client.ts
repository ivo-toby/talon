import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import {
  SignalDeliveryError,
  type SignalDeliveryReason,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { validateSignalSocket } from './signal-socket-trust.js';
import {
  encodeSignalRpcRequest,
  isSignalSubscriptionId,
  parseSignalReceiveNotification,
  parseSignalRpcFrame,
  parseSignalSendEvidence,
  SIGNAL_RPC_MAX_BYTES,
  SIGNAL_RPC_MAX_PENDING,
  type SignalJsonValue,
  type SignalReceiveNotification,
  type SignalRpcFrame,
  type SignalRpcRemoteError,
  type SignalRpcRequest,
  type SignalSendEvidence,
} from './signal-wire.js';

export type SignalTransportCode =
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'STOPPED'
  | 'CAPACITY'
  | 'INVALID_REQUEST'
  | 'PROTOCOL_FAILURE'
  | 'FRAME_TOO_LARGE'
  | 'PRE_RESPONSE_OVERFLOW'
  | 'UNTRUSTED_SOCKET';

function deliveryReason(code: SignalTransportCode): SignalDeliveryReason {
  switch (code) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'CANCELLED':
    case 'STOPPED':
      return 'CANCELLED';
    case 'CAPACITY':
      return 'RPC_CAPACITY';
    case 'UNTRUSTED_SOCKET':
      return 'UNTRUSTED_SOCKET';
    case 'INVALID_REQUEST':
    case 'PROTOCOL_FAILURE':
    case 'FRAME_TOO_LARGE':
    case 'PRE_RESPONSE_OVERFLOW':
      return 'INVALID_RESPONSE';
    default:
      return 'DISCONNECTED';
  }
}

/** Socket write acceptance is not bridge acceptance. Preserve the merged delivery-error identity. */
export class SignalRpcTransportError extends SignalDeliveryError {
  constructor(
    readonly transportCode: SignalTransportCode,
    submitted = false,
  ) {
    super({
      reason: deliveryReason(transportCode),
      outcome: submitted ? 'UNKNOWN' : 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: submitted ? 'unknown' : 'unwritten',
      successCount: 0,
      failureCount: 0,
      retryScope:
        !submitted && !['INVALID_REQUEST', 'UNTRUSTED_SOCKET'].includes(transportCode)
          ? 'delivery_only'
          : 'none',
    });
  }
}

export type SignalRpcReply =
  | { readonly kind: 'result'; readonly value: SignalJsonValue }
  | { readonly kind: 'send'; readonly evidence: SignalSendEvidence };
export type SignalRpcResult = Result<
  SignalRpcReply,
  SignalRpcTransportError | SignalRpcRemoteError
>;

export interface SignalRpcClientOptions {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;
  /** Synchronous handoff only. Admission, bounded receipt retry and account checks belong to policy. */
  readonly onReceive?: (event: SignalReceiveNotification) => void;
  /** One fixed-code notification per closed connection; lifecycle owns reconnect/backoff. */
  readonly onClose?: (error: SignalRpcTransportError) => void;
}

interface PendingRequest {
  readonly method: SignalRpcRequest['method'];
  readonly unsubscribeId?: number;
  readonly resolve: (result: SignalRpcResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort: () => void;
  submitted: boolean;
}
interface Connection {
  readonly socket: Socket;
  readonly buffer: Buffer;
  readonly finishConnect: (result: Result<void, SignalDeliveryError>) => void;
  readonly onDrain: () => void;
  used: number;
  ready: boolean;
  writeBlocked: boolean;
}

/** One bounded connection attempt; lifecycle/account verification is intentionally not wired here. */
export class SignalRpcClient {
  private connection?: Connection;
  private connecting?: Promise<Result<void, SignalDeliveryError>>;
  private readonly pending = new Map<string, PendingRequest>();
  private subscriptionPendingId?: string;
  private subscription?: number;
  private early: SignalReceiveNotification[] = [];
  private earlyBytes = 0;

  constructor(private readonly options: SignalRpcClientOptions) {}

  connect(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<void, SignalDeliveryError>> {
    if (this.connection?.ready) return Promise.resolve(ok(undefined));
    if (this.connecting) return this.connecting;
    if (options.signal?.aborted)
      return Promise.resolve(err(new SignalRpcTransportError('CANCELLED')));
    if (
      !Number.isInteger(this.options.requestTimeoutMs) ||
      this.options.requestTimeoutMs < 1_000 ||
      this.options.requestTimeoutMs > 120_000
    )
      return Promise.resolve(err(new SignalRpcTransportError('INVALID_REQUEST')));
    const before = validateSignalSocket(this.options.socketPath);
    if (before.isErr()) return Promise.resolve(err(before.error));

    const promise = new Promise<Result<void, SignalDeliveryError>>((resolve) => {
      const socket = new Socket();
      socket.pause();
      let finished = false;
      const timeout = setTimeout(
        () => this.closeConnection(connection, 'TIMEOUT'),
        this.options.requestTimeoutMs,
      );
      const cancel = (): void => this.closeConnection(connection, 'CANCELLED');
      const finishConnect = (result: Result<void, SignalDeliveryError>): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      const connection: Connection = {
        socket,
        ready: false,
        buffer: Buffer.alloc(SIGNAL_RPC_MAX_BYTES),
        used: 0,
        finishConnect,
        writeBlocked: false,
        onDrain: () => {
          if (this.connection === connection) connection.writeBlocked = false;
        },
      };
      this.connection = connection;
      const onConnect = (): void => {
        if (this.connection !== connection) return;
        const after = validateSignalSocket(this.options.socketPath, before.value);
        if (after.isErr()) {
          this.closeConnection(connection, 'UNTRUSTED_SOCKET', after.error);
          return;
        }
        connection.ready = true;
        finishConnect(ok(undefined));
        socket.resume();
      };
      const onData = (bytes: Buffer): void => this.read(connection, bytes);
      const onDisconnect = (): void => this.closeConnection(connection, 'DISCONNECTED');
      socket.once('connect', onConnect);
      socket.on('data', onData);
      socket.on('drain', connection.onDrain);
      socket.on('error', onDisconnect);
      socket.once('end', onDisconnect);
      socket.once('close', () => {
        onDisconnect();
        socket.removeListener('connect', onConnect);
        socket.removeListener('data', onData);
        socket.removeListener('error', onDisconnect);
        socket.removeListener('end', onDisconnect);
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        socket.connect(this.options.socketPath);
      } catch {
        this.closeConnection(connection, 'DISCONNECTED');
      }
    });
    this.connecting = promise;
    void promise.then(() => {
      if (this.connecting === promise) this.connecting = undefined;
    });
    return promise;
  }

  request(
    request: SignalRpcRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SignalRpcResult> {
    const connection = this.connection;
    if (options.signal?.aborted)
      return Promise.resolve(err(new SignalRpcTransportError('CANCELLED')));
    if (!connection?.ready || connection.socket.destroyed || !connection.socket.writable)
      return Promise.resolve(err(new SignalRpcTransportError('DISCONNECTED')));
    if (connection.writeBlocked || this.pending.size >= SIGNAL_RPC_MAX_PENDING)
      return Promise.resolve(err(new SignalRpcTransportError('CAPACITY')));
    const id = randomUUID();
    const encoded = encodeSignalRpcRequest(request, id);
    if (
      encoded.isErr() ||
      (request.method === 'subscribeReceive' &&
        (this.subscriptionPendingId !== undefined || this.subscription !== undefined))
    )
      return Promise.resolve(err(new SignalRpcTransportError('INVALID_REQUEST')));
    return new Promise<SignalRpcResult>((resolve) => {
      const cancel = (): void => this.failPending(id, 'CANCELLED');
      const pending: PendingRequest = {
        method: request.method,
        unsubscribeId:
          request.method === 'unsubscribeReceive' ? request.params.subscription : undefined,
        resolve,
        submitted: false,
        timer: setTimeout(() => this.failPending(id, 'TIMEOUT'), this.options.requestTimeoutMs),
        removeAbort: () => options.signal?.removeEventListener('abort', cancel),
      };
      this.pending.set(id, pending);
      if (request.method === 'subscribeReceive') this.subscriptionPendingId = id;
      options.signal?.addEventListener('abort', cancel, { once: true });
      // A false return is backpressure, NOT refusal. Even a throwing write cannot prove zero bytes.
      pending.submitted = true;
      try {
        const writable = connection.socket.write(encoded.value, (error) => {
          if (error) this.closeConnection(connection, 'DISCONNECTED');
        });
        // RPC settlement cannot release socket bytes. Retain this gate until actual drain,
        // bounding queued writes to the high-water mark plus one bounded request frame.
        if (!writable) connection.writeBlocked = true;
      } catch {
        this.closeConnection(connection, 'DISCONNECTED');
      }
    });
  }

  /** The later lifecycle owner drains its active chunk before calling this immediate cancellation. */
  stop(): void {
    if (this.connection) this.closeConnection(this.connection, 'STOPPED');
  }

  private settle(id: string, result: SignalRpcResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (this.subscriptionPendingId === id) this.subscriptionPendingId = undefined;
    pending.resolve(result);
  }

  private failPending(id: string, code: SignalTransportCode): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const subscribing = this.subscriptionPendingId === id;
    this.settle(id, err(new SignalRpcTransportError(code, pending.submitted)));
    // A possibly accepted subscription without a known ID must not keep a hidden receive handler.
    if (subscribing && this.connection) this.closeConnection(this.connection, code);
  }

  private closeConnection(
    connection: Connection,
    code: SignalTransportCode,
    connectError?: SignalDeliveryError,
  ): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.connecting = undefined;
    connection.ready = false;
    connection.writeBlocked = false;
    connection.socket.removeListener('drain', connection.onDrain);
    connection.used = 0;
    connection.finishConnect(err(connectError ?? new SignalRpcTransportError(code)));
    for (const [id, pending] of this.pending)
      this.settle(id, err(new SignalRpcTransportError(code, pending.submitted)));
    this.subscription = undefined;
    this.subscriptionPendingId = undefined;
    this.early = [];
    this.earlyBytes = 0;
    connection.socket.destroy();
    if (code !== 'STOPPED') this.options.onClose?.(new SignalRpcTransportError(code));
  }

  private read(connection: Connection, bytes: Buffer): void {
    if (this.connection !== connection || !connection.ready) return;
    let offset = 0;
    while (offset < bytes.length && this.connection === connection) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const size = end - offset;
      if (connection.used + size > SIGNAL_RPC_MAX_BYTES) {
        this.closeConnection(connection, 'FRAME_TOO_LARGE');
        return;
      }
      bytes.copy(connection.buffer, connection.used, offset, end);
      connection.used += size;
      if (newline < 0) return;
      const frameBytes = connection.used;
      const parsed = parseSignalRpcFrame(connection.buffer.subarray(0, frameBytes));
      connection.used = 0;
      if (parsed.isErr()) {
        this.closeConnection(connection, 'PROTOCOL_FAILURE');
        return;
      }
      this.dispatch(connection, parsed.value, frameBytes);
      offset = newline + 1;
    }
  }

  private dispatch(connection: Connection, frame: SignalRpcFrame, frameBytes: number): void {
    if (frame.kind === 'notification') {
      if (frame.method !== 'receive') return;
      const event = parseSignalReceiveNotification(frame.params);
      if (!event) return;
      if (this.subscriptionPendingId !== undefined) {
        if (this.earlyBytes + frameBytes > SIGNAL_RPC_MAX_BYTES) {
          this.closeConnection(connection, 'PRE_RESPONSE_OVERFLOW');
          return;
        }
        this.early.push(event);
        this.earlyBytes += frameBytes;
      } else if (this.subscription === event.subscription) {
        this.options.onReceive?.(event);
      }
      return;
    }
    // String IDs are generated locally; numeric/null/stale IDs never coerce to a pending key.
    if (typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.kind === 'failure') {
      if (pending.method === 'subscribeReceive') {
        this.early = [];
        this.earlyBytes = 0;
      }
      this.settle(frame.id, err(frame.error));
      return;
    }
    if (pending.method === 'subscribeReceive') {
      if (!isSignalSubscriptionId(frame.value)) {
        this.closeConnection(connection, 'PROTOCOL_FAILURE');
        return;
      }
      this.subscription = frame.value;
    }
    if (pending.method === 'unsubscribeReceive' && pending.unsubscribeId === this.subscription)
      this.subscription = undefined;
    this.settle(
      frame.id,
      ok(
        pending.method === 'send'
          ? Object.freeze({ kind: 'send', evidence: parseSignalSendEvidence(frame.value) })
          : Object.freeze({ kind: 'result', value: frame.value }),
      ),
    );
    if (pending.method === 'subscribeReceive') {
      const buffered = this.early;
      this.early = [];
      this.earlyBytes = 0;
      for (const event of buffered) {
        if (this.connection !== connection) break;
        if (event.subscription === this.subscription) this.options.onReceive?.(event);
      }
    }
  }
}
