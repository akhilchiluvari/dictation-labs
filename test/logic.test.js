import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  canUseCloud,
  cleanLocalTranscript,
  completedJobsToDeliver,
  createJob,
  formatDuration,
  mergeSettings,
  normalizeVocabulary,
  upsertJob
} from '../src/logic.js';

test('settings merge keeps safe defaults and normalizes user values', () => {
  const settings = mergeSettings({ mode: 'not-a-mode', provider: 'not-a-provider', vocabulary: 'Alpha, Alpha, Beta', maxDurationSeconds: 2 });
  assert.equal(settings.mode, DEFAULT_SETTINGS.mode);
  assert.equal(settings.provider, DEFAULT_SETTINGS.provider);
  assert.deepEqual(settings.vocabulary, ['Alpha', 'Beta']);
  assert.equal(settings.maxDurationSeconds, 15);
});

test('local cleanup removes filler and immediate repetitions without inventing content', () => {
  assert.equal(cleanLocalTranscript('um um send the the file to Sam'), 'Send the file to Sam.');
  assert.equal(cleanLocalTranscript(''), '');
});

test('cloud guardrail permits local mode and blocks over-budget cloud work', () => {
  assert.equal(canUseCloud({ provider: 'local', cloudMinutesUsed: 999, cloudCreditLimit: 1 }, 10_000), true);
  assert.equal(canUseCloud({ provider: 'openai', cloudMinutesUsed: 2, cloudCreditLimit: 2 }, 1), false);
});

test('jobs can be created and replaced by id', () => {
  const first = createJob({ id: 'job-1', transcript: 'first' });
  const replaced = { ...first, transcript: 'second' };
  const jobs = upsertJob([first], replaced);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].transcript, 'second');
});

test('retry results include every newly completed transcript without replaying old ones', () => {
  const previous = [
    { id: 'job-old', status: 'completed', transcript: 'Already delivered.' },
    { id: 'job-waiting', status: 'queued', transcript: '' }
  ];
  const next = [
    { id: 'job-old', status: 'completed', transcript: 'Already delivered.' },
    { id: 'job-waiting', status: 'completed', transcript: 'First new transcript.' },
    { id: 'job-another', status: 'completed', transcript: 'Second new transcript.' },
    { id: 'job-empty', status: 'completed', transcript: '' }
  ];

  assert.deepEqual(
    completedJobsToDeliver(previous, next).map((job) => job.id),
    ['job-waiting', 'job-another']
  );
});

test('duration formatting is stable for queue and recorder labels', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65_000), '01:05');
  assert.deepEqual(normalizeVocabulary(['', 'A', 'a', 'A']), ['A', 'a']);
});
