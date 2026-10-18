import {
  DEFAULT_SETTINGS,
  canUseCloud,
  cleanLocalTranscript,
  completedJobsToDeliver,
  estimateCloudMinutes,
  formatDuration,
  formatRelativeTime,
  mergeSettings,
  normalizeVocabulary,
  sortJobs,
  statusLabel,
  upsertJob
} from './logic.js';

const app = document.querySelector('#app');
const STORAGE_KEYS = {
  settings: 'dictation-lab.settings.v1',
  jobs: 'dictation-lab.jobs.v1',
  transcript: 'dictation-lab.last-transcript.v1'
};
const PREVIEW_ONLY_JOB_ERROR = 'Browser preview captured audio, but transcription runs in the Windows desktop shell.';

const state = {
  view: 'workspace',
  settings: mergeSettings(),
  jobs: [],
  activeTranscript: '',
  recording: null,
  recordingElapsed: 0,
  processingJobId: '',
  notice: null,
  native: Boolean(globalThis.__TAURI__?.core?.invoke),
  unlistenHotkey: null,
  unlistenTray: null,
  mediaStream: null,
  mediaRecorder: null,
  mediaChunks: [],
  timer: null,
  cancelledJobs: new Set(),
  loaded: false
};

let lastHotkeyReleaseAt = 0;

const bridge = {
  async invoke(command, args = {}) {
    if (!state.native) throw new Error('The desktop bridge is not available in browser preview.');
    return globalThis.__TAURI__.core.invoke(command, args);
  },
  async listen(event, handler) {
    if (!state.native || !globalThis.__TAURI__?.event?.listen) return () => {};
    return globalThis.__TAURI__.event.listen(event, handler);
  }
};

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience in browser preview; the desktop app uses its data directory.
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setNotice(type, title, detail = '') {
  state.notice = { type, title, detail };
  render();
}

function persistBrowserState() {
  writeStorage(STORAGE_KEYS.settings, state.settings);
  writeStorage(STORAGE_KEYS.jobs, state.jobs);
  writeStorage(STORAGE_KEYS.transcript, state.activeTranscript);
}

async function refreshNativeJobs() {
  if (!state.native) return state.jobs;
  state.jobs = sortJobs(await bridge.invoke('get_jobs'));
  return state.jobs;
}

async function refreshNativeSettings() {
  if (!state.native) return state.settings;
  state.settings = mergeSettings(await bridge.invoke('get_settings'));
  persistBrowserState();
  return state.settings;
}

async function loadApp() {
  state.settings = mergeSettings(readStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS));
  const storedJobs = readStorage(STORAGE_KEYS.jobs, []);
  state.jobs = sortJobs(state.native ? storedJobs : storedJobs.filter((job) => job.error !== PREVIEW_ONLY_JOB_ERROR));
  state.activeTranscript = readStorage(STORAGE_KEYS.transcript, '');

  if (state.native) {
    try {
      state.settings = mergeSettings(await bridge.invoke('get_settings'));
      state.jobs = sortJobs(await bridge.invoke('get_jobs'));
    } catch (error) {
      setNotice('warning', 'Desktop data is unavailable', error.message);
    }
  }

  state.loaded = true;
  render();
  await connectHotkey();

  if (state.settings.autoRetry && navigator.onLine) {
    await retryPendingJobs(true);
  }
}

async function connectHotkey() {
  if (!state.native) return;
  if (state.unlistenHotkey) await state.unlistenHotkey();
  state.unlistenHotkey = await bridge.listen('global-hotkey', ({ payload }) => {
    handleHotkey(payload?.state || payload);
  });
  if (state.unlistenTray) await state.unlistenTray();
  state.unlistenTray = await bridge.listen('tray-toggle', () => {
    saveSettings({ ...state.settings, enabled: !state.settings.enabled });
  });
}

async function saveSettings(nextSettings, { rerender = true } = {}) {
  const previous = state.settings;
  state.settings = mergeSettings(nextSettings);
  if (state.native) {
    try {
      const saved = await bridge.invoke('save_settings', { settings: state.settings });
      state.settings = mergeSettings(saved);
    } catch (error) {
      state.settings = previous;
      setNotice('error', 'Settings were not saved', error.message);
      return false;
    }
  }
  persistBrowserState();
  if (rerender) render();
  return true;
}

async function changeHotkey(hotkey) {
  const next = mergeSettings({ ...state.settings, hotkey });
  if (!(await saveSettings(next))) return;
  setNotice('success', 'Shortcut updated', `${hotkey} is now your global dictation shortcut.`);
}

function clearRecordingTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function startRecordingTimer() {
  clearRecordingTimer();
  state.timer = setInterval(() => {
    if (!state.recording) return;
    state.recordingElapsed = Date.now() - state.recording.startedAt;
    if (state.recordingElapsed >= state.settings.maxDurationSeconds * 1000) {
      stopRecording(false, true);
    } else {
      updateRecordingClock();
    }
  }, 250);
}

function updateRecordingClock() {
  const clocks = document.querySelectorAll('[data-recording-clock]');
  const meter = document.querySelector('[data-recording-meter]');
  clocks.forEach((clock) => { clock.textContent = formatDuration(state.recordingElapsed); });
  if (meter) {
    const percent = Math.min(100, (state.recordingElapsed / (state.settings.maxDurationSeconds * 1000)) * 100);
    meter.style.width = `${percent}%`;
  }
}

async function startRecording(source = 'manual') {
  if (state.recording) return;

  state.recording = { source, startedAt: Date.now() };
  state.recordingElapsed = 0;
  state.notice = null;
  render();
  startRecordingTimer();

  try {
    if (state.native) {
      await bridge.invoke('start_recording');
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not expose microphone capture.');
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaChunks = [];
      state.mediaRecorder = new MediaRecorder(state.mediaStream);
      state.mediaRecorder.addEventListener('dataavailable', (event) => state.mediaChunks.push(event.data));
      state.mediaRecorder.start();
    }
  } catch (error) {
    clearRecordingTimer();
    stopMediaStream();
    state.recording = null;
    setNotice('error', 'Microphone access failed', error.message);
  }
}

function stopMediaStream() {
  state.mediaStream?.getTracks?.().forEach((track) => track.stop());
  state.mediaStream = null;
  state.mediaRecorder = null;
}

async function stopRecording(cancel = false, timedOut = false) {
  if (!state.recording) return;
  const elapsed = state.recordingElapsed;
  clearRecordingTimer();

  if (cancel) {
    if (state.native) await bridge.invoke('cancel_recording').catch(() => {});
    stopMediaStream();
    state.recording = null;
    state.recordingElapsed = 0;
    setNotice('info', 'Recording cancelled', 'Nothing was added to your queue.');
    return;
  }

  let recordingInfo;
  try {
    if (state.native) {
      recordingInfo = await bridge.invoke('stop_recording');
    } else {
      recordingInfo = await stopBrowserRecording(elapsed);
    }
  } catch (error) {
    state.recording = null;
    stopMediaStream();
    setNotice('error', 'Recording could not be saved', error.message);
    return;
  }

  state.recording = null;
  state.recordingElapsed = 0;
  stopMediaStream();
  render();

  if (state.native && timedOut) {
    state.notice = { type: 'info', title: 'Five-minute safety limit reached', detail: 'Your recording was saved and queued.' };
  }

  if (!state.native) {
    state.mediaChunks = [];
    setNotice(
      'info',
      timedOut ? 'Preview limit reached — audio was not saved' : 'Preview audio was not saved',
      'Browser preview holds audio in memory only and discards it when recording stops. Run the Windows desktop app to save and transcribe recordings.'
    );
    return;
  }

  try {
    const job = await bridge.invoke('enqueue_recording', { recording: recordingInfo });
    state.jobs = upsertJob(state.jobs, job);
    render();
    void processJob(job.id);
  } catch (error) {
    setNotice('error', 'Recording was not queued', error.message);
  }
}

async function stopBrowserRecording(durationMs) {
  if (!state.mediaRecorder) return { id: '', durationMs };
  await new Promise((resolve) => {
    if (state.mediaRecorder.state === 'inactive') return resolve();
    state.mediaRecorder.addEventListener('stop', resolve, { once: true });
    state.mediaRecorder.stop();
  });
  return { id: '', durationMs, blob: new Blob(state.mediaChunks, { type: 'audio/webm' }) };
}

async function processJob(jobId) {
  if (!state.native) return;
  state.processingJobId = jobId;
  state.cancelledJobs.delete(jobId);
  state.jobs = state.jobs.map((job) => job.id === jobId ? { ...job, status: 'processing' } : job);
  render();

  try {
    const record = await bridge.invoke('process_job', { jobId });
    state.jobs = upsertJob(state.jobs, record);
    if (state.cancelledJobs.has(jobId)) {
      if (record.status === 'completed' && record.transcript) await finishTranscript(record);
      return;
    }
    if (record.status === 'completed' && record.transcript) {
      await finishTranscript(record);
      await refreshNativeSettings();
    } else if (record.status === 'queued') {
      setNotice('warning', 'Saved locally — waiting to retry', record.error || 'The provider was unavailable.');
    }
  } catch (error) {
    if (!state.cancelledJobs.has(jobId)) {
      setNotice('warning', 'Saved locally — waiting to retry', error.message);
    }
  } finally {
    if (state.processingJobId === jobId) state.processingJobId = '';
    render();
  }
}

async function finishTranscript(record) {
  state.activeTranscript = record.transcript;
  writeStorage(STORAGE_KEYS.transcript, state.activeTranscript);
  try {
    if (state.native) {
      await bridge.invoke('insert_text', {
        text: record.transcript,
        restoreClipboard: state.settings.restoreClipboard
      });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(record.transcript);
    }
    setNotice('success', 'Ready to paste', 'The polished transcript is on your clipboard.');
  } catch (error) {
    setNotice('warning', 'Transcript ready', `Copy it manually — paste automation was unavailable: ${error.message}`);
  }
}

async function retryJob(jobId) {
  if (!state.native) {
    setNotice('info', 'Desktop retry is unavailable in preview', 'Open the Windows desktop build to save and retry recordings.');
    return;
  }
  await processJob(jobId);
}

async function retryPendingJobs(silent = false) {
  if (!state.native || state.processingJobId) return;
  const previousJobs = state.jobs;
  try {
    const records = await bridge.invoke('retry_pending_jobs');
    state.jobs = sortJobs(records);
    const completed = completedJobsToDeliver(previousJobs, records);
    for (const job of completed) await finishTranscript(job);
    await refreshNativeSettings();
    if (!silent && !completed.length) setNotice('info', 'Queue checked', 'No queued recordings could be completed yet.');
    render();
  } catch (error) {
    if (!silent) setNotice('warning', 'Retry postponed', error.message);
  }
}

async function cancelTranscription() {
  if (!state.processingJobId) return;
  const jobId = state.processingJobId;
  state.cancelledJobs.add(jobId);
  let cancelError = null;
  let refreshError = null;
  try {
    if (state.native) await bridge.invoke('cancel_job', { jobId });
  } catch (error) {
    cancelError = error;
  } finally {
    state.processingJobId = '';
    if (state.native) {
      try {
        await refreshNativeJobs();
      } catch (error) {
        refreshError = error;
      }
    }
    if (cancelError || refreshError) {
      const detail = refreshError
        ? `Cancellation was requested, but the local job list could not be refreshed: ${refreshError.message}`
        : `The desktop shell could not confirm cancellation: ${cancelError.message}`;
      setNotice('warning', 'Cancellation needs attention', detail);
    } else {
      setNotice('info', 'Transcription cancelled', 'The audio remains in your local retry queue.');
    }
  }
}

async function deleteJob(jobId) {
  state.jobs = state.jobs.filter((job) => job.id !== jobId);
  persistBrowserState();
  if (state.native) await bridge.invoke('delete_job', { jobId }).catch(() => {});
  render();
}

async function copyTranscript() {
  if (!state.activeTranscript) return;
  try {
    if (state.native) {
      await bridge.invoke('insert_text', { text: state.activeTranscript, restoreClipboard: false });
    } else {
      await navigator.clipboard.writeText(state.activeTranscript);
    }
    setNotice('success', 'Copied to clipboard', 'Paste it anywhere with Ctrl+V.');
  } catch (error) {
    setNotice('error', 'Copy failed', error.message);
  }
}

function handleHotkey(rawState) {
  if (!state.settings.enabled) return;
  const eventState = String(rawState || '').toLowerCase();
  const pressed = eventState.includes('press');
  const released = eventState.includes('release');
  if (!pressed && !released) return;

  if (state.settings.mode === 'toggle') {
    if (pressed) {
      if (state.recording) stopRecording(false);
      else startRecording('toggle');
    }
    return;
  }

  if (pressed) {
    if (state.recording?.source === 'hands-free') {
      stopRecording(false);
    } else if (state.settings.doubleTapHandsFree && lastHotkeyReleaseAt && Date.now() - lastHotkeyReleaseAt < 380) {
      if (state.recording) {
        void stopRecording(false).then(() => startRecording('hands-free'));
      } else {
        startRecording('hands-free');
      }
    } else if (!state.recording) {
      startRecording('hold');
    }
  }
  if (released && state.recording?.source === 'hold') {
    lastHotkeyReleaseAt = Date.now();
    stopRecording(false);
  }
}

function triggerHandsFree() {
  if (state.recording) stopRecording(false);
  else startRecording('hands-free');
}

function isRecordingHandsFree() {
  return state.recording?.source === 'hands-free';
}

window.addEventListener('online', () => {
  if (state.settings.autoRetry) retryPendingJobs(true);
});

window.addEventListener('offline', () => {
  setNotice(
    'warning',
    'You are offline',
    state.native
      ? 'New recordings remain local and will retry when the connection returns.'
      : 'Browser preview does not save recordings; use the Windows desktop app for the protected retry queue.'
  );
});

window.addEventListener('keydown', (event) => {
  if (state.native || event.repeat) return;
  if (event.altKey && event.code === 'Space') {
    event.preventDefault();
    handleHotkey('pressed');
  }
  if (event.key === 'Escape') {
    if (state.recording) stopRecording(true);
    else if (state.processingJobId) cancelTranscription();
  }
});

window.addEventListener('keyup', (event) => {
  if (state.native) return;
  if (event.altKey && event.code === 'Space') {
    event.preventDefault();
    handleHotkey('released');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.recording) stopRecording(true);
    else if (state.processingJobId) cancelTranscription();
  }
});

loadApp();

function render() {
  if (!state.loaded) {
    app.innerHTML = '<div class="boot-screen"><div class="brand-mark">DL</div><p>Loading your voice workspace…</p></div>';
    return;
  }

  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main-column">
        ${renderTopbar()}
        ${state.view === 'settings' ? renderSettings() : renderWorkspace()}
      </main>
    </div>
    ${state.notice ? renderNotice() : ''}
    ${state.recording && state.settings.showFloatingPill ? renderFloatingPill() : ''}
  `;
  bindEvents();
  updateRecordingClock();
}

function renderSidebar() {
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  return `
    <aside class="sidebar">
      <div class="brand-lockup">
        <div class="brand-mark">DL</div>
        <div>
          <div class="brand-name">Dictation Lab</div>
          <div class="brand-caption">Trinity Protocol · 01</div>
        </div>
      </div>

      <div class="sidebar-section-label">Workspace</div>
      <nav class="sidebar-nav">
        <button class="nav-button ${state.view === 'workspace' ? 'active' : ''}" data-view="workspace">
          <span class="nav-icon">⌂</span><span>Speak</span>
        </button>
        <button class="nav-button ${state.view === 'settings' ? 'active' : ''}" data-view="settings">
          <span class="nav-icon">⚙</span><span>Settings</span>
        </button>
      </nav>

      <div class="sidebar-section-label queue-label">${state.native ? 'Local queue' : 'Preview session'} ${queued ? `<span class="count-badge">${queued}</span>` : ''}</div>
      <div class="privacy-card">
        <div class="privacy-icon">◌</div>
        <div>
          <strong>${state.native ? 'Private by default' : 'Preview mode'}</strong>
          <p>${state.native ? 'Raw audio stays on this device until delivery succeeds.' : 'Audio is held in memory only; the desktop app saves and transcribes it.'}</p>
        </div>
      </div>

      <div class="sidebar-footer">
        <div class="connection-dot ${navigator.onLine ? 'online' : 'offline'}"></div>
        <span>${state.native ? (navigator.onLine ? 'Connection available' : 'Offline · queue protected') : 'Preview · audio not saved'}</span>
        <span class="version-label">v0.1</span>
      </div>
    </aside>
  `;
}

function renderTopbar() {
  const status = !state.settings.enabled ? 'Off' : state.recording ? 'Listening' : state.processingJobId ? 'Polishing' : 'Ready';
  const statusClass = !state.settings.enabled ? 'is-off' : state.recording ? 'is-recording' : state.processingJobId ? 'is-processing' : '';
  return `
    <header class="topbar">
      <div class="breadcrumb"><span>Trinity Protocol</span><span class="crumb-slash">/</span><strong>Dictation Lab</strong></div>
      <div class="topbar-actions">
        <span class="platform-chip"><span class="platform-dot"></span>${state.native ? 'Windows desktop' : 'Browser preview'}</span>
        <span class="status-chip ${statusClass}"><span class="status-pulse"></span>${status}</span>
        <button class="avatar-button" title="Writing profile">AK</button>
      </div>
    </header>
  `;
}

function renderWorkspace() {
  const queuedJobs = state.jobs.filter((job) => job.status === 'queued' || job.status === 'processing');
  const completedJobs = state.jobs.filter((job) => job.status === 'completed' && job.transcript);
  return `
    <section class="content workspace-content">
      <div class="hero-row">
        <div>
          <div class="eyebrow"><span class="eyebrow-line"></span>ENGLISH-FIRST VOICE OS</div>
          <h1>Speak it. <em>Shape it.</em><br />Send it anywhere.</h1>
          <p class="hero-copy">Dictation that keeps your meaning, removes the noise, and leaves polished words at your cursor.</p>
        </div>
        <div class="hero-orbit" aria-hidden="true">
          <div class="orbit-ring ring-one"></div><div class="orbit-ring ring-two"></div>
          <div class="orbit-core"><span>◉</span></div>
          <span class="orbit-label label-top">LOCAL FIRST</span><span class="orbit-label label-bottom">YOUR WORDS</span>
        </div>
      </div>

      ${renderRecorder()}
      ${renderTranscriptCard()}

      <div class="section-heading">
        <div><span class="section-kicker">RECENT ACTIVITY</span><h2>Your voice, in writing.</h2></div>
        <button class="text-button" data-action="retry-all" ${state.native ? '' : 'disabled'}>Retry queue <span>↗</span></button>
      </div>
      ${renderActivity(queuedJobs, completedJobs)}
    </section>
  `;
}

function renderRecorder() {
  const recording = Boolean(state.recording);
  const modeLabel = recording
    ? (isRecordingHandsFree() ? 'Hands-free session' : state.recording.source === 'hold' ? 'Hold to dictate' : 'Toggle session')
    : state.settings.mode === 'hold' ? 'Hold to dictate' : 'Toggle to dictate';
  const actionLabel = recording ? (isRecordingHandsFree() ? 'Stop session' : 'Release to stop') : 'Start listening';
  return `
    <section class="recorder-card ${recording ? 'recording' : ''}">
      <div class="recorder-header">
        <div class="mode-summary"><span class="mode-dot ${recording ? 'live' : ''}"></span><span>${modeLabel}</span></div>
        <div class="recorder-meta"><span class="hotkey-key">${escapeHtml(state.settings.hotkey)}</span><span class="meta-separator">·</span><span>Esc cancels</span></div>
      </div>
      <div class="recorder-main">
        <div class="wavefield ${recording ? 'active' : ''}" aria-hidden="true">
          ${Array.from({ length: 31 }, (_, index) => `<i style="--i:${index};"></i>`).join('')}
        </div>
        <div class="record-core">
          <button class="record-button ${recording ? 'stop' : ''}" data-action="record" aria-label="${actionLabel}">
            <span class="record-glyph">${recording ? '■' : '●'}</span>
          </button>
          <span class="record-clock" data-recording-clock>${recording ? formatDuration(state.recordingElapsed) : '00:00'}</span>
        </div>
        <div class="recorder-instruction">
          <strong>${recording ? 'Listening for your thoughts' : 'Ready when you are'}</strong>
          <span>${recording ? 'Speak naturally. Corrections are welcome.' : `Press ${escapeHtml(state.settings.hotkey)} or tap the mic.`}</span>
        </div>
      </div>
      <div class="recording-progress"><span data-recording-meter></span></div>
      <div class="recorder-footer">
        <button class="secondary-button" data-action="hands-free">${recording && isRecordingHandsFree() ? 'Stop hands-free' : 'Start hands-free'} <span>↗</span></button>
        <div class="recorder-note"><span class="shield-icon">♢</span> ${state.native ? (state.settings.retainRawAudio ? 'Audio is kept locally until delivery succeeds' : 'Audio is deleted after successful delivery') : 'Preview audio is held in memory only and is not saved'}</div>
      </div>
    </section>
  `;
}

function renderTranscriptCard() {
  const hasTranscript = Boolean(state.activeTranscript);
  return `
    <section class="transcript-card ${hasTranscript ? 'has-content' : ''}">
      <div class="transcript-topline"><span class="section-kicker">LAST POLISHED TRANSCRIPT</span><span class="transcript-badge">${hasTranscript ? 'ON CLIPBOARD' : 'WAITING FOR YOUR VOICE'}</span></div>
      ${hasTranscript ? `
        <p class="transcript-text">${escapeHtml(state.activeTranscript)}</p>
        <div class="transcript-actions"><span class="transcript-hint">Paste it anywhere with Ctrl + V</span><button class="primary-button compact" data-action="copy">Copy again <span>↗</span></button></div>
      ` : `
        <div class="empty-transcript"><span class="empty-spark">✦</span><span>Your cleaned-up words will appear here after your first session.</span></div>
      `}
    </section>
  `;
}

function renderActivity(queuedJobs, completedJobs) {
  if (!queuedJobs.length && !completedJobs.length) {
    const detail = state.native
      ? 'Your dictation history will be protected locally and show up here.'
      : 'Browser preview does not save recordings. Use the Windows desktop app for local history and retry.';
    return `<div class="activity-empty"><div class="empty-icon">⌁</div><div><strong>No sessions yet</strong><p>${detail}</p></div></div>`;
  }

  const items = [...queuedJobs, ...completedJobs].slice(0, 6);
  return `<div class="activity-list">${items.map((job) => renderJob(job)).join('')}</div>`;
}

function renderJob(job) {
  const isQueued = job.status === 'queued';
  const isProcessing = job.status === 'processing' || job.id === state.processingJobId;
  const icon = isProcessing ? '◌' : isQueued ? '↻' : '✓';
  const preview = job.transcript || job.error || 'Waiting for a connection or provider.';
  return `
    <article class="activity-item ${isQueued ? 'queued' : ''} ${isProcessing ? 'processing' : ''}">
      <div class="activity-icon ${isQueued ? 'pending' : ''}">${icon}</div>
      <div class="activity-body"><div class="activity-title"><strong>${isProcessing ? 'Transcribing session' : isQueued ? 'Saved locally for retry' : 'Polished dictation'}</strong><span>${formatRelativeTime(job.createdAt)}</span></div><p>${escapeHtml(preview)}</p></div>
      <div class="activity-actions">${isQueued ? `<button class="icon-button" data-job-retry="${escapeHtml(job.id)}" title="Retry">↻</button>` : `<span class="duration-label">${formatDuration(job.durationMs)}</span>`}<button class="icon-button muted" data-job-delete="${escapeHtml(job.id)}" title="Remove">×</button></div>
    </article>
  `;
}

function renderSettings() {
  const settings = state.settings;
  const cloud = settings.provider !== 'local';
  const usedPercent = settings.cloudCreditLimit ? Math.min(100, (settings.cloudMinutesUsed / settings.cloudCreditLimit) * 100) : 0;
  const providerDescription = !state.native
    ? 'Browser preview does not save recordings or run transcription. Use the Windows desktop app for the full local retry flow.'
    : cloud
      ? 'Cloud mode uses your configured API key. If it fails, audio stays queued locally.'
      : 'Local mode works without an account or internet when Whisper.cpp is installed.';
  const resilienceTitle = state.native ? 'Protected retry queue' : 'Desktop retry queue';
  const resilienceDescription = state.native
    ? 'Recordings are saved locally, retried when you are online, and removed only after a transcript is delivered.'
    : 'Browser preview does not save recordings. The Windows desktop app provides local storage and retry.';
  return `
    <section class="content settings-content">
      <div class="settings-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span>CONTROL ROOM</div><h1>Make it sound like <em>you.</em></h1><p>Everything important stays configurable. Nothing needs an account.</p></div><div class="settings-seal">LOCAL<br /><span>BY DEFAULT</span></div></div>

      <div class="settings-grid">
        <section class="settings-panel wide-panel">
          <div class="panel-heading"><div><span class="section-kicker">CAPTURE</span><h2>How you speak</h2></div><span class="panel-number">01</span></div>
          <div class="mode-picker">
            <button class="mode-card ${settings.mode === 'hold' ? 'selected' : ''}" data-mode="hold"><span class="mode-card-icon">◉</span><span><strong>Hold to dictate</strong><small>Hold ${escapeHtml(settings.hotkey)} while you speak. Release to send.</small></span><span class="radio-dot"></span></button>
            <button class="mode-card ${settings.mode === 'toggle' ? 'selected' : ''}" data-mode="toggle"><span class="mode-card-icon">◌</span><span><strong>Toggle session</strong><small>Tap once to start. Tap again to stop hands-free.</small></span><span class="radio-dot"></span></button>
          </div>
          <div class="setting-row"><div><strong>Dictation Lab enabled</strong><small>Disable the global shortcut without closing the app.</small></div><button class="switch ${settings.enabled ? 'on' : ''}" data-setting="enabled" role="switch" aria-checked="${settings.enabled}"><span></span></button></div>
          <div class="setting-row"><div><strong>Global shortcut</strong><small>Works while you are in another Windows app.</small></div><button class="shortcut-input" data-action="change-hotkey">${escapeHtml(settings.hotkey)} <span>⌘</span></button></div>
          <div class="setting-row"><div><strong>Double-tap hands-free</strong><small>Keep a short session going without holding a key.</small></div><button class="switch ${settings.doubleTapHandsFree ? 'on' : ''}" data-setting="doubleTapHandsFree" role="switch" aria-checked="${settings.doubleTapHandsFree}"><span></span></button></div>
          <div class="setting-row"><div><strong>Safety limit</strong><small>${state.native ? 'Automatically saves and stops a forgotten session.' : 'Stops a long preview session; audio is not saved.'}</small></div><label class="inline-select"><select data-setting-value="maxDurationSeconds"><option value="120" ${settings.maxDurationSeconds === 120 ? 'selected' : ''}>2 minutes</option><option value="300" ${settings.maxDurationSeconds === 300 ? 'selected' : ''}>5 minutes</option><option value="600" ${settings.maxDurationSeconds === 600 ? 'selected' : ''}>10 minutes</option></select><span>⌄</span></label></div>
        </section>

        <section class="settings-panel">
          <div class="panel-heading"><div><span class="section-kicker">INTELLIGENCE</span><h2>Transcription</h2></div><span class="panel-number">02</span></div>
          <label class="field-label">Provider<select data-setting-value="provider"><option value="local" ${settings.provider === 'local' ? 'selected' : ''}>Local Whisper.cpp · free</option><option value="openai" ${settings.provider === 'openai' ? 'selected' : ''}>OpenAI Whisper · optional</option><option value="groq" ${settings.provider === 'groq' ? 'selected' : ''}>Groq Whisper · optional</option></select></label>
          <label class="field-label">Language<select data-setting-value="language"><option value="en" ${settings.language === 'en' ? 'selected' : ''}>English · primary</option><option value="auto" ${settings.language === 'auto' ? 'selected' : ''}>Auto-detect</option><option value="es" ${settings.language === 'es' ? 'selected' : ''}>Spanish</option><option value="fr" ${settings.language === 'fr' ? 'selected' : ''}>French</option><option value="de" ${settings.language === 'de' ? 'selected' : ''}>German</option></select></label>
          <div class="setting-row compact-row"><div><strong>Polish the transcript</strong><small>Remove filler, fix punctuation, honor corrections.</small></div><button class="switch ${settings.cleanupEnabled ? 'on' : ''}" data-setting="cleanupEnabled" role="switch" aria-checked="${settings.cleanupEnabled}"><span></span></button></div>
          <label class="field-label">Writing style<select data-setting-value="style"><option value="natural" ${settings.style === 'natural' ? 'selected' : ''}>Natural</option><option value="casual" ${settings.style === 'casual' ? 'selected' : ''}>Casual message</option><option value="formal" ${settings.style === 'formal' ? 'selected' : ''}>Professional</option><option value="code" ${settings.style === 'code' ? 'selected' : ''}>Code / technical</option></select></label>
          <div class="provider-note ${cloud ? 'cloud' : ''}"><span>${cloud ? '↗' : '◈'}</span><p>${providerDescription}</p></div>
        </section>

        <section class="settings-panel">
          <div class="panel-heading"><div><span class="section-kicker">YOUR LANGUAGE</span><h2>Voice profile</h2></div><span class="panel-number">03</span></div>
          <p class="panel-intro">This is a writing profile, not biometric identification. Teach the editor your names, products, and preferred tone.</p>
          <label class="field-label">Personal vocabulary<textarea data-setting-value="vocabulary" rows="3" placeholder="One word or phrase per line">${escapeHtml(settings.vocabulary.join('\n'))}</textarea></label>
          <label class="field-label">Profile note<textarea data-setting-value="profileNotes" rows="3" placeholder="e.g. Keep messages concise and warm.">${escapeHtml(settings.profileNotes)}</textarea></label>
          <div class="profile-tip"><span>✦</span><p>We send these preferences only to the selected cleanup provider. Local mode keeps them on this device.</p></div>
        </section>

        <section class="settings-panel wide-panel">
          <div class="panel-heading"><div><span class="section-kicker">RESILIENCE</span><h2>When the internet disappears</h2></div><span class="panel-number">04</span></div>
          <div class="resilience-row"><div class="resilience-icon">⌁</div><div><strong>${resilienceTitle}</strong><p>${resilienceDescription}</p></div><span class="state-pill">${state.jobs.filter((job) => job.status === 'queued').length} waiting</span></div>
          <div class="setting-row"><div><strong>Keep raw audio after success</strong><small>Useful for a later re-transcription. Disable for maximum privacy.</small></div><button class="switch ${settings.retainRawAudio ? 'on' : ''}" data-setting="retainRawAudio" role="switch" aria-checked="${settings.retainRawAudio}"><span></span></button></div>
          <div class="setting-row"><div><strong>Retry automatically</strong><small>Try queued work when the connection returns.</small></div><button class="switch ${settings.autoRetry ? 'on' : ''}" data-setting="autoRetry" role="switch" aria-checked="${settings.autoRetry}"><span></span></button></div>
          <div class="setting-row"><div><strong>Restore previous clipboard</strong><small>Restore your old clipboard after the paste completes.</small></div><button class="switch ${settings.restoreClipboard ? 'on' : ''}" data-setting="restoreClipboard" role="switch" aria-checked="${settings.restoreClipboard}"><span></span></button></div>
          <div class="setting-row"><div><strong>Floating recording pill</strong><small>Keep a small live indicator above the workspace while recording.</small></div><button class="switch ${settings.showFloatingPill ? 'on' : ''}" data-setting="showFloatingPill" role="switch" aria-checked="${settings.showFloatingPill}"><span></span></button></div>
          <div class="setting-row"><div><strong>Launch at Windows login</strong><small>Start quietly in the tray when you sign in.</small></div><button class="switch ${settings.launchAtLogin ? 'on' : ''}" data-setting="launchAtLogin" role="switch" aria-checked="${settings.launchAtLogin}"><span></span></button></div>
        </section>

        <section class="settings-panel credits-panel">
          <div class="panel-heading"><div><span class="section-kicker">AI BUDGET</span><h2>Cloud minutes</h2></div><span class="panel-number">05</span></div>
          <div class="credit-number"><strong>${settings.cloudMinutesUsed}</strong><span>/ ${settings.cloudCreditLimit} min</span></div>
          <div class="credit-bar"><span style="width:${usedPercent}%"></span></div>
          <p>Local transcription has no credit limit. Cloud usage is tracked locally as a guardrail, not as an account balance.</p>
          <label class="field-label small-field">Monthly guardrail<input type="number" min="0" max="100000" value="${settings.cloudCreditLimit}" data-setting-value="cloudCreditLimit" /></label>
        </section>
      </div>
    </section>
  `;
}

function renderNotice() {
  const notice = state.notice;
  return `<div class="toast toast-${escapeHtml(notice.type)}"><span class="toast-icon">${notice.type === 'error' ? '!' : notice.type === 'warning' ? '↻' : notice.type === 'success' ? '✓' : 'i'}</span><div><strong>${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.detail)}</p></div><button data-action="dismiss-notice">×</button></div>`;
}

function renderFloatingPill() {
  const handsFree = isRecordingHandsFree();
  return `<div class="floating-pill"><span class="floating-live"></span><span>${handsFree ? 'Hands-free' : 'Listening'}</span><strong data-recording-clock>${formatDuration(state.recordingElapsed)}</strong><button data-action="record" title="Stop recording">■</button></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      state.notice = null;
      render();
    });
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleAction(button.dataset.action));
  });

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      await saveSettings({ ...state.settings, mode: button.dataset.mode });
    });
  });

  document.querySelectorAll('[data-setting]').forEach((control) => {
    control.addEventListener('click', async () => {
      const key = control.dataset.setting;
      await saveSettings({ ...state.settings, [key]: !state.settings[key] });
    });
  });

  document.querySelectorAll('[data-setting-value]').forEach((control) => {
    const key = control.dataset.settingValue;
    control.addEventListener('change', async () => {
      let value = control.value;
      if (key === 'vocabulary') value = normalizeVocabulary(value.split(/\n|,/));
      if (key === 'maxDurationSeconds' || key === 'cloudCreditLimit') value = Number(value);
      await saveSettings({ ...state.settings, [key]: value });
    });
  });

  document.querySelectorAll('[data-job-retry]').forEach((button) => {
    button.addEventListener('click', () => retryJob(button.dataset.jobRetry));
  });
  document.querySelectorAll('[data-job-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteJob(button.dataset.jobDelete));
  });
}

async function handleAction(action) {
  switch (action) {
    case 'record':
      if (state.recording) await stopRecording(false);
      else await startRecording('manual');
      break;
    case 'hands-free':
      triggerHandsFree();
      break;
    case 'copy':
      await copyTranscript();
      break;
    case 'retry-all':
      await retryPendingJobs();
      break;
    case 'change-hotkey': {
      const next = window.prompt('Enter a shortcut such as Alt+Space, Ctrl+Shift+D, or F9.', state.settings.hotkey);
      if (next?.trim()) await changeHotkey(next.trim());
      break;
    }
    case 'dismiss-notice':
      state.notice = null;
      render();
      break;
    default:
      break;
  }
}
