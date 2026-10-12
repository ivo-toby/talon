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
const lensControl = query('[data-action="start"]');
const sessionClock = query('[data-role="session-clock"]');
const startLabel = query('[data-role="start-label"]');
const muteButton = query('[data-action="mute"]');
const muteLabel = query('[data-role="mute-label"]');
const hangupButton = query('[data-action="hangup"]');
const logoutButton = query('[data-action="logout"]');
const resumeAudioButton = query('[data-action="resume-audio"]');
const audioNotice = query('[data-role="audio-notice"]');
const resultsList = query('[data-role="results"]');
const emptyTasks = query('[data-role="empty-tasks"]');
const taskCount = query('[data-role="task-count"]');
const notificationsList = query('[data-role="notifications"]');
const emptyNotifications = query('[data-role="empty-notifications"]');
const notificationCount = query('[data-role="notification-count"]');
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

lensControl?.addEventListener('click', () => {
  if (lensControl.disabled || !canStartCall(client.state)) return;
  setBusy(lensControl, true);
  hide(callError);
  void client.startCall().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => render(client.state));
});

muteButton?.addEventListener('click', () => {
  if (muteButton.disabled) return;
  client.toggleMute();
});

hangupButton?.addEventListener('click', () => {
  if (hangupButton.disabled || !hasOpenSession(client.state)) return;
  setBusy(hangupButton, true);
  void client.hangup().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => render(client.state));
});

logoutButton?.addEventListener('click', () => {
  if (logoutButton.disabled) return;
  setBusy(logoutButton, true);
  void client.logout().catch((error) => {
    show(callError, errorMessage(error));
  }).finally(() => {
    setBusy(logoutButton, false);
    render(client.state);
  });
});

resumeAudioButton?.addEventListener('click', () => {
  if (resumeAudioButton.disabled) return;
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
  text(muteLabel, state.muted ? 'Unmute' : 'Mute');
  text(taskCount, String(state.outputs.length));
  text(notificationCount, String(state.notifications.length));
  text(sessionClock, state.session ? sessionLabel(state.session.status) : 'Private');
  connectionPill?.classList.toggle('is-live', state.phase === 'connected');
  connectionPill?.classList.toggle('is-warn', state.phase === 'network_lost' || state.phase === 'failed');
  lensControl?.classList.toggle('is-loading', state.phase === 'requesting_microphone' || state.phase === 'connecting');
  lensControl?.toggleAttribute('disabled', !canStartCall(state));
  lensControl?.setAttribute('aria-label', phase.startLabel);
  lensControl?.setAttribute('aria-busy', String(state.phase === 'requesting_microphone' || state.phase === 'connecting'));
  muteButton?.toggleAttribute('disabled', state.phase !== 'connected');
  muteButton?.setAttribute('aria-pressed', String(state.muted));
  muteButton?.setAttribute('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone');
  setHidden(hangupButton, !hasOpenSession(state));
  hangupButton?.toggleAttribute('disabled', state.phase === 'closing' || !hasOpenSession(state));
  setHidden(audioNotice, !state.audioBlocked);
  setHidden(pendingBanner, !state.pendingDelegation);
  if (state.errorMessage) show(callError, state.errorMessage);
  else hide(callError);
  renderUsage(state);
  renderResults(state.outputs);
  renderNotifications(state.notifications);
}

function renderUsage(state) {
  const usage = state.usage;
  text(voiceCost, formatCost(usage.voiceCostUsd, usage.voiceCostStatus));
  text(voiceDuration, `${formatDuration(usage.voiceSeconds)} call time`);
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
    kind.textContent = output.kind === 'final' ? 'Final result' : 'Progress';
    const execution = document.createElement('span');
    execution.className = `result-status status-${output.lifecycle.execution}`;
    execution.textContent = executionLabel(output.lifecycle.execution);
    top.append(kind, execution);
    const body = document.createElement('p');
    body.textContent = output.text ?? 'No textual result has been stored yet.';
    const playback = document.createElement('span');
    playback.className = 'result-playback';
    playback.textContent = `Speech: ${playbackLabel(output.lifecycle.playback)}`;
    item.append(top, body, playback);
    resultsList.append(item);
  }
}

function renderNotifications(notifications) {
  if (!notificationsList) return;
  notificationsList.replaceChildren();
  setHidden(emptyNotifications, notifications.length > 0);
  for (const notification of [...notifications].reverse()) {
    const item = document.createElement('li');
    item.className = 'notification-item';
    const body = document.createElement('p');
    body.textContent = notification.text;
    item.append(body);
    notificationsList.append(item);
  }
}

function phaseDetails(phase) {
  const details = {
    ready: { label: 'Ready to call', hint: 'Speak to Talon in your own words.', startLabel: 'Call Talon' },
    requesting_microphone: { label: 'Microphone needed', hint: 'Allow microphone access in your browser.', startLabel: 'Allow microphone' },
    connecting: { label: 'Connecting…', hint: 'Setting up the secure audio connection.', startLabel: 'Connecting…' },
    connected: { label: 'Connected', hint: 'You can speak. Talon is connected.', startLabel: 'Connected' },
    network_lost: { label: 'Audio interrupted', hint: 'Your task may continue. End the call when you are ready.', startLabel: 'End call first' },
    closing: { label: 'Ending…', hint: 'Talon is keeping the result of active work.', startLabel: 'Ending…' },
    closed: { label: 'Call ended', hint: 'You can start a new call.', startLabel: 'Call Talon' },
    failed: { label: 'Not connected', hint: 'Check your connection or try again.', startLabel: 'Try again' },
    logged_out: { label: 'Signed out', hint: 'Sign in again to call.', startLabel: 'Call Talon' },
  };
  return details[phase] ?? details.failed;
}

function sessionLabel(status) {
  return { created: 'New', connecting: 'Connecting', connected: 'Active', closing: 'Ending', closed: 'Ended', expired: 'Expired', failed: 'Failed' }[status] ?? 'Private';
}

function executionLabel(status) {
  return { not_started: 'Waiting', running: 'Running', succeeded: 'Completed', failed: 'Failed', unknown: 'Unknown', skipped: 'Skipped' }[status] ?? 'Unknown';
}

function playbackLabel(status) {
  return { not_started: 'not played', playing: 'playing', played: 'played', interrupted: 'interrupted', unknown: 'unknown' }[status] ?? 'unknown';
}

function costStatusLabel(status) {
  return { estimated: 'Estimate', confirmed: 'Confirmed', incomplete: 'Incomplete', unavailable: 'Unavailable' }[status] ?? 'Unknown';
}

function formatCost(value, status) {
  if (value === undefined || status === 'unavailable') return 'No estimate yet';
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

function canStartCall(state) {
  return state.authenticated && !state.activeSessionId && ['ready', 'closed', 'failed'].includes(state.phase);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
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
