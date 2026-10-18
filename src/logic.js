export const DEFAULT_SETTINGS = {
  enabled: true,
  launchAtLogin: false,
  showFloatingPill: true,
  hotkey: 'Alt+Space',
  mode: 'hold',
  doubleTapHandsFree: true,
  language: 'en',
  provider: 'local',
  cleanupEnabled: true,
  style: 'natural',
  retainRawAudio: true,
  restoreClipboard: false,
  autoRetry: true,
  maxDurationSeconds: 300,
  cloudCreditLimit: 120,
  cloudMinutesUsed: 0,
  vocabulary: ['Wispr Flow', 'Trinity Protocol', 'Dictation Lab'],
  profileNotes: '',
  whisperBinary: 'whisper-cli',
  whisperModel: ''
};

const FILLER_WORDS = [
  'um', 'uh', 'erm', 'hmm', 'like', 'you know', 'sort of', 'kind of', 'basically'
];

export function mergeSettings(value = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(value || {}) };
  merged.maxDurationSeconds = clampNumber(merged.maxDurationSeconds, 15, 900, 300);
  merged.cloudCreditLimit = clampNumber(merged.cloudCreditLimit, 0, 100000, 120);
  merged.cloudMinutesUsed = clampNumber(merged.cloudMinutesUsed, 0, 100000, 0);
  merged.vocabulary = normalizeVocabulary(merged.vocabulary);
  merged.mode = merged.mode === 'toggle' ? 'toggle' : 'hold';
  merged.provider = ['local', 'openai', 'groq'].includes(merged.provider) ? merged.provider : 'local';
  merged.style = ['natural', 'casual', 'formal', 'code'].includes(merged.style) ? merged.style : 'natural';
  return merged;
}

export function normalizeVocabulary(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((word) => String(word).trim()).filter(Boolean))].slice(0, 100);
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function makeId(prefix = 'job') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function formatDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  const age = Math.max(0, now - Number(timestamp || now));
  if (age < 60_000) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function cleanLocalTranscript(input) {
  let text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  for (const filler of FILLER_WORDS) {
    const pattern = new RegExp(`\\b${filler.replace(/ /g, '\\s+')}\\b[, ]*`, 'gi');
    text = text.replace(pattern, ' ');
  }

  // Remove immediate word repetitions without touching intentional repeated phrases.
  text = text.replace(/\b([a-z][\w'-]*)\s+\1\b/gi, '$1');
  text = text.replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (text && !/[.!?]$/.test(text)) text += '.';
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function estimateCloudMinutes(durationMilliseconds) {
  return Math.max(0, Math.ceil(Number(durationMilliseconds || 0) / 60_000));
}

export function canUseCloud(settings, durationMilliseconds = 0) {
  if (settings.provider === 'local') return true;
  return settings.cloudMinutesUsed + estimateCloudMinutes(durationMilliseconds) <= settings.cloudCreditLimit;
}

export function createJob(overrides = {}) {
  return {
    id: makeId(),
    createdAt: Date.now(),
    status: 'queued',
    durationMs: 0,
    transcript: '',
    error: '',
    attempts: 0,
    ...overrides
  };
}

export function sortJobs(jobs = []) {
  return [...jobs].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function upsertJob(jobs, job) {
  const next = jobs.filter((item) => item.id !== job.id);
  next.push(job);
  return sortJobs(next);
}

function hasCompletedTranscript(job) {
  return job?.status === 'completed' && Boolean(String(job.transcript || '').trim());
}

export function completedJobsToDeliver(previousJobs = [], nextJobs = []) {
  const previouslyDelivered = new Map(
    previousJobs.filter(hasCompletedTranscript).map((job) => [job.id, job.transcript])
  );

  return nextJobs.filter((job) => (
    hasCompletedTranscript(job) && previouslyDelivered.get(job.id) !== job.transcript
  ));
}

export function statusLabel(status) {
  return {
    queued: 'Waiting to retry',
    processing: 'Transcribing',
    completed: 'Ready to paste',
    cancelled: 'Cancelled'
  }[status] || status;
}
