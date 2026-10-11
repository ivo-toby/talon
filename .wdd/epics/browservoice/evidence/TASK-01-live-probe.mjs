import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PROBE_PORT ?? 8787);
const API_BASE = 'https://api.openai.com';
const MODEL = 'gpt-live-1';
const MAX_BUDGET_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 5_000;
const MAX_EVENTS = 250;

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
  <p>Click start, allow microphone access, and speak these two short Dutch turns. The page records event types and timing only, not transcript text or audio.</p>
  <ol>
    <li>Zeg: “Zeg alleen dat de verbinding werkt.”</li>
    <li>Zeg daarna: “Nee, ik bedoel: zeg alleen hallo.”</li>
    <li>Use <strong>mute input</strong> while the assistant speaks if possible. This measures provider input muting, not natural output interruption.</li>
    <li>Click close, wait for <code>session.closed</code>, then click invalid startup once.</li>
  </ol>
  <p>
    <button id="start">Start GPT-Live session</button>
    <button id="status" disabled>Send sideband status</button>
    <button id="mutation" disabled>Attempt client backend mutation</button>
    <button id="mute" disabled>Mute input</button>
    <button id="unmute" disabled>Unmute input</button>
    <button id="close" disabled>Close session</button>
    <button id="invalid" disabled>Invalid startup once</button>
  </p>
  <pre id="state">state=idle</pre>
  <pre id="events"></pre>
  <audio id="audio" autoplay></audio>
  <script>
    let pc;
    let dc;
    let microphone;
    let sessionId;
    let closed = false;
    let renderedEventCount = 0;
    const state = document.querySelector("#state");
    const events = document.querySelector("#events");
    const audio = document.querySelector("#audio");
    const buttons = {
      start: document.querySelector("#start"),
      status: document.querySelector("#status"),
      mutation: document.querySelector("#mutation"),
      mute: document.querySelector("#mute"),
      unmute: document.querySelector("#unmute"),
      close: document.querySelector("#close"),
      invalid: document.querySelector("#invalid"),
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
      if (event.type === "session.closed") {
        closed = true;
        buttons.close.disabled = true;
        buttons.invalid.disabled = false;
        cleanup(false);
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

    function cleanup(stopMicrophone = true) {
      if (stopMicrophone) microphone?.getTracks().forEach((track) => track.stop());
      if (dc && dc.readyState !== "closed") dc.close();
      if (pc && pc.connectionState !== "closed") pc.close();
      if (stopMicrophone) setActive(false);
    }

    async function start() {
      buttons.start.disabled = true;
      state.textContent = "state=requesting_microphone";
      try {
        microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        pc = new RTCPeerConnection();
        pc.ontrack = (event) => {
          audio.srcObject = event.streams[0];
          audio.play().catch(() => write("browser audio=autoplay_pending"));
        };
        pc.onconnectionstatechange = () => {
          state.textContent = "state=connection_" + pc.connectionState;
        };
        dc = pc.createDataChannel("oai-events");
        dc.onopen = () => write("browser data_channel=open");
        dc.onclose = () => write("browser data_channel=closed");
        dc.onmessage = (event) => receive(event.data);
        pc.addTrack(microphone.getAudioTracks()[0]);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const created = await post("/session", { sdp: offer.sdp });
        sessionId = created.session.id;
        await pc.setRemoteDescription({ type: "answer", sdp: created.transport.sdp });
        await post("/attach", { sessionId });
        state.textContent = "state=connected session_id=" + sessionId;
        setActive(true);
        write("probe session=created model=" + "${MODEL}");
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

    async function invalidStartup() {
      buttons.invalid.disabled = true;
      try {
        const result = await post("/invalid-startup", {});
        write("probe invalid_startup status=" + result.status + " result=" + result.result);
      } catch (error) {
        write("probe invalid_startup error=" + (error?.message ?? "unknown"));
      }
    }

    buttons.start.onclick = start;
    buttons.status.onclick = () => command("status");
    buttons.mutation.onclick = () => command("client-mutation");
    buttons.mute.onclick = () => command("mute");
    buttons.unmute.onclick = () => command("unmute");
    buttons.close.onclick = () => command("close");
    buttons.invalid.onclick = invalidStartup;

    setInterval(async () => {
      const result = await fetch("/state").then((response) => response.json()).catch(() => null);
      if (!result) return;
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
  if (event?.delegation?.target) summary.target = event.delegation.target;
  if (Number.isFinite(event?.usage?.seconds)) summary.voice_seconds = event.usage.seconds;
  if (event?.reason) summary.reason = event.reason;
  if (event?.client_event_id) summary.client_event_id = event.client_event_id;
  if (event?.error?.code) summary.error_code = event.error.code;
  if (event?.error?.type) summary.error_type = event.error.type;
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

async function closeSession(reason, force = false) {
  const active = state.active;
  if (!active || active.closeRequested) return;
  active.closeRequested = true;
  record('close_requested', { reason, force });
  const sent = sendSideband({
    type: 'session.close',
    event_id: `probe_close_${randomUUID()}`,
  });
  if (!sent && active.sessionId) {
    try {
      const response = await openAi(
        `/v1/live/sessions/${encodeURIComponent(active.sessionId)}/hangup`,
        {
          method: 'POST',
        },
      );
      record('rest_hangup', { status: response.status });
    } catch {
      record('rest_hangup', { status: 'network_or_timeout' });
    }
  }
  setTimeout(
    () => {
      if (state.active?.sessionId === active.sessionId && !active.finalized) {
        record('finalization_timeout');
        active.finalized = false;
        active.sideband?.close();
      }
    },
    force ? 1_000 : CLOSE_GRACE_MS,
  );
}

function attachSideband(sessionId) {
  const sidebandUrl = `${API_BASE}/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const sideband = new WebSocket(sidebandUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  state.active.sideband = sideband;
  sideband.on('open', () => record('sideband_opened'));
  sideband.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      record('sideband_event_unparseable');
      return;
    }
    record('provider_event', providerEventSummary(event));
    if (event.type === 'session.usage.updated' && Number.isFinite(event.usage?.seconds)) {
      state.active.voiceSeconds = event.usage.seconds;
    }
    if (event.type === 'session.delegation.created' && event.delegation?.id) {
      state.active.delegationIds.push(event.delegation.id);
      if (!state.active.delegationReplySent) {
        state.active.delegationReplySent = true;
        sendSideband({
          type: 'session.commentary.append',
          event_id: `probe_delegation_observed_${randomUUID()}`,
          delegation_id: event.delegation.id,
          content: 'De proef heeft de aanvraag ontvangen. Er wordt geen backendactie uitgevoerd.',
        });
      }
    }
    if (event.type === 'session.updated' && event.client_event_id === 'probe_client_mutation') {
      record('client_mutation_unexpectedly_accepted');
      void closeSession('unexpected_client_mutation_acceptance', true);
    }
    if (event.type === 'session.closed') {
      state.active.finalized = true;
      state.active.closeReason = event.reason ?? 'unknown';
      if (Number.isFinite(event.usage?.seconds)) state.active.voiceSeconds = event.usage.seconds;
      if (state.budgetTimer) clearTimeout(state.budgetTimer);
      state.budgetTimer = null;
      record('session_finalized', {
        reason: state.active.closeReason,
        voice_seconds: state.active.voiceSeconds ?? null,
      });
      setTimeout(() => state.active?.sideband?.close(), 250);
    }
  });
  sideband.on('error', () => record('sideband_error'));
  sideband.on('close', () => record('sideband_closed'));
}

async function createLiveSession(offerSdp) {
  startBudget();
  if (remainingMs() <= 0) throw new Error('budget_exhausted');
  const body = {
    session: {
      model: MODEL,
      store: false,
      delegation: { type: 'client' },
      instructions:
        'Spreek kort Nederlands. Dit is een begrensde connectiviteitsproef. ' +
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
    closeRequested: false,
    finalized: false,
    delegationReplySent: false,
    delegationIds: [],
    voiceSeconds: null,
    closeReason: null,
  };
  record('session_created', { status: response.status, session_id: data.session.id, model: MODEL });
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
        session: { model: MODEL, delegation: { type: 'client' } },
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
  if (name === 'client-mutation') {
    return sendSideband({
      type: 'session.update',
      event_id: 'probe_client_mutation',
      session: {
        delegation: {
          type: 'responses',
          responses: { model: 'gpt-6-luna' },
        },
      },
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
      finalized: active?.finalized ?? false,
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
    try {
      const created = await createLiveSession(body.sdp);
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
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`probe_url=http://${HOST}:${PORT}`);
  console.log(`probe_model=${MODEL} max_budget_seconds=${MAX_BUDGET_MS / 1000}`);
});
