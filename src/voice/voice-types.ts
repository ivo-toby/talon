/**
 * Shared contracts for the opt-in voice boundary.
 *
 * This module deliberately contains provider-neutral types.  The live
 * adapter owns provider event names and payload validation; the session
 * service owns identity, policy, persistence, and task state.  Browser
 * supplied values never select a persona, provider, tool, or MCP server.
 */

import type { TalonError } from '../core/errors/error-types.js';
import type { Result } from '../core/types/result.js';

// ---------------------------------------------------------------------------
// Common result and callback types
// ---------------------------------------------------------------------------

/** Result type used at every voice module boundary. */
export type VoiceResult<T> = Result<T, TalonError>;

/** Promise form of {@link VoiceResult}. */
export type VoiceAsyncResult<T> = Promise<VoiceResult<T>>;

/** A listener can do asynchronous work; the publisher owns error handling. */
export type VoiceEventHandler<T> = (event: T) => void | Promise<void>;

/** Unregisters a previously registered listener. */
export type VoiceUnsubscribe = () => void;

// ---------------------------------------------------------------------------
// Identifiers, ownership, and lifecycle
// ---------------------------------------------------------------------------

export type VoiceSessionId = string;
export type VoiceDelegationId = string;
export type VoiceOutputId = string;
export type LiveProviderSessionId = string;
export type LiveProviderDelegationId = string;

/** Transport names are open for a later SIP adapter. */
export type VoiceTransportKind = string;

export type VoiceSessionStatus =
  | 'created'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'expired'
  | 'failed';

export type VoiceTransportStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'failed';

export type VoiceDelegationStatus =
  | 'admitted'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'superseded'
  | 'skipped';

export type VoiceExecutionStatus =
  | 'not_started'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'skipped';

export type VoiceDeliveryStatus =
  | 'not_requested'
  | 'pending'
  | 'sent'
  | 'acknowledged'
  | 'failed'
  | 'unknown';

export type VoicePlaybackStatus = 'not_started' | 'playing' | 'played' | 'interrupted' | 'unknown';

export type VoiceOutputKind = 'progress' | 'final';

export interface VoiceOwnerContext {
  /** Stable authenticated operator identity; never sourced from the browser body. */
  readonly ownerId: string;
  /** Monotonic login/session revision used to reject revoked sessions. */
  readonly loginRevision: number;
}

export interface VoiceFinalizationState {
  readonly status: 'pending' | 'confirmed' | 'incomplete';
  readonly providerReason?: string;
  readonly confirmedAt?: number;
}

export interface VoiceUsageSummary {
  /** Cumulative provider-reported voice duration, when available. */
  readonly voiceSeconds?: number;
  /** Estimated or confirmed voice cost; never inferred from token totals. */
  readonly voiceCostUsd?: number;
  readonly voiceCostStatus: 'estimated' | 'confirmed' | 'incomplete' | 'unavailable';
  /** Backend accounting is kept separate from voice transport accounting. */
  readonly backendCostUsd?: number;
  readonly backendCostStatus: 'estimated' | 'confirmed' | 'incomplete' | 'unavailable';
}

export interface VoiceSessionRecord {
  readonly id: VoiceSessionId;
  /** Monotonic compare-and-set revision for recovery and concurrent updates. */
  readonly revision: number;
  readonly owner: VoiceOwnerContext;
  readonly personaId: string;
  readonly threadId: string;
  readonly transport: VoiceTransportKind;
  readonly status: VoiceSessionStatus;
  readonly providerSessionId?: LiveProviderSessionId;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly deadlineAt: number;
  readonly closingAt?: number;
  readonly closedAt?: number;
  readonly policy: VoicePolicySnapshot;
  readonly usage: VoiceUsageSummary;
  readonly finalization: VoiceFinalizationState;
  readonly activeDelegationId?: VoiceDelegationId;
}

// ---------------------------------------------------------------------------
// Transcript and context ownership
// ---------------------------------------------------------------------------

export type VoiceTranscriptRole = 'user' | 'assistant';
export type VoiceTranscriptFragmentKind = 'delta' | 'completed' | 'correction';

/** Normalized transcript data; provider-specific event fields stay in the adapter. */
export interface VoiceTranscriptFragment {
  readonly id: string;
  readonly role: VoiceTranscriptRole;
  readonly kind: VoiceTranscriptFragmentKind;
  readonly sequence: number;
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly receivedAt: number;
}

/**
 * A bounded, server-owned context snapshot.  The full transcript may be held
 * temporarily in memory, but this snapshot is the only context crossing into
 * Talon backend work and its digest/version are immutable after admission.
 */
export interface VoiceContextSnapshot {
  readonly version: number;
  readonly digest: string;
  readonly capturedAt: number;
  readonly text: string;
  readonly fragments: readonly VoiceTranscriptFragment[];
  readonly truncated: boolean;
}

export interface VoiceDelegationProposal {
  readonly providerDelegationId: LiveProviderDelegationId;
  /** Provider position used to select the transcript context. */
  readonly offsetMs: number;
  readonly receivedAt: number;
}

// ---------------------------------------------------------------------------
// Policy and execution eligibility
// ---------------------------------------------------------------------------

/** Effective server-side policy captured at admission. */
export interface VoicePolicySnapshot {
  readonly generation: number;
  readonly ownerId: string;
  readonly personaId: string;
  readonly providerName: string;
  readonly modelName: string;
  /** Server-selected output voice; browser input cannot override it. */
  readonly voiceName: VoiceOutputVoice;
  readonly capabilityNames: readonly string[];
  readonly allowedToolNames: readonly string[];
  readonly allowedMcpServerNames: readonly string[];
  readonly nativeToolNames: readonly string[];
  readonly requireApproval: boolean;
  readonly loginRevision: number;
  readonly capturedAt: number;
}

/** Input used when capturing a fresh effective policy/configuration snapshot. */
export type VoicePolicySnapshotInput = Omit<VoicePolicySnapshot, 'capturedAt'> & {
  readonly capturedAt?: number;
};

export type VoiceEligibilityReason =
  | 'session_closed'
  | 'session_expired'
  | 'login_revoked'
  | 'persona_disabled'
  | 'provider_disabled'
  | 'policy_changed'
  | 'approval_required'
  | 'native_tools_not_proven'
  | 'mcp_access_not_proven'
  | 'owner_mismatch';

export interface VoiceExecutionEligibility {
  readonly eligible: boolean;
  readonly reason?: VoiceEligibilityReason;
  readonly admissionPolicy: VoicePolicySnapshot;
  readonly executionPolicy: VoicePolicySnapshot;
  readonly checkedAt: number;
}

export interface VoicePolicyEvaluator {
  capture(input: VoicePolicySnapshotInput): VoiceResult<VoicePolicySnapshot>;
  checkExecution(input: {
    readonly session: VoiceSessionRecord;
    readonly admitted: VoicePolicySnapshot;
    readonly current: VoicePolicySnapshot;
    readonly now: number;
  }): VoiceResult<VoiceExecutionEligibility>;
}

// ---------------------------------------------------------------------------
// Live provider and transport boundary
// ---------------------------------------------------------------------------

/**
 * Opaque client configuration returned by a provider/transport handshake.
 * It may contain an SDP answer or an equivalent transport descriptor and is
 * sent only in the create-session response; it is never persisted or logged.
 */
export interface VoiceClientSessionDescriptor {
  readonly transport: VoiceTransportKind;
  readonly sessionId: VoiceSessionId;
  readonly providerSessionId: LiveProviderSessionId;
  readonly descriptor: string;
  readonly expiresAt: number;
}

/** Default selected by Talon's browservoice configuration. */
export const DEFAULT_VOICE_OUTPUT_VOICE = 'marin' as const;

/** Provider voice names remain open for a later adapter or configured voice. */
export type VoiceOutputVoice = typeof DEFAULT_VOICE_OUTPUT_VOICE | (string & {});

export interface VoiceAudioOutputSettings {
  readonly voice: VoiceOutputVoice;
}

export interface LiveVoiceSessionRequest {
  readonly sessionId: VoiceSessionId;
  readonly ownerId: string;
  readonly modelName: string;
  readonly instructions: string;
  readonly delegationMode: 'client';
  readonly audio: {
    readonly output: VoiceAudioOutputSettings;
  };
}

export interface LiveVoiceSession {
  readonly providerSessionId: LiveProviderSessionId;
  readonly client: VoiceClientSessionDescriptor;
}

/**
 * Normalized events emitted by the live adapter.  These discriminators are
 * Talon-owned; provider event names and payloads must not cross this boundary.
 */
export type LiveVoiceEvent =
  | {
      readonly kind: 'transcript';
      readonly eventId: string;
      readonly sequence: number;
      readonly fragment: VoiceTranscriptFragment;
    }
  | {
      readonly kind: 'delegation';
      readonly eventId: string;
      readonly sequence: number;
      readonly proposal: VoiceDelegationProposal;
    }
  | {
      readonly kind: 'provider_acknowledgement';
      readonly eventId: string;
      readonly sequence: number;
      readonly delegationId: LiveProviderDelegationId;
      readonly outputId: VoiceOutputId;
      readonly receivedAt: number;
    }
  | {
      readonly kind: 'usage';
      readonly eventId: string;
      readonly sequence: number;
      readonly update: VoiceUsageUpdate;
    }
  | {
      readonly kind: 'session_closed';
      readonly eventId: string;
      readonly sequence: number;
      readonly reason: string;
      readonly usage?: VoiceUsageUpdate;
      readonly receivedAt: number;
    }
  | {
      readonly kind: 'error';
      readonly eventId: string;
      readonly sequence: number;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly receivedAt: number;
    };

export interface VoiceUsageUpdate {
  /** Usage updates are cumulative snapshots, never deltas to add blindly. */
  readonly voiceSeconds?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly receivedAt: number;
  readonly final: boolean;
}

export type LiveVoiceCommand =
  | {
      readonly kind: 'thinking';
      readonly delegationId: LiveProviderDelegationId | null;
      readonly content: string;
      readonly outputId: VoiceOutputId;
    }
  | {
      readonly kind: 'commentary';
      readonly delegationId: LiveProviderDelegationId;
      readonly content: string;
      readonly outputId: VoiceOutputId;
    }
  | {
      readonly kind: 'instruction';
      readonly delegationId: LiveProviderDelegationId | null;
      readonly content: string;
      readonly outputId: VoiceOutputId;
    }
  | {
      readonly kind: 'close';
    };

export interface LiveVoiceSideband {
  readonly providerSessionId: LiveProviderSessionId;
  send(command: LiveVoiceCommand): VoiceAsyncResult<void>;
  onEvent(handler: VoiceEventHandler<LiveVoiceEvent>): VoiceUnsubscribe;
  close(graceful: boolean): VoiceAsyncResult<void>;
}

export interface LiveVoiceProvider {
  readonly name: string;
  createSession(input: LiveVoiceSessionRequest): VoiceAsyncResult<LiveVoiceSession>;
  attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband>;
  closeSession(providerSessionId: LiveProviderSessionId): VoiceAsyncResult<void>;
}

export interface VoiceTransportOpenRequest {
  readonly sessionId: VoiceSessionId;
  readonly ownerId: string;
  readonly client: VoiceClientSessionDescriptor;
}

export interface VoiceTransportHandle {
  readonly sessionId: VoiceSessionId;
  readonly transportSessionId: string;
  readonly kind: VoiceTransportKind;
  readonly status: VoiceTransportStatus;
}

export type VoiceTransportEvent =
  | {
      readonly kind: 'status';
      readonly status: VoiceTransportStatus;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'playback';
      readonly outputId: VoiceOutputId;
      readonly status: VoicePlaybackStatus;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
      readonly occurredAt: number;
    };

export interface VoiceTransport {
  readonly kind: VoiceTransportKind;
  open(input: VoiceTransportOpenRequest): VoiceAsyncResult<VoiceTransportHandle>;
  status(sessionId: VoiceSessionId): VoiceResult<VoiceTransportStatus>;
  onEvent(
    sessionId: VoiceSessionId,
    handler: VoiceEventHandler<VoiceTransportEvent>,
  ): VoiceUnsubscribe;
  close(sessionId: VoiceSessionId, reason: string): VoiceAsyncResult<void>;
}

// ---------------------------------------------------------------------------
// Backend requests, results, and output lifecycle
// ---------------------------------------------------------------------------

export interface VoiceBackendRequest {
  readonly sessionId: VoiceSessionId;
  readonly delegationId: VoiceDelegationId;
  readonly providerDelegationId: LiveProviderDelegationId;
  readonly threadId: string;
  readonly personaId: string;
  readonly context: VoiceContextSnapshot;
  readonly policy: VoicePolicySnapshot;
  readonly requestedAt: number;
}

export interface VoiceOutputLifecycle {
  readonly execution: VoiceExecutionStatus;
  readonly delivery: VoiceDeliveryStatus;
  readonly providerAcknowledgement: 'not_sent' | 'sent' | 'acknowledged' | 'rejected' | 'unknown';
  readonly playback: VoicePlaybackStatus;
}

export interface VoiceBackendResult {
  readonly delegationId: VoiceDelegationId;
  readonly outputId: VoiceOutputId;
  readonly kind: VoiceOutputKind | 'error' | 'unknown';
  readonly text?: string;
  readonly execution: VoiceExecutionStatus;
  readonly output: VoiceOutputLifecycle;
  readonly errorCode?: string;
  readonly occurredAt: number;
}

export interface VoiceDelegationRecord {
  readonly id: VoiceDelegationId;
  readonly sessionId: VoiceSessionId;
  readonly providerDelegationId: LiveProviderDelegationId;
  readonly revision: number;
  readonly contextVersion: number;
  readonly contextDigest: string;
  readonly request: VoiceBackendRequest;
  readonly status: VoiceDelegationStatus;
  readonly execution: VoiceExecutionStatus;
  readonly output: VoiceOutputLifecycle;
  readonly queueItemId?: string;
  readonly runId?: string;
  readonly supersedesDelegationId?: VoiceDelegationId;
  readonly createdAt: number;
  readonly claimedAt?: number;
  readonly completedAt?: number;
}

export interface VoiceSessionUpdateRequest {
  readonly sessionId: VoiceSessionId;
  readonly expectedRevision: number;
  /** Session identity and the admission policy are immutable after creation. */
  readonly patch: Partial<
    Pick<
      VoiceSessionRecord,
      | 'status'
      | 'providerSessionId'
      | 'startedAt'
      | 'closingAt'
      | 'closedAt'
      | 'usage'
      | 'finalization'
      | 'activeDelegationId'
    >
  >;
  readonly updatedAt: number;
}

export interface VoiceSessionReadProjection {
  readonly session: VoiceSessionRecord;
  readonly delegations: readonly VoiceDelegationRecord[];
  /** Retained bounded results, including progress and final output history. */
  readonly outputs: readonly VoiceOutputStatusDto[];
}

export interface VoiceSessionListQuery {
  readonly ownerId?: string;
  readonly statuses?: readonly VoiceSessionStatus[];
}

export interface VoiceSessionRecoveryQuery {
  readonly before: number;
  readonly statuses: readonly Extract<
    VoiceSessionStatus,
    'created' | 'connecting' | 'connected' | 'closing'
  >[];
}

export interface VoiceOutputLifecycleUpdate {
  readonly delegationId: VoiceDelegationId;
  readonly outputId: VoiceOutputId;
  readonly lifecycle: VoiceOutputLifecycle;
}

export interface VoiceQueueAdmission {
  /** Allocated before the shared transaction so both rows can reference it. */
  readonly queueItemId: string;
  readonly threadId: string;
  readonly delegationId: VoiceDelegationId;
  readonly request: VoiceBackendRequest;
  /** Voice effects must not be automatically retried after an uncertain run. */
  readonly maxAttempts: 1;
}

export interface VoiceQueueReceipt {
  readonly queueItemId: string;
  readonly delegationId: VoiceDelegationId;
  readonly admittedAt: number;
}

export interface VoiceAdmissionRequest {
  /** The store must persist the reservation and queue row atomically. */
  readonly delegation: VoiceDelegationRecord;
  readonly queue: VoiceQueueAdmission;
}

export interface VoiceAdmissionReceipt {
  readonly delegationId: VoiceDelegationId;
  readonly queueItemId: string;
  readonly contextVersion: number;
  readonly contextDigest: string;
  readonly policyGeneration: number;
  readonly admittedAt: number;
}

export interface VoiceClaimRequest {
  readonly delegationId: VoiceDelegationId;
  readonly expectedRevision: number;
  readonly queueItemId: string;
  readonly claimedAt: number;
}

export type VoiceClaimLossReason =
  | 'already_claimed'
  | 'superseded'
  | 'skipped'
  | 'missing'
  | 'stale_revision';

export type VoiceClaimResult =
  | {
      readonly outcome: 'claimed';
      readonly delegation: VoiceDelegationRecord;
    }
  | {
      readonly outcome: 'lost';
      readonly reason: VoiceClaimLossReason;
      readonly delegation?: VoiceDelegationRecord;
    };

export interface VoiceSupersedeRequest {
  readonly originalDelegationId: VoiceDelegationId;
  readonly expectedRevision: number;
  /**
   * A replacement always records the immutable original ID it supersedes. The
   * store rejects reuse of the original ID and preserves its context digest.
   */
  readonly replacement: VoiceDelegationRecord & {
    readonly supersedesDelegationId: VoiceDelegationId;
  };
  readonly supersededAt: number;
}

export type VoiceSupersedeResult =
  | {
      readonly outcome: 'superseded';
      readonly original: VoiceDelegationRecord;
      readonly replacement: VoiceDelegationRecord;
    }
  | {
      readonly outcome: 'not_replaceable';
      readonly reason:
        | 'claimed'
        | 'running'
        | 'completed'
        | 'failed'
        | 'unknown'
        | 'missing'
        | 'stale_revision';
      readonly original?: VoiceDelegationRecord;
    };

export interface VoiceSkipRequest {
  readonly delegationId: VoiceDelegationId;
  readonly expectedRevision: number;
  readonly reason: 'hangup' | 'logout' | 'deadline' | 'shutdown';
  readonly skippedAt: number;
}

export interface VoiceStoreOperations {
  findSession(id: VoiceSessionId): VoiceResult<VoiceSessionRecord | null>;
  createSession(session: VoiceSessionRecord): VoiceResult<VoiceSessionRecord>;
  updateSession(input: VoiceSessionUpdateRequest): VoiceResult<VoiceSessionRecord>;
  readSession(id: VoiceSessionId): VoiceResult<VoiceSessionReadProjection | null>;
  listSessions(input: VoiceSessionListQuery): VoiceResult<readonly VoiceSessionReadProjection[]>;
  recoverSessions(
    input: VoiceSessionRecoveryQuery,
  ): VoiceResult<readonly VoiceSessionReadProjection[]>;
  findDelegation(id: VoiceDelegationId): VoiceResult<VoiceDelegationRecord | null>;
  claimDelegation(input: VoiceClaimRequest): VoiceResult<VoiceClaimResult>;
  supersedeDelegation(input: VoiceSupersedeRequest): VoiceResult<VoiceSupersedeResult>;
  skipDelegation(input: VoiceSkipRequest): VoiceResult<VoiceDelegationRecord>;
  recordBackendResult(result: VoiceBackendResult): VoiceResult<VoiceDelegationRecord>;
  recordOutputLifecycle(input: VoiceOutputLifecycleUpdate): VoiceResult<VoiceOutputStatusDto>;
}

export interface VoiceStoreTransaction extends VoiceStoreOperations {
  /** Reservation is transaction-private and must be paired with queue insert. */
  reserveDelegation(input: VoiceAdmissionRequest): VoiceResult<VoiceDelegationRecord>;
  enqueueVoiceWork(input: VoiceQueueAdmission): VoiceResult<VoiceQueueReceipt>;
}

export interface VoiceStore extends VoiceStoreOperations {
  /** The reservation and queue insert must commit or roll back together. */
  runInTransaction<T>(
    operation: (transaction: VoiceStoreTransaction) => VoiceResult<T>,
  ): VoiceResult<T>;
  admitDelegation(input: VoiceAdmissionRequest): VoiceResult<VoiceAdmissionReceipt>;
}

export interface VoiceBackendBridge {
  admit(request: VoiceBackendRequest): VoiceAsyncResult<VoiceAdmissionReceipt>;
  result(delegationId: VoiceDelegationId): VoiceResult<VoiceBackendResult | null>;
  onResult(
    delegationId: VoiceDelegationId,
    handler: VoiceEventHandler<VoiceBackendResult>,
  ): VoiceUnsubscribe;
}

// ---------------------------------------------------------------------------
// Session service and status DTOs
// ---------------------------------------------------------------------------

export interface VoiceSessionCreateRequest {
  /** Server-side configuration chooses the persona, provider, and tools. */
  readonly transport: VoiceTransportKind;
}

export interface VoiceSessionCreateResult {
  readonly session: VoiceSessionRecord;
  readonly client: VoiceClientSessionDescriptor;
}

export type VoiceCloseReason = 'hangup' | 'logout' | 'deadline' | 'shutdown' | 'transport_failure';

export interface VoiceSessionCloseRequest {
  readonly reason: VoiceCloseReason;
}

export interface VoiceSessionCloseResult {
  readonly session: VoiceSessionRecord;
  readonly pendingDelegation: boolean;
}

export interface VoiceProviderEventEnvelope {
  readonly sessionId: VoiceSessionId;
  readonly providerSessionId: LiveProviderSessionId;
  readonly event: LiveVoiceEvent;
}

export interface VoicePlaybackReport {
  readonly outputId: VoiceOutputId;
  readonly status: 'started' | 'played' | 'interrupted';
  readonly reportedAt: number;
}

export interface VoiceSessionService {
  createSession(
    owner: VoiceOwnerContext,
    input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult>;
  status(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
  ): VoiceResult<VoiceSessionStatusDto | null>;
  closeSession(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    input: VoiceSessionCloseRequest,
  ): VoiceAsyncResult<VoiceSessionCloseResult>;
  receiveProviderEvent(input: VoiceProviderEventEnvelope): VoiceAsyncResult<void>;
  reportPlayback(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    report: VoicePlaybackReport,
  ): VoiceAsyncResult<void>;
  subscribe(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    handler: VoiceEventHandler<VoiceStatusEventDto>,
  ): VoiceResult<VoiceUnsubscribe>;
}

export interface VoiceDelegationStatusDto {
  readonly id: VoiceDelegationId;
  readonly revision: number;
  readonly status: VoiceDelegationStatus;
  readonly contextVersion: number;
  readonly execution: VoiceExecutionStatus;
  readonly output: VoiceOutputLifecycle;
  readonly outputs: readonly VoiceOutputStatusDto[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VoiceOutputStatusDto {
  /** Associates retained output history with its durable delegation. */
  readonly delegationId: VoiceDelegationId;
  readonly id: VoiceOutputId;
  readonly kind: VoiceOutputKind;
  /** Bounded, redacted result text; raw traces and reasoning never appear here. */
  readonly text?: string;
  readonly lifecycle: VoiceOutputLifecycle;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VoiceSessionStatusDto {
  readonly id: VoiceSessionId;
  readonly status: VoiceSessionStatus;
  readonly transport: VoiceTransportKind;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly deadlineAt: number;
  readonly closedAt?: number;
  /** Bounded recent history so completed results remain queryable after hangup. */
  readonly delegations: readonly VoiceDelegationStatusDto[];
  readonly activeDelegation?: VoiceDelegationStatusDto;
  readonly usage: VoiceUsageSummary;
  readonly finalization: VoiceFinalizationState;
}

export type VoiceStatusEventDto =
  | {
      readonly kind: 'session';
      readonly version: number;
      readonly session: VoiceSessionStatusDto;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'delegation';
      readonly version: number;
      readonly delegation: VoiceDelegationStatusDto;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'error';
      readonly version: number;
      readonly code: string;
      readonly message: string;
      readonly occurredAt: number;
    };

// ---------------------------------------------------------------------------
// HTTP request/response schemas
// ---------------------------------------------------------------------------

export interface VoiceLoginRequest {
  readonly accessToken: string;
}

export interface VoiceLoginResponse {
  readonly authenticated: true;
  readonly expiresAt: number;
}

export interface VoiceLogoutResponse {
  readonly loggedOut: true;
}

export interface VoiceCreateSessionHttpRequest {
  /** Checked against the server's enabled transport set; never a provider selector. */
  readonly transport: VoiceTransportKind;
}

export interface VoiceCreateSessionHttpResponse {
  readonly session: VoiceSessionStatusDto;
  readonly client: VoiceClientSessionDescriptor;
}

export interface VoiceGetSessionHttpResponse {
  readonly session: VoiceSessionStatusDto;
}

export interface VoiceCloseSessionHttpRequest {
  readonly reason: VoiceCloseReason;
}

export interface VoiceCloseSessionHttpResponse {
  readonly session: VoiceSessionStatusDto;
  readonly pendingDelegation: boolean;
}

export interface VoicePlaybackHttpRequest {
  readonly outputId: VoiceOutputId;
  readonly status: 'started' | 'played' | 'interrupted';
}

export interface VoiceErrorHttpResponse {
  /** The HTTP adapter must redact internal errors before constructing this DTO. */
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}
