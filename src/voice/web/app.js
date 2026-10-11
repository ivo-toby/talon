import { VoiceBrowserClient } from './voice-client.js';

const query = (selector) => document.querySelector(selector);
const loginScreen = query('[data-screen="login"]');
const callScreen = query('[data-screen="call"]');
const loginForm = query('[data-form="login"]');
const tokenInput = query('#access-token');
const loginError = query('[data-role="login-error"]');
const callError = query('[data-role="call-error"]');
const callMessage = query('[data-role="call-message"]');
const callHint = query('[data-role="call-hint"]');
const phaseLabel = query('[data-role="phase-label"]');
const connectionPill = query('[data-role="connection-pill"]');
const voiceOrb = query('[data-role="voice-orb"]');
const sessionClock = query('[data-role="session-clock"]');
const startButton = query('[data-action="start"]');
const startLabel = query('[data-role="start-label"]');
const muteButton = query('[data-action="mute"]');
const muteLabel = query('[data-role="mute-label"]');
const hangupButton = query('[data-action="hangup"]');
const logoutButton = query('[data-action="logout"]');
const audioNotice = query('[data-role="audio-notice"]');
const resultsList = query('[data-role="results"]');
const emptyTasks = query('[data-role="empty-tasks"]');
const taskCount = query('[data-role="task-count"]');
const pendingBanner = query('[data-role="pending-banner"]');
const voiceCost = query('[data-role="voice-cost"]');
const voiceDuration = query('[data-role="voice-duration"]');
const voiceCostStatus = query('[data-role="voice-cost-status"]');
const backendCost = query('[data-role="backend-cost"]');
const remoteAudio = query('#remote-audio');

const client = new VoiceBrowserClient({
  audioElement: remoteAudio,
  onStateChange: render,
});

loginForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenInput?.value.trim() ?? '';
  setBusy(loginForm, true);
  hide(loginError);
  void client.login(token).then(() => {
    if (tokenInput) tokenInput.value = '';
  }).catch((error) => {
    show(loginError, errorMessage(error));
  }).finally(() => setBusy(loginForm, false));
});

startButton?.addEventListener('click', () => {
  setBusy(startButton, true);
  hide(callError);
  void client.startCall().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => render(client.state));
});

muteButton?.addEventListener('click', () => {
  client.toggleMute();
});

hangupButton?.addEventListener('click', () => {
  setBusy(hangupButton, true);
  void client.hangup().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => setBusy(hangupButton, false));
});

logoutButton?.addEventListener('click', () => {
  setBusy(logoutButton, true);
  void client.logout().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => setBusy(logoutButton, false));
});

query('[data-action="resume-audio"]')?.addEventListener('click', () => {
  void client.resumeAudio().catch((error) => show(callError, errorMessage(error)));
});

window.addEventListener('pagehide', () => client.dispose());
void client.restore().catch((error) => {
  show(loginError, errorMessage(error));
});
render(client.state);

function render(state) {
  const authenticated = state.authenticated;
  setHidden(loginScreen, authenticated);
  setHidden(callScreen, !authenticated);
  if (!authenticated) return;

  const phase = phaseDetails(state.phase);
  text(phaseLabel, phase.label);
  text(callMessage, state.message);
  text(callHint, phase.hint);
  text(startLabel, phase.startLabel);
  text(muteLabel, state.muted ? 'Geluid aan' : 'Dempen');
  text(taskCount, String(state.outputs.length));
  text(sessionClock, state.session ? sessionLabel(state.session.status) : 'Privé');
  connectionPill?.classList.toggle('is-live', state.phase === 'connected');
  connectionPill?.classList.toggle('is-warn', state.phase === 'network_lost' || state.phase === 'failed');
  voiceOrb?.classList.toggle('is-active', state.phase === 'connected');
  voiceOrb?.classList.toggle('is-busy', state.phase === 'connecting' || state.phase === 'requesting_microphone');
  startButton?.classList.toggle('is-loading', state.phase === 'requesting_microphone' || state.phase === 'connecting');
  startButton?.toggleAttribute('disabled', isActive(state.phase));
  if (state.phase === 'closed' || state.phase === 'failed') {
    startButton?.toggleAttribute('disabled', false);
  }
  muteButton?.toggleAttribute('disabled', !['connected', 'network_lost'].includes(state.phase));
  setHidden(hangupButton, !hasOpenSession(state));
  setHidden(audioNotice, !state.audioBlocked);
  setHidden(pendingBanner, !state.pendingDelegation);
  if (state.errorMessage) show(callError, state.errorMessage);
  else hide(callError);
  renderUsage(state);
  renderResults(state.outputs);
}

function renderUsage(state) {
  const usage = state.usage;
  text(voiceCost, formatCost(usage.voiceCostUsd, usage.voiceCostStatus));
  text(voiceDuration, `${formatDuration(usage.voiceSeconds)} gesprekstijd`);
  text(voiceCostStatus, costStatusLabel(usage.voiceCostStatus));
  text(backendCost, formatCost(usage.backendCostUsd, usage.backendCostStatus));
}

function renderResults(outputs) {
  if (!resultsList) return;
  resultsList.replaceChildren();
  setHidden(emptyTasks, outputs.length > 0);
  for (const output of [...outputs].reverse()) {
    const item = document.createElement('li');
    item.className = 'result-item';
    const top = document.createElement('div');
    top.className = 'result-top';
    const kind = document.createElement('span');
    kind.className = 'result-kind';
    kind.textContent = output.kind === 'final' ? 'Eindresultaat' : 'Voortgang';
    const execution = document.createElement('span');
    execution.className = `result-status status-${output.lifecycle.execution}`;
    execution.textContent = executionLabel(output.lifecycle.execution);
    top.append(kind, execution);
    const body = document.createElement('p');
    body.textContent = output.text ?? 'Talon heeft nog geen tekstueel resultaat opgeslagen.';
    const playback = document.createElement('span');
    playback.className = 'result-playback';
    playback.textContent = `Uitspraak: ${playbackLabel(output.lifecycle.playback)}`;
    item.append(top, body, playback);
    resultsList.append(item);
  }
}

function phaseDetails(phase) {
  const details = {
    ready: { label: 'Klaar om te bellen', hint: 'Geef Talon een opdracht in je eigen woorden.', startLabel: 'Gesprek starten' },
    requesting_microphone: { label: 'Microfoon nodig', hint: 'Sta microfoontoegang toe in je browser.', startLabel: 'Microfoon toestaan' },
    connecting: { label: 'Verbinden…', hint: 'De beveiligde audioverbinding wordt opgezet.', startLabel: 'Verbinden…' },
    connected: { label: 'Verbonden', hint: 'Je kunt nu spreken. Talon luistert.', startLabel: 'Verbonden' },
    network_lost: { label: 'Audio onderbroken', hint: 'Je taak kan nog doorlopen. Hang op als je klaar bent.', startLabel: 'Opnieuw bellen' },
    closing: { label: 'Afsluiten…', hint: 'Talon bewaart het resultaat van lopend werk.', startLabel: 'Afsluiten…' },
    closed: { label: 'Gesprek beëindigd', hint: 'Je kunt een nieuw gesprek starten.', startLabel: 'Nieuw gesprek' },
    failed: { label: 'Niet verbonden', hint: 'Controleer je verbinding of probeer opnieuw.', startLabel: 'Opnieuw proberen' },
    logged_out: { label: 'Uitgelogd', hint: 'Log opnieuw in om te bellen.', startLabel: 'Gesprek starten' },
  };
  return details[phase] ?? details.failed;
}

function sessionLabel(status) {
  return { created: 'Nieuw', connecting: 'Verbinden', connected: 'Actief', closing: 'Afsluiten', closed: 'Afgesloten', expired: 'Verlopen', failed: 'Mislukt' }[status] ?? 'Privé';
}

function executionLabel(status) {
  return { not_started: 'Wacht', running: 'Bezig', succeeded: 'Afgerond', failed: 'Mislukt', unknown: 'Onbekend', skipped: 'Overgeslagen' }[status] ?? 'Onbekend';
}

function playbackLabel(status) {
  return { not_started: 'nog niet afgespeeld', playing: 'wordt afgespeeld', played: 'afgespeeld', interrupted: 'onderbroken', unknown: 'onbekend' }[status] ?? 'onbekend';
}

function costStatusLabel(status) {
  return { estimated: 'Schatting', confirmed: 'Bevestigd', incomplete: 'Onvolledig', unavailable: 'Nog niet gestart' }[status] ?? 'Onbekend';
}

function formatCost(value, status) {
  if (value === undefined || status === 'unavailable') return 'Nog geen schatting';
  const prefix = status === 'estimated' ? '≈ ' : '';
  return `${prefix}USD $${value.toFixed(4)}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function hasOpenSession(state) {
  return Boolean(state.activeSessionId && ['requesting_microphone', 'connecting', 'connected', 'network_lost', 'closing'].includes(state.phase));
}

function isActive(phase) {
  return ['requesting_microphone', 'connecting', 'connected', 'closing'].includes(phase);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Er ging iets mis. Probeer het opnieuw.';
}

function setBusy(element, busy) {
  if (!element) return;
  element.toggleAttribute('disabled', busy);
  element.classList.toggle('is-loading', busy);
}

function setHidden(element, hidden) {
  element?.toggleAttribute('hidden', hidden);
}

function show(element, value) {
  if (!element) return;
  text(element, value);
  setHidden(element, false);
}

function hide(element) {
  setHidden(element, true);
}

function text(element, value) {
  if (element) element.textContent = value;
}
