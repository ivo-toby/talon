import { sendDaemonControlCommand } from './daemon-control.js';

type LifecycleAction = 'handlers' | 'inspect' | 'replay' | 'disable' | 'candidates';

export interface LifecycleCommandOptions {
  readonly action: LifecycleAction;
  readonly ipcDir?: string;
  readonly timeoutMs?: number;
  readonly limit?: number;
  readonly eventId?: string;
  readonly handlerId?: string;
  readonly persona?: string;
}

interface LifecycleBacklogSummary {
  readonly pending?: number;
  readonly claimed?: number;
  readonly failed?: number;
  readonly completed?: number;
  readonly dead_letter?: number;
}

interface LifecycleBacklogTiming {
  readonly oldestCreatedAt?: number | null;
  readonly oldestAgeMs?: number | null;
  readonly nextRetryAt?: number | null;
}

interface LifecycleHandlerSummary {
  readonly handlerId: string;
  readonly displayName?: string;
  readonly mode?: string;
  readonly runtimeKind?: string;
  readonly personas?: readonly string[];
  readonly subscriptions?: number;
  readonly backlog?: LifecycleBacklogSummary;
  readonly timing?: LifecycleBacklogTiming;
  readonly circuit?: string;
}

interface LifecycleHandlersData {
  readonly lifecycleEnabled?: boolean;
  readonly dispatcher?: {
    readonly running?: boolean;
    readonly stopping?: boolean;
    readonly inFlight?: number;
    readonly handlers?: readonly { readonly handlerId: string; readonly circuit?: string }[];
  };
  readonly backlog?: LifecycleBacklogSummary;
  readonly handlers?: readonly LifecycleHandlerSummary[];
}

interface LifecycleDeliveryRowData {
  readonly eventId?: string;
  readonly handlerId?: string;
  readonly persona?: string;
  readonly status?: string;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly nextRetryAt?: number | null;
  readonly lastErrorCode?: string | null;
  readonly tombstoneReason?: string | null;
}

interface LifecycleInspectData {
  readonly event?: {
    readonly eventId?: string;
    readonly type?: string;
    readonly aggregateType?: string;
    readonly aggregateId?: string;
    readonly retentionTombstoneReason?: string | null;
    readonly createdAt?: number;
  } | null;
  readonly deliveries?: readonly LifecycleDeliveryRowData[];
}

interface LifecycleCandidateSummary {
  readonly candidateId: string;
  readonly status?: string;
  readonly kind?: string;
  readonly confidence?: number;
  readonly evidenceSources?: number;
  readonly summary?: string;
}

interface LifecycleCandidatesData {
  readonly persona?: string;
  readonly candidates?: readonly LifecycleCandidateSummary[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function lifecycleCommand(options: LifecycleCommandOptions): Promise<void> {
  const limit = normalizeLimit(options.limit);
  const payload = payloadForAction(options, limit);
  if (payload === null) return;

  const response = await sendDaemonControlCommand(commandForAction(options.action), payload, {
    ipcDir: options.ipcDir,
    timeoutMs: options.timeoutMs,
  });

  if (!response) {
    fail('Daemon did not respond within timeout.\nIs talond running?');
    return;
  }
  if (!response.success) {
    fail(response.error ?? 'Unknown daemon error');
    return;
  }

  renderLifecycleResponse(options.action, response.data ?? {});
}

function commandForAction(action: LifecycleAction) {
  switch (action) {
    case 'handlers':
      return 'lifecycle-handlers' as const;
    case 'inspect':
      return 'lifecycle-inspect' as const;
    case 'replay':
      return 'lifecycle-replay' as const;
    case 'disable':
      return 'lifecycle-disable' as const;
    case 'candidates':
      return 'lifecycle-candidates' as const;
  }
}

function payloadForAction(
  options: LifecycleCommandOptions,
  limit: number,
): Record<string, unknown> | null {
  switch (options.action) {
    case 'handlers':
      return { limit };
    case 'inspect':
      if (!options.eventId) return fail('event id is required for lifecycle inspect');
      return {
        eventId: options.eventId,
        ...(options.handlerId ? { handlerId: options.handlerId } : {}),
      };
    case 'replay':
      if (!options.eventId) return fail('event id is required for lifecycle replay');
      if (!options.handlerId) return fail('handler id is required for lifecycle replay');
      return { eventId: options.eventId, handlerId: options.handlerId };
    case 'disable':
      if (!options.handlerId) return fail('handler id is required for lifecycle disable');
      return { handlerId: options.handlerId };
    case 'candidates':
      if (!options.persona) return fail('persona is required for lifecycle candidates');
      return { persona: options.persona, limit };
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function fail(message: string): null {
  for (const line of message.split('\n')) console.error(`Error: ${line}`);
  process.exit(1);
  return null;
}

function renderLifecycleResponse(action: LifecycleAction, data: Record<string, unknown>): void {
  switch (action) {
    case 'handlers':
      renderHandlers(data as LifecycleHandlersData);
      break;
    case 'inspect':
      renderInspect(data as LifecycleInspectData);
      break;
    case 'replay':
      renderReplay(data as LifecycleDeliveryRowData);
      break;
    case 'disable':
      renderDisable(data as { handlerId?: string; disabledDeliveries?: number });
      break;
    case 'candidates':
      renderCandidates(data as LifecycleCandidatesData);
      break;
  }
}

function renderHandlers(data: LifecycleHandlersData): void {
  console.log('Lifecycle handlers');
  console.log('------------------');
  console.log(`Enabled: ${data.lifecycleEnabled === false ? 'no' : 'yes'}`);
  const dispatcher = data.dispatcher;
  if (dispatcher) {
    console.log(
      `Dispatcher: ${dispatcher.running ? 'running' : 'stopped'}, in-flight=${dispatcher.inFlight ?? 0}`,
    );
  }
  if (data.backlog) console.log(`Backlog: ${formatBacklog(data.backlog)}`);
  const handlers = data.handlers ?? [];
  if (handlers.length === 0) {
    console.log('No configured lifecycle handlers.');
    return;
  }
  for (const handler of handlers) {
    console.log(
      [
        handler.handlerId,
        handler.displayName ? `(${handler.displayName})` : '',
        `mode=${handler.mode ?? 'unknown'}`,
        `runtime=${handler.runtimeKind ?? 'unknown'}`,
        `personas=${(handler.personas ?? []).join(',') || '-'}`,
        `subscriptions=${handler.subscriptions ?? 0}`,
        `backlog=${formatBacklog(handler.backlog ?? {})}`,
        `lag=${formatDurationMs(handler.timing?.oldestAgeMs)}`,
        `oldest=${formatTimestamp(handler.timing?.oldestCreatedAt)}`,
        `nextRetry=${formatTimestamp(handler.timing?.nextRetryAt)}`,
        `circuit=${handler.circuit ?? 'closed'}`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}

function renderInspect(data: LifecycleInspectData): void {
  console.log('Lifecycle delivery inspection');
  console.log('-----------------------------');
  if (!data.event) {
    console.log('Event: not found');
    return;
  }
  console.log(`Event: ${data.event.eventId ?? 'unknown'}`);
  console.log(`Type: ${data.event.type ?? 'unknown'}`);
  console.log(
    `Aggregate: ${data.event.aggregateType ?? 'unknown'}:${data.event.aggregateId ?? 'unknown'}`,
  );
  console.log(`Retention: ${data.event.retentionTombstoneReason ?? 'active'}`);
  const deliveries = data.deliveries ?? [];
  if (deliveries.length === 0) {
    console.log('Deliveries: none');
    return;
  }
  console.log('Deliveries:');
  for (const delivery of deliveries) {
    console.log(`- ${formatDelivery(delivery)}`);
  }
}

function renderReplay(data: LifecycleDeliveryRowData): void {
  console.log('Reopened lifecycle delivery.');
  console.log(`Event: ${data.eventId ?? 'unknown'}`);
  console.log(`Handler: ${data.handlerId ?? 'unknown'}`);
  console.log(`Status: ${data.status ?? 'unknown'}`);
  console.log(`Attempts: ${data.attempts ?? 0}/${data.maxAttempts ?? '?'}`);
}

function renderDisable(data: { handlerId?: string; disabledDeliveries?: number }): void {
  console.log(`Disabled lifecycle handler "${data.handlerId ?? 'unknown'}".`);
  console.log(`Disabled deliveries: ${data.disabledDeliveries ?? 0}`);
}

function renderCandidates(data: LifecycleCandidatesData): void {
  const persona = data.persona ?? 'unknown';
  console.log(`Behavior candidates for "${persona}"`);
  console.log('------------------------------');
  const candidates = data.candidates ?? [];
  if (candidates.length === 0) {
    console.log('No behavior candidates found.');
    return;
  }
  for (const candidate of candidates) {
    console.log(
      [
        candidate.candidateId,
        `status=${candidate.status ?? 'unknown'}`,
        `kind=${candidate.kind ?? 'unknown'}`,
        `confidence=${formatConfidence(candidate.confidence)}`,
        `evidence=${candidate.evidenceSources ?? 0}`,
        candidate.summary ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}

function formatBacklog(backlog: LifecycleBacklogSummary): string {
  return [
    `pending=${backlog.pending ?? 0}`,
    `claimed=${backlog.claimed ?? 0}`,
    `failed=${backlog.failed ?? 0}`,
    `completed=${backlog.completed ?? 0}`,
    `dead_letter=${backlog.dead_letter ?? 0}`,
  ].join(' ');
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '-';
  if (value < 1_000) return `${Math.trunc(value)}ms`;
  const totalSeconds = Math.floor(value / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

function formatTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '-' : timestamp.toISOString();
}

function formatDelivery(delivery: LifecycleDeliveryRowData): string {
  return [
    delivery.handlerId ?? 'unknown',
    `persona=${delivery.persona ?? 'unknown'}`,
    `status=${delivery.status ?? 'unknown'}`,
    `attempts=${delivery.attempts ?? 0}/${delivery.maxAttempts ?? '?'}`,
    delivery.nextRetryAt === undefined || delivery.nextRetryAt === null
      ? ''
      : `nextRetryAt=${delivery.nextRetryAt}`,
    delivery.lastErrorCode ? `error=${delivery.lastErrorCode}` : '',
    delivery.tombstoneReason ? `tombstone=${delivery.tombstoneReason}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function formatConfidence(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown';
}
