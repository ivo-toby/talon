import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const API_URL = 'wss://api.openai.com/v1/live/sessions';
const MODEL = 'gpt-live-1';
const OUTPUT_VOICE = 'marin';
const MAX_BUDGET_MS = 60 * 1000;
const CLOSE_GRACE_MS = 5_000;
const AUDIO_PATH = process.env.PROBE_AUDIO_PATH ?? null;
const AUDIO_CHUNK_BYTES = 4_800;
const AUDIO_CHUNK_MS = 100;
const TRAILING_SILENCE_CHUNKS = 10;
const FIXED_REQUEST = 'Please ask the probe backend for the status of code seven three one.';
const LIVE_INSTRUCTIONS = [
  'You are a calm, clear voice assistant for a bounded technical probe.',
  'Speak naturally and wait for the user.',
  'Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.',
  'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
  'Delegation policy:',
  'Backend tools:',
  '- Probe status: the probe backend knows the status of code731.',
  'Delegate to the backend when:',
  '- The user asks for the status of code731 or asks for a probe backend lookup.',
  '- The request needs the probe backend capability.',
  'Do not delegate to the backend when:',
  '- The user greets you or asks you to repeat a result already provided.',
  '- You cannot tell what they are asking for without a brief clarification.',
  'Delegate before giving an answer that depends on backend work.',
  'Do not guess the result while waiting.',
].join('\n');

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
  commentaryEventId: null,
  closeRequested: false,
  finalized: false,
  delegationCount: 0,
  delegationId: null,
  delegationOffsetMs: null,
  delegationTarget: null,
  inputTranscriptFragments: 0,
  inputTranscriptStartMs: null,
  inputTranscriptEndMs: null,
  inputTranscriptCharacters: 0,
  outputTranscriptFragments: 0,
  outputTranscriptStartMs: null,
  outputTranscriptEndMs: null,
  audioChunksSent: 0,
  audioBytesSent: 0,
  audioStreamFinished: false,
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

function sendAudioChunk(ws, bytes) {
  if (ws.readyState !== WebSocket.OPEN || state.closeRequested) return false;
  ws.send(
    JSON.stringify({
      type: 'session.input_audio.append',
      audio: bytes.toString('base64'),
    }),
  );
  state.audioChunksSent += 1;
  state.audioBytesSent += bytes.length;
  return true;
}

async function readPcm16(path) {
  const file = await readFile(path);
  if (
    file.length < 12 ||
    file.toString('ascii', 0, 4) !== 'RIFF' ||
    file.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    if (file.length % 2 !== 0) throw new Error('pcm_input_odd_byte_length');
    return file;
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= file.length) {
    const chunkType = file.toString('ascii', offset, offset + 4);
    const chunkSize = file.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > file.length) throw new Error('wav_chunk_out_of_bounds');
    if (chunkType === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: file.readUInt16LE(chunkStart),
        channels: file.readUInt16LE(chunkStart + 2),
        sampleRate: file.readUInt32LE(chunkStart + 4),
        bitsPerSample: file.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkType === 'data') data = file.subarray(chunkStart, chunkEnd);
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!format || !data) throw new Error('wav_missing_pcm_data');
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 24_000 ||
    format.bitsPerSample !== 16
  ) {
    throw new Error('wav_not_mono_pcm16_24khz');
  }
  return data;
}

async function streamAudio(ws) {
  if (!AUDIO_PATH) throw new Error('missing_probe_audio_path');
  const pcm = await readPcm16(AUDIO_PATH);
  record('audio_stream_started', {
    request: FIXED_REQUEST,
    bytes: pcm.length,
    chunk_bytes: AUDIO_CHUNK_BYTES,
    chunk_ms: AUDIO_CHUNK_MS,
  });
  for (let offset = 0; offset < pcm.length; offset += AUDIO_CHUNK_BYTES) {
    if (!sendAudioChunk(ws, pcm.subarray(offset, Math.min(offset + AUDIO_CHUNK_BYTES, pcm.length))))
      break;
    await sleep(AUDIO_CHUNK_MS);
  }
  const silence = Buffer.alloc(AUDIO_CHUNK_BYTES);
  for (let index = 0; index < TRAILING_SILENCE_CHUNKS; index += 1) {
    if (!sendAudioChunk(ws, silence)) break;
    await sleep(AUDIO_CHUNK_MS);
  }
  state.audioStreamFinished = true;
  record('audio_stream_finished', {
    chunks: state.audioChunksSent,
    bytes: state.audioBytesSent,
    trailing_silence_chunks: TRAILING_SILENCE_CHUNKS,
  });
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
      delegation_offset_ms: state.delegationOffsetMs,
      delegation_target: state.delegationTarget,
      commentary_acknowledged: state.commentaryAcknowledged,
      commentary_delegation_matches:
        state.commentaryDelegationId === state.delegationId && state.delegationId !== null,
      transcript_fragments: {
        input: state.inputTranscriptFragments,
        input_start_ms: state.inputTranscriptStartMs,
        input_end_ms: state.inputTranscriptEndMs,
        input_characters: state.inputTranscriptCharacters,
        output: state.outputTranscriptFragments,
        output_start_ms: state.outputTranscriptStartMs,
        output_end_ms: state.outputTranscriptEndMs,
      },
      audio: {
        path_supplied: Boolean(AUDIO_PATH),
        chunks_sent: state.audioChunksSent,
        bytes_sent: state.audioBytesSent,
        stream_finished: state.audioStreamFinished,
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
      delegation: { type: 'client' },
      instructions: LIVE_INSTRUCTIONS,
      audio: {
        format: { type: 'audio/pcm', rate: 24_000 },
        output: { voice: OUTPUT_VOICE },
      },
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
    void streamAudio(socket).catch((error) => {
      record('audio_stream_failed', { error: error?.message ?? 'unknown' });
      closeGracefully(socket, 'audio_stream_failed');
    });
  }
  if (event.type === 'session.delegation.created' && event.delegation?.id) {
    state.delegationCount += 1;
    state.delegationId = event.delegation.id;
    state.delegationOffsetMs = Number.isFinite(event.offset_ms) ? event.offset_ms : null;
    state.delegationTarget = event.delegation.target ?? null;
    state.commentaryDelegationId = event.delegation.id;
    state.commentaryEventId = 'silent_probe_delegation_ack';
    send(socket, {
      type: 'session.commentary.append',
      event_id: state.commentaryEventId,
      delegation_id: event.delegation.id,
      content: 'The probe received the request. No backend tool or external action was run.',
    });
  }
  if (
    event.type === 'session.commentary.appended' &&
    event.client_event_id === state.commentaryEventId &&
    state.commentaryDelegationId === state.delegationId
  ) {
    state.commentaryAcknowledged = true;
    closeGracefully(socket, 'probe_complete');
  }
  if (event.type === 'session.input_transcript.delta') {
    state.inputTranscriptFragments += 1;
    state.inputTranscriptCharacters += typeof event.delta === 'string' ? event.delta.length : 0;
    if (Number.isFinite(event.start_ms)) {
      state.inputTranscriptStartMs =
        state.inputTranscriptStartMs === null
          ? event.start_ms
          : Math.min(state.inputTranscriptStartMs, event.start_ms);
    }
    if (Number.isFinite(event.end_ms)) {
      state.inputTranscriptEndMs =
        state.inputTranscriptEndMs === null
          ? event.end_ms
          : Math.max(state.inputTranscriptEndMs, event.end_ms);
    }
  }
  if (event.type === 'session.output_transcript.delta') {
    state.outputTranscriptFragments += 1;
    if (Number.isFinite(event.start_ms)) {
      state.outputTranscriptStartMs =
        state.outputTranscriptStartMs === null
          ? event.start_ms
          : Math.min(state.outputTranscriptStartMs, event.start_ms);
    }
    if (Number.isFinite(event.end_ms)) {
      state.outputTranscriptEndMs =
        state.outputTranscriptEndMs === null
          ? event.end_ms
          : Math.max(state.outputTranscriptEndMs, event.end_ms);
    }
  }
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
