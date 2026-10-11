import WebSocket from 'ws';

const API_URL = 'wss://api.openai.com/v1/live/sessions';
const MODEL = 'gpt-live-1';
const OUTPUT_VOICE = 'marin';
const MAX_BUDGET_MS = 60 * 1000;
const CLOSE_GRACE_MS = 5_000;
const FIXED_REQUEST =
  'Delegation policy: the probe backend confirms testcode731. Delegate a lookup for the fixed token ' +
  'BLUE-ORCHID-17 to the client and wait for the application result. There is no real tool, ' +
  'service, model, account, or external action. Create exactly one client delegation.';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log(JSON.stringify({ result: 'missing_api_key' }));
  process.exit(2);
}

const startedAt = Date.now();
const events = [];
const state = {
  commentaryAcknowledged: false,
  commentaryDelegationId: null,
  closeRequested: false,
  finalized: false,
  delegationCount: 0,
  delegationId: null,
  inputTranscriptFragments: 0,
  outputTranscriptFragments: 0,
  providerVoiceSeconds: null,
  startupStatus: null,
};

function elapsedMs() {
  return Date.now() - startedAt;
}

function record(type, fields = {}) {
  events.push({ at_ms: elapsedMs(), type, ...fields });
}

function summary(event) {
  const result = { provider_type: event?.type ?? 'unknown' };
  if (event?.event_id) result.event_id = event.event_id;
  if (event?.client_event_id) result.client_event_id = event.client_event_id;
  if (event?.delegation?.id) result.delegation_id = event.delegation.id;
  if (event?.delegation_id) result.delegation_id = event.delegation_id;
  if (event?.delegation?.target) result.target = event.delegation.target;
  if (Number.isFinite(event?.offset_ms)) result.offset_ms = event.offset_ms;
  if (Number.isFinite(event?.start_ms)) result.start_ms = event.start_ms;
  if (Number.isFinite(event?.end_ms)) result.end_ms = event.end_ms;
  if (Number.isFinite(event?.usage?.seconds)) result.voice_seconds = event.usage.seconds;
  if (event?.reason) result.reason = event.reason;
  if (event?.error?.code) result.error_code = event.error.code;
  if (event?.error?.type) result.error_type = event.error.type;
  return result;
}

function send(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) {
    record('send_unavailable', { command_type: event.type });
    return false;
  }
  ws.send(JSON.stringify(event));
  record('client_event_sent', { command_type: event.type, event_id: event.event_id });
  return true;
}

function closeGracefully(ws, reason) {
  if (state.closeRequested) return;
  state.closeRequested = true;
  record('close_requested', { reason });
  send(ws, {
    type: 'session.close',
    event_id: 'silent_probe_close',
  });
  setTimeout(() => {
    if (!state.finalized) {
      record('finalization_timeout');
      record('transport_terminated_after_close_grace');
      ws.terminate();
    }
  }, CLOSE_GRACE_MS).unref();
}

function printResult() {
  const result = state.finalized
    ? state.commentaryAcknowledged && state.delegationCount === 1 && state.delegationId
      ? 'technical_client_delegation_pass'
      : 'needs_context_no_delegation'
    : state.startupStatus === null
      ? 'needs_context_no_startup_result'
      : 'needs_context_incomplete_close';
  console.log(
    JSON.stringify({
      result,
      model: MODEL,
      output_voice: OUTPUT_VOICE,
      startup_status: state.startupStatus,
      delegation_observed: Boolean(state.delegationId),
      delegation_count: state.delegationCount,
      commentary_acknowledged: state.commentaryAcknowledged,
      commentary_delegation_matches:
        state.commentaryDelegationId === state.delegationId && state.delegationId !== null,
      transcript_fragments: {
        input: state.inputTranscriptFragments,
        output: state.outputTranscriptFragments,
      },
      provider_voice_seconds: state.providerVoiceSeconds,
      finalized: state.finalized,
      elapsed_ms: elapsedMs(),
      events,
    }),
  );
}

const budgetTimer = setTimeout(() => {
  record('hard_budget_timeout');
  if (socket) closeGracefully(socket, 'budget_timeout');
}, MAX_BUDGET_MS);
budgetTimer.unref();

let socket;
try {
  socket = new WebSocket(API_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
} catch {
  record('websocket_constructor_error');
  clearTimeout(budgetTimer);
  printResult();
  process.exit(1);
}

socket.on('open', () => {
  record('websocket_opened');
  const accepted = send(socket, {
    type: 'session.start',
    session: {
      model: MODEL,
      store: false,
      audio: { output: { voice: OUTPUT_VOICE } },
      delegation: { type: 'client' },
      instructions:
        'Do not speak or produce audible output for this silent technical probe. ' +
        'Follow the seeded Delegation policy: delegate the fixed lookup to the client, ' +
        'then wait for the application result. Do not answer from knowledge.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: FIXED_REQUEST }],
        },
      ],
    },
  });
  if (!accepted) closeGracefully(socket, 'session_start_send_unavailable');
});

socket.on('message', (raw, isBinary) => {
  if (isBinary) {
    record('audio_frame_ignored');
    return;
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    record('provider_event_unparseable');
    return;
  }
  const eventSummary = summary(event);
  record('provider_event', eventSummary);

  if (event.type === 'session.started') {
    state.startupStatus = 'started';
    send(socket, {
      type: 'session.instructions.append',
      event_id: 'silent_probe_trigger',
      delegation_id: null,
      content:
        'Start the seeded fake lookup now. Create one client delegation for BLUE-ORCHID-17. ' +
        'Do not speak; wait for the application acknowledgement.',
    });
  }
  if (event.type === 'session.delegation.created' && event.delegation?.id) {
    state.delegationCount += 1;
    state.delegationId = event.delegation.id;
    state.commentaryDelegationId = event.delegation.id;
    send(socket, {
      type: 'session.commentary.append',
      event_id: 'silent_probe_delegation_ack',
      delegation_id: event.delegation.id,
      content: 'Probe acknowledgement: no backend tool or external action was run.',
    });
  }
  if (
    event.type === 'session.commentary.appended' &&
    event.client_event_id === 'silent_probe_delegation_ack' &&
    state.commentaryDelegationId === state.delegationId
  ) {
    state.commentaryAcknowledged = true;
    closeGracefully(socket, 'probe_complete');
  }
  if (event.type === 'session.input_transcript.delta') state.inputTranscriptFragments += 1;
  if (event.type === 'session.output_transcript.delta') state.outputTranscriptFragments += 1;
  if (event.type === 'session.usage.updated' && Number.isFinite(event.usage?.seconds)) {
    state.providerVoiceSeconds = event.usage.seconds;
  }
  if (event.type === 'session.closed') {
    state.finalized = true;
    if (Number.isFinite(event.usage?.seconds)) state.providerVoiceSeconds = event.usage.seconds;
    clearTimeout(budgetTimer);
    setTimeout(() => {
      socket.close();
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref();
    }, 100).unref();
  }
  if (event.type === 'error' && !state.closeRequested) closeGracefully(socket, 'provider_error');
});

socket.on('error', () => record('websocket_error'));
socket.on('close', () => {
  if (!state.finalized) record('websocket_closed_before_session_closed');
  clearTimeout(budgetTimer);
  printResult();
});
