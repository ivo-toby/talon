import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PROBE_PORT ?? 8787);
const API_BASE = 'https://api.openai.com';
const MODEL = 'gpt-live-1';
const OUTPUT_VOICE = 'marin';
const MAX_BUDGET_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const HANGUP_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 5_000;
const MAX_EVENTS = 250;
const SYNTHETIC_AUDIO_PATH = process.env.PROBE_AUDIO_PATH ?? null;
const SYNTHETIC_REQUEST = 'Please ask the probe backend for the status of code seven three one.';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('probe=missing_OPENAI_API_KEY');
  process.exit(2);
}

const page = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TASK-01 GPT-Live probe</title>
  <style>
    body { font: 16px system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    button { margin: .25rem; padding: .5rem .75rem; }
    button:disabled { opacity: .45; }
    #state { white-space: pre-wrap; background: #f4f4f4; padding: .75rem; }
    #events { height: 24rem; overflow: auto; background: #111; color: #ddd; padding: .75rem; }
    .warn { color: #8a3b00; }
  </style>
</head>
<body>
  <h1>TASK-01 GPT-Live probe</h1>
  <p class="warn">Disposable probe. No Talon daemon, persona, queue, MCP, native tool, or external action is connected.</p>
  <p id="manual-instructions">Click start, allow microphone access, and speak the two short Dutch turns below. The page records event types and timing only, not transcript text or audio.</p>
  <p id="synthetic-instructions" hidden>The synthetic mode writes a fixed request to a local audio file, streams it through a Web Audio media-stream destination, and never connects that destination or provider output to a speaker.</p>
  <ol>
    <li id="manual-step-one">Zeg: “Vertel kort iets over Amsterdam.”</li>
    <li id="manual-step-two">Onderbreek de hoorbare respons met: “Nee, ik bedoel Rotterdam.”</li>
    <li id="manual-step-three">Gebruik <strong>mute input</strong> niet als vervanging voor deze hoorbare onderbreking.</li>
    <li>Klik na de waarneming op <strong>Close session</strong>.</li>
  </ol>
  <p>
    <button id="start">Start GPT-Live session</button>
    <button id="status" disabled>Send sideband status</button>
    <button id="mutation" disabled>Attempt client backend mutation</button>
    <button id="mute" disabled>Mute input</button>
    <button id="unmute" disabled>Unmute input</button>
    <button id="close" disabled>Close session</button>
  </p>
  <pre id="state">state=idle</pre>
  <pre id="events"></pre>
  <audio id="audio" autoplay></audio>
  <script>
    let pc;
    let dc;
    let microphone;
    let syntheticContext;
    let syntheticSource;
    let syntheticDestination;
    let syntheticStart;
    let syntheticStarted = false;
    let providerStarted = false;
    let dataChannelOpen = false;
    let sidebandReady = false;
    let syntheticCloseTimer;
    let sessionId;
    let closed = false;
    let mutationSent = false;
    let renderedEventCount = 0;
    const syntheticMode = new URLSearchParams(location.search).get("mode") === "synthetic";
    const state = document.querySelector("#state");
    const events = document.querySelector("#events");
    const audio = document.querySelector("#audio");
    const manualInstructions = document.querySelector("#manual-instructions");
    const syntheticInstructions = document.querySelector("#synthetic-instructions");
    const buttons = {
      start: document.querySelector("#start"),
      status: document.querySelector("#status"),
      mutation: document.querySelector("#mutation"),
      mute: document.querySelector("#mute"),
      unmute: document.querySelector("#unmute"),
      close: document.querySelector("#close"),
    };

    function write(line) {
      events.textContent += line + "\\n";
      events.scrollTop = events.scrollHeight;
    }

    function eventSummary(event) {
      const summary = { type: event?.type ?? "unknown" };
      if (event?.event_id) summary.event_id = event.event_id;
      if (Number.isFinite(event?.offset_ms)) summary.offset_ms = event.offset_ms;
      if (Number.isFinite(event?.start_ms)) summary.start_ms = event.start_ms;
      if (Number.isFinite(event?.end_ms)) summary.end_ms = event.end_ms;
      if (typeof event?.delta === "string") summary.delta_chars = event.delta.length;
      if (event?.delegation?.id) summary.delegation_id = event.delegation.id;
      if (event?.delegation?.target) summary.target = event.delegation.target;
      if (Number.isFinite(event?.usage?.seconds)) summary.voice_seconds = event.usage.seconds;
      if (event?.reason) summary.reason = event.reason;
      if (event?.error?.code) summary.error_code = event.error.code;
      if (event?.client_event_id) summary.client_event_id = event.client_event_id;
      return summary;
    }

    function receive(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        write("browser event=unparseable");
        return;
      }
      write("browser " + JSON.stringify(eventSummary(event)));
      if (event.type === "session.started") {
        providerStarted = true;
        maybeStartSynthetic();
      }
      if (event.type === "session.closed") {
        closed = true;
        buttons.close.disabled = true;
        cleanup();
      }
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "probe request failed");
      return result;
    }

    function setActive(active) {
      for (const button of [buttons.status, buttons.mutation, buttons.mute, buttons.unmute, buttons.close]) {
        button.disabled = !active;
      }
    }

    function cleanup(stopInput = true) {
      if (stopInput) microphone?.getTracks().forEach((track) => track.stop());
      if (stopInput) {
        if (syntheticSource) {
          try {
            syntheticSource.stop();
          } catch {
            // The source may already have ended.
          }
          syntheticSource.disconnect();
          syntheticSource = undefined;
        }
        syntheticDestination?.stream.getTracks().forEach((track) => track.stop());
        syntheticDestination = undefined;
        void syntheticContext?.close();
        syntheticContext = undefined;
      }
      if (syntheticCloseTimer) clearTimeout(syntheticCloseTimer);
      if (dc && dc.readyState !== "closed") dc.close();
      if (pc && pc.connectionState !== "closed") pc.close();
      if (stopInput) setActive(false);
    }

    async function createSyntheticInput() {
      const response = await fetch("/synthetic-audio");
      if (!response.ok) throw new Error("synthetic_audio_unavailable");
      const encoded = await response.arrayBuffer();
      const context = new AudioContext();
      await context.resume();
      const buffer = await context.decodeAudioData(encoded);
      const destination = context.createMediaStreamDestination();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.onended = () => write("browser synthetic_audio=ended");
      syntheticContext = context;
      syntheticDestination = destination;
      syntheticSource = source;
      write("browser synthetic_audio=media_stream_destination_only");
      return {
        track: destination.stream.getAudioTracks()[0],
        start() {
          if (syntheticStarted) return;
          syntheticStarted = true;
          source.start();
          write("browser synthetic_audio=started_after_session_ready");
          syntheticCloseTimer = setTimeout(() => void command("close"), 45_000);
        },
      };
    }

    function maybeStartSynthetic() {
      if (!syntheticMode || syntheticStarted || !syntheticStart) return;
      if (!providerStarted || !dataChannelOpen || !sidebandReady) return;
      syntheticStart();
      setTimeout(() => void sendClientMutation(), 1_000);
    }

    async function sendClientMutation() {
      if (mutationSent) return;
      if (!dc || dc.readyState !== "open") {
        write("browser client_mutation=unavailable");
        return;
      }
      mutationSent = true;
      await post("/client-mutation-sent", { sessionId }).catch(() => {
        write("browser client_mutation=timing_record_unavailable");
      });
      if (dc.readyState !== "open") {
        write("browser client_mutation=unavailable_after_timing");
        return;
      }
      dc.send(JSON.stringify({
        type: "session.update",
        event_id: "probe_client_mutation",
        session: {
          delegation: {
            type: "responses",
            responses: { model: "gpt-6-luna" },
          },
        },
      }));
      write("browser client_mutation=data_channel_sent");
    }

    async function start() {
      buttons.start.disabled = true;
      state.textContent = syntheticMode ? "state=requesting_synthetic_audio" : "state=requesting_microphone";
      try {
        const syntheticInput = syntheticMode ? await createSyntheticInput() : null;
        const inputTrack = syntheticMode
          ? syntheticInput.track
          : (microphone = await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
        syntheticStart = syntheticInput?.start;
        pc = new RTCPeerConnection();
        pc.ontrack = (event) => {
          if (syntheticMode) {
            for (const track of event.streams[0]?.getAudioTracks() ?? []) track.enabled = false;
            write("browser remote_audio=discarded");
            return;
          }
          audio.srcObject = event.streams[0];
          audio.play().catch(() => write("browser audio=autoplay_pending"));
        };
        pc.onconnectionstatechange = () => {
          state.textContent = "state=connection_" + pc.connectionState;
        };
        dc = pc.createDataChannel("oai-events");
        dc.onopen = () => {
          dataChannelOpen = true;
          write("browser data_channel=open");
          maybeStartSynthetic();
        };
        dc.onclose = () => write("browser data_channel=closed");
        dc.onmessage = (event) => receive(event.data);
        pc.addTrack(inputTrack);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const created = await post("/session", {
          sdp: offer.sdp,
          mode: syntheticMode ? "synthetic" : "manual",
        });
        sessionId = created.session.id;
        await pc.setRemoteDescription({ type: "answer", sdp: created.transport.sdp });
        await post("/attach", { sessionId });
        state.textContent = "state=connected session_id=" + sessionId;
        setActive(true);
        write("probe session=created model=" + "${MODEL}" + " mode=" + (syntheticMode ? "synthetic" : "manual"));
      } catch (error) {
        state.textContent = "state=failed";
        write("probe start_error=" + (error?.message ?? "unknown"));
        cleanup();
        buttons.start.disabled = false;
      }
    }

    async function command(name) {
      try {
        const result = await post("/command", { name });
        write("probe command=" + name + " accepted=" + (result.accepted ? "yes" : "no"));
      } catch (error) {
        write("probe command=" + name + " error=" + (error?.message ?? "unknown"));
      }
    }

    buttons.start.onclick = start;
    buttons.status.onclick = () => command("status");
    buttons.mutation.onclick = () => void sendClientMutation();
    buttons.mute.onclick = () => command("mute");
    buttons.unmute.onclick = () => command("unmute");
    buttons.close.onclick = () => command("close");

    setInterval(async () => {
      const result = await fetch("/state").then((response) => response.json()).catch(() => null);
      if (!result) return;
      sidebandReady = result.sideband_ready === true;
      maybeStartSynthetic();
      if (result.cleanup_required && !closed) {
        closed = true;
        write("browser cleanup=forced_after_incomplete_finalization");
        cleanup();
      }
      state.textContent = "state=" + result.state
        + " budget_elapsed_ms=" + result.budget_elapsed_ms
        + " budget_remaining_ms=" + result.budget_remaining_ms
        + " provider_voice_seconds=" + (result.voice_seconds ?? "unknown")
        + " finalized=" + (result.finalized ? "yes" : "no");
    }, 1000);

    setInterval(async () => {
      const result = await fetch("/events").then((response) => response.json()).catch(() => null);
      if (!result) return;
      for (const item of result.events.slice(renderedEventCount)) {
        write("server " + JSON.stringify(item));
      }
      renderedEventCount = result.events.length;
    }, 1000);

    if (syntheticMode) {
      manualInstructions.hidden = true;
      syntheticInstructions.hidden = false;
      for (const id of ["#manual-step-one", "#manual-step-two", "#manual-step-three"]) {
        document.querySelector(id).hidden = true;
      }
      buttons.start.textContent = "Start synthetic probe";
    }
  </script>
</body>
</html>`;

const state = {
  budgetStartedAt: null,
  budgetTimer: null,
  createAttempted: false,
  active: null,
  invalidAttempted: false,
  events: [],
};

function now() {
  return Date.now();
}

function elapsedMs() {
  return state.budgetStartedAt === null ? 0 : now() - state.budgetStartedAt;
}

function remainingMs() {
  return Math.max(0, MAX_BUDGET_MS - elapsedMs());
}

function record(type, fields = {}) {
  const entry = { at_ms: elapsedMs(), type, ...fields };
  state.events.push(entry);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
  });
  response.end(encoded);
}

function text(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body) return {};
  return JSON.parse(body);
}

async function openAi(requestPath, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(API_BASE + requestPath, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function providerEventSummary(event) {
  const summary = { source: 'sideband', provider_type: event?.type ?? 'unknown' };
  if (event?.event_id) summary.event_id = event.event_id;
  if (Number.isFinite(event?.offset_ms)) summary.offset_ms = event.offset_ms;
  if (Number.isFinite(event?.start_ms)) summary.start_ms = event.start_ms;
  if (Number.isFinite(event?.end_ms)) summary.end_ms = event.end_ms;
  if (typeof event?.delta === 'string') summary.delta_chars = event.delta.length;
  if (event?.delegation?.id) summary.delegation_id = event.delegation.id;
  if (event?.delegation_id) summary.delegation_id = event.delegation_id;
  if (event?.delegation?.target) summary.target = event.delegation.target;
  if (Number.isFinite(event?.usage?.seconds)) summary.voice_seconds = event.usage.seconds;
  if (event?.reason) summary.reason = event.reason;
  if (event?.client_event_id) summary.client_event_id = event.client_event_id;
  if (event?.error?.code) summary.error_code = event.error.code;
  if (event?.error?.type) summary.error_type = event.error.type;
  if (event?.error?.event_id) summary.error_event_id = event.error.event_id;
  if (event?.error?.client_event_id) summary.error_client_event_id = event.error.client_event_id;
  if (event?.type === 'response.event' && event.event?.type) {
    summary.nested_provider_type = event.event.type;
  }
  return summary;
}

function sendSideband(event) {
  const sideband = state.active?.sideband;
  if (!sideband || sideband.readyState !== WebSocket.OPEN) {
    record('sideband_send_unavailable', { command_type: event.type });
    return false;
  }
  sideband.send(JSON.stringify(event));
  record('sideband_command_sent', { command_type: event.type, event_id: event.event_id });
  return true;
}

function startBudget() {
  if (state.budgetStartedAt !== null) return;
  state.budgetStartedAt = now();
  state.budgetTimer = setTimeout(() => {
    record('hard_budget_timeout');
    void closeSession('budget_timeout', true);
  }, MAX_BUDGET_MS);
}

async function requestHangup(active, reason) {
  if (active.hangupAttempted || !active.sessionId) return;
  active.hangupAttempted = true;
  try {
    const response = await openAi(
      `/v1/live/sessions/${encodeURIComponent(active.sessionId)}/hangup`,
      { method: 'POST' },
      HANGUP_TIMEOUT_MS,
    );
    record('rest_hangup', { status: response.status, reason });
  } catch {
    record('rest_hangup', { status: 'network_or_timeout', reason });
  }
}

async function closeSession(reason, force = false) {
  const active = state.active;
  if (!active) return;
  if (active.finalizationPromise) return active.finalizationPromise;
  if (active.finalized) return;
  active.finalizationPromise = new Promise((resolve) => {
    active.resolveFinalization = resolve;
  });
  active.closeRequested = true;
  record('close_requested', { reason, force });
  const sent = sendSideband({
    type: 'session.close',
    event_id: `probe_close_${randomUUID()}`,
  });
  if (!sent && active.sessionId) {
    await requestHangup(active, 'sideband_unavailable');
  }
  active.finalizationTimer = setTimeout(
    async () => {
      if (state.active?.sessionId === active.sessionId && !active.finalized) {
        record('finalization_timeout');
        active.finalized = false;
        active.finalizationTimedOut = true;
        await requestHangup(active, 'finalization_timeout');
        active.sideband?.close();
      }
      active.resolveFinalization?.();
      active.resolveFinalization = null;
    },
    force ? 1_000 : CLOSE_GRACE_MS,
  );
  return active.finalizationPromise;
}

function attachSideband(sessionId) {
  const sidebandUrl = `${API_BASE}/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const sideband = new WebSocket(sidebandUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  state.active.sideband = sideband;
  sideband.on('open', () => {
    state.active.sidebandReady = true;
    record('sideband_opened');
  });
  sideband.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      record('sideband_event_unparseable');
      return;
    }
    record('provider_event', providerEventSummary(event));
    if (event.type === 'session.input_transcript.delta') state.active.inputTranscriptFragments += 1;
    if (event.type === 'session.output_transcript.delta')
      state.active.outputTranscriptFragments += 1;
    if (event.type === 'session.usage.updated' && Number.isFinite(event.usage?.seconds)) {
      state.active.voiceSeconds = event.usage.seconds;
    }
    if (event.type === 'session.delegation.created' && event.delegation?.id) {
      state.active.delegationIds.push(event.delegation.id);
      if (Number.isFinite(event.offset_ms)) state.active.delegationOffsetMs = event.offset_ms;
      if (!state.active.delegationReplySent) {
        state.active.delegationReplySent = true;
        const eventId = `probe_delegation_observed_${randomUUID()}`;
        state.active.commentaryEventId = eventId;
        sendSideband({
          type: 'session.commentary.append',
          event_id: eventId,
          delegation_id: event.delegation.id,
          content: 'De proef heeft de aanvraag ontvangen. Er wordt geen backendactie uitgevoerd.',
        });
      }
    }
    if (
      event.type === 'session.commentary.appended' &&
      event.client_event_id === state.active.commentaryEventId
    ) {
      state.active.commentaryAcknowledged = true;
    }
    if (event.type === 'session.updated' && event.client_event_id === 'probe_client_mutation') {
      record('client_mutation_unexpectedly_accepted');
      void closeSession('unexpected_client_mutation_acceptance', true);
    }
    const mutationErrorHasId =
      event.client_event_id === 'probe_client_mutation' ||
      event.error?.client_event_id === 'probe_client_mutation' ||
      event.error?.event_id === 'probe_client_mutation' ||
      event.event_id === 'probe_client_mutation';
    const mutationErrorIsTemporallyCorrelated =
      event.type === 'error' &&
      event.error?.code === 'immutable_field_update' &&
      state.active.clientMutationSentAt !== null;
    if (event.type === 'error' && (mutationErrorHasId || mutationErrorIsTemporallyCorrelated)) {
      state.active.clientMutationRejected = true;
      state.active.clientMutationCorrelation = mutationErrorHasId ? 'client_event_id' : 'temporal';
      record('client_mutation_rejected', {
        error_code: event.error?.code ?? 'unknown',
        correlation: state.active.clientMutationCorrelation,
      });
    }
    if (event.type === 'session.closed') {
      state.active.finalized = true;
      state.active.closeReason = event.reason ?? 'unknown';
      if (Number.isFinite(event.usage?.seconds)) state.active.voiceSeconds = event.usage.seconds;
      if (state.budgetTimer) clearTimeout(state.budgetTimer);
      state.budgetTimer = null;
      if (state.active.finalizationTimer) clearTimeout(state.active.finalizationTimer);
      state.active.finalizationTimer = null;
      record('session_finalized', {
        reason: state.active.closeReason,
        voice_seconds: state.active.voiceSeconds ?? null,
      });
      state.active.resolveFinalization?.();
      state.active.resolveFinalization = null;
      setTimeout(() => state.active?.sideband?.close(), 250);
    }
  });
  sideband.on('error', () => record('sideband_error'));
  sideband.on('close', () => {
    state.active.sidebandReady = false;
    record('sideband_closed');
  });
}

async function createLiveSession(offerSdp, syntheticMode) {
  startBudget();
  if (remainingMs() <= 0) throw new Error('budget_exhausted');
  const body = {
    session: {
      model: MODEL,
      store: false,
      delegation: { type: 'client' },
      audio: { output: { voice: OUTPUT_VOICE } },
      instructions: syntheticMode
        ? 'You are a calm, clear voice assistant for a bounded technical probe. ' +
          'Speak naturally and wait for the user. ' +
          'Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response. ' +
          'Interruption policy: Stop speaking when the user interrupts. Listen to what they say. ' +
          'Delegation policy:\n' +
          'Backend tools:\n' +
          '- Probe status: the probe backend knows the status of code731.\n' +
          'Delegate to the backend when:\n' +
          '- The user asks for the status of code731 or asks for a probe backend lookup.\n' +
          '- The request needs the probe backend capability.\n' +
          'Do not delegate to the backend when:\n' +
          '- The user greets you or asks you to repeat a result already provided.\n' +
          '- You cannot tell what they are asking for without a brief clarification.\n' +
          'Delegate before giving an answer that depends on backend work. ' +
          'Do not guess the result while waiting. The fixed test utterance is: ' +
          SYNTHETIC_REQUEST
        : 'Spreek kort Nederlands. Dit is een begrensde connectiviteitsproef. ' +
          'Beantwoord de gebruiker direct. Gebruik clientdelegatie voor de eerste aanvraag ' +
          'en wacht op een korte bevestiging; er is geen backendactie of externe actie beschikbaar.',
    },
    transport: { type: 'webrtc', sdp: offerSdp },
  };
  const response = await openAi('/v1/live/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    record('session_create_failed', { status: response.status });
    throw new Error('live_session_create_failed');
  }
  if (!data.session?.id || !data.transport?.sdp) {
    record('session_create_invalid_response', { status: response.status });
    throw new Error('live_session_response_missing_fields');
  }
  state.active = {
    sessionId: data.session.id,
    sideband: null,
    sidebandReady: false,
    closeRequested: false,
    finalized: false,
    finalizationTimedOut: false,
    finalizationPromise: null,
    finalizationTimer: null,
    resolveFinalization: null,
    syntheticMode,
    delegationReplySent: false,
    delegationIds: [],
    delegationOffsetMs: null,
    inputTranscriptFragments: 0,
    outputTranscriptFragments: 0,
    commentaryEventId: null,
    commentaryAcknowledged: false,
    clientMutationRejected: false,
    clientMutationSentAt: null,
    clientMutationCorrelation: null,
    hangupAttempted: false,
    voiceSeconds: null,
    closeReason: null,
  };
  record('session_created', {
    status: response.status,
    session_id: data.session.id,
    model: MODEL,
    output_voice: OUTPUT_VOICE,
  });
  return data;
}

async function invalidStartup() {
  if (state.invalidAttempted) return { status: 409, result: 'already_attempted' };
  state.invalidAttempted = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/v1/live/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid-task-01-probe-credential',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: MODEL,
          delegation: { type: 'client' },
          audio: { output: { voice: OUTPUT_VOICE } },
        },
        transport: { type: 'webrtc', sdp: 'invalid-probe-sdp' },
      }),
      signal: controller.signal,
    });
    const result =
      response.status >= 200 && response.status < 300 ? 'unexpected_success' : 'rejected';
    record('invalid_startup', { status: response.status, result });
    return { status: response.status, result };
  } catch {
    record('invalid_startup', { status: 'network_or_timeout', result: 'rejected' });
    return { status: 'network_or_timeout', result: 'rejected' };
  } finally {
    clearTimeout(timer);
  }
}

async function command(name) {
  const active = state.active;
  if (!active || active.finalized) throw new Error('no_active_session');
  const eventId = `probe_${name.replaceAll('-', '_')}_${randomUUID()}`;
  if (name === 'status') {
    return sendSideband({
      type: 'session.thinking.append',
      event_id: eventId,
      delegation_id: null,
      content: 'Probe status: no backend task or external action is running.',
    });
  }
  if (name === 'mute' || name === 'unmute') {
    return sendSideband({
      type: `session.input_audio.${name}`,
      event_id: eventId,
    });
  }
  if (name === 'close') {
    void closeSession('operator_requested');
    return true;
  }
  throw new Error('unknown_command');
}

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/')
    return text(response, 200, page, 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/synthetic-audio') {
    if (!SYNTHETIC_AUDIO_PATH) return json(response, 404, { error: 'synthetic_audio_unavailable' });
    try {
      const audio = await readFile(SYNTHETIC_AUDIO_PATH);
      return text(response, 200, audio, 'audio/wav');
    } catch {
      return json(response, 404, { error: 'synthetic_audio_unavailable' });
    }
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    const active = state.active;
    return json(response, 200, {
      state: active?.finalized
        ? 'finalized'
        : active
          ? 'active'
          : state.createAttempted
            ? 'startup_failed'
            : 'idle',
      budget_elapsed_ms: elapsedMs(),
      budget_remaining_ms: remainingMs(),
      voice_seconds: active?.voiceSeconds ?? null,
      synthetic_mode: active?.syntheticMode ?? false,
      sideband_ready: active?.sidebandReady ?? false,
      input_transcript_fragments: active?.inputTranscriptFragments ?? 0,
      output_transcript_fragments: active?.outputTranscriptFragments ?? 0,
      delegation_count: active?.delegationIds.length ?? 0,
      delegation_offset_ms: active?.delegationOffsetMs ?? null,
      commentary_acknowledged: active?.commentaryAcknowledged ?? false,
      client_mutation_rejected: active?.clientMutationRejected ?? false,
      client_mutation_correlation: active?.clientMutationCorrelation ?? null,
      finalized: active?.finalized ?? false,
      cleanup_required: active?.finalizationTimedOut ?? false,
      create_attempted: state.createAttempted,
      invalid_attempted: state.invalidAttempted,
    });
  }
  if (request.method === 'GET' && url.pathname === '/events')
    return json(response, 200, { events: state.events });
  if (request.method !== 'POST') return json(response, 404, { error: 'not_found' });

  let body;
  try {
    body = await readJson(request);
  } catch {
    return json(response, 400, { error: 'invalid_request' });
  }

  if (url.pathname === '/session') {
    if (state.createAttempted) return json(response, 409, { error: 'single_session_attempt_only' });
    state.createAttempted = true;
    if (typeof body.sdp !== 'string' || body.sdp.length < 32)
      return json(response, 400, { error: 'invalid_sdp' });
    if (body.mode !== undefined && body.mode !== 'manual' && body.mode !== 'synthetic')
      return json(response, 400, { error: 'invalid_probe_mode' });
    try {
      const created = await createLiveSession(body.sdp, body.mode === 'synthetic');
      return json(response, 201, {
        session: { id: created.session.id },
        transport: { type: 'webrtc', sdp: created.transport.sdp },
      });
    } catch (error) {
      return json(response, 502, {
        error: error instanceof Error ? error.message : 'live_session_create_failed',
      });
    }
  }

  if (url.pathname === '/attach') {
    if (!state.active || body.sessionId !== state.active.sessionId)
      return json(response, 409, { error: 'session_not_available' });
    attachSideband(state.active.sessionId);
    return json(response, 200, { attached: true });
  }

  if (url.pathname === '/client-mutation-sent') {
    if (!state.active || state.active.finalized)
      return json(response, 409, { error: 'session_not_available' });
    state.active.clientMutationSentAt = elapsedMs();
    record('client_mutation_sent');
    return json(response, 200, { recorded: true });
  }

  if (url.pathname === '/command') {
    try {
      const accepted = await command(body.name);
      return json(response, 200, { accepted });
    } catch (error) {
      return json(response, 409, {
        error: error instanceof Error ? error.message : 'command_failed',
      });
    }
  }

  if (url.pathname === '/invalid-startup') {
    if (state.active && !state.active.finalized)
      return json(response, 409, { error: 'close_live_session_first' });
    return json(response, 200, await invalidStartup());
  }

  return json(response, 404, { error: 'not_found' });
}

const server = createServer((request, response) => {
  void route(request, response).catch(() => json(response, 500, { error: 'probe_internal_error' }));
});

async function shutdown(signal) {
  record('probe_shutdown', { signal });
  if (state.active && !state.active.finalized) await closeSession('process_shutdown', true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), HANGUP_TIMEOUT_MS + CLOSE_GRACE_MS).unref();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`probe_url=http://${HOST}:${PORT}`);
  console.log(`probe_model=${MODEL} max_budget_seconds=${MAX_BUDGET_MS / 1000}`);
  console.log(`synthetic_audio_available=${SYNTHETIC_AUDIO_PATH ? 'yes' : 'no'}`);
});
