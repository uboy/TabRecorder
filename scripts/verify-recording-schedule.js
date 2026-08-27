'use strict';

const assert = require('node:assert/strict');
const RecordingSchedule = require('../lib/recording-schedule.js');

function testStopAtTimeFutureToday() {
  const now = new Date('2026-04-25T10:15:00').getTime();
  const option = RecordingSchedule.buildStopAtTimeOption('15:00');
  const active = RecordingSchedule.activateSchedule(option, now);
  const expected = new Date('2026-04-25T15:00:00').getTime();
  assert.equal(active.targetTs, expected, 'stop-at-time should target the same day when still in the future');
}

function testStopAtTimeRollsToTomorrow() {
  const now = new Date('2026-04-25T16:15:00').getTime();
  const option = RecordingSchedule.buildStopAtTimeOption('15:00');
  const active = RecordingSchedule.activateSchedule(option, now);
  const expected = new Date('2026-04-26T15:00:00').getTime();
  assert.equal(active.targetTs, expected, 'stop-at-time should roll over to the next day after the selected time');
}

function testIntervalNormalization() {
  const option = RecordingSchedule.buildStopAfterIntervalOption('4', '92');
  assert.equal(option.hours, 5, 'overflow minutes should normalize into hours');
  assert.equal(option.minutes, 32, 'overflow minutes should preserve the remainder');
  assert.equal(option.durationMs, ((5 * 60) + 32) * 60 * 1000, 'normalized duration should match the expected milliseconds');
}

function testZeroIntervalRejected() {
  assert.throws(
    () => RecordingSchedule.buildStopAfterIntervalOption(0, 0),
    /greater than zero/i,
    'zero-length interval must be rejected'
  );
}

function testPauseResumeFreezesIntervalCountdown() {
  const start = new Date('2026-04-25T10:00:00').getTime();
  const option = RecordingSchedule.buildStopAfterIntervalOption(1, 0);
  const active = RecordingSchedule.activateSchedule(option, start);

  const paused = RecordingSchedule.pauseActiveSchedule(
    active,
    new Date('2026-04-25T10:15:00').getTime()
  );
  assert.equal(paused.remainingMs, 45 * 60 * 1000, 'pause should preserve the remaining interval');
  assert.equal(RecordingSchedule.getAlarmTarget(paused), null, 'paused interval schedule should not keep an active alarm target');

  const resumed = RecordingSchedule.resumeActiveSchedule(
    paused,
    new Date('2026-04-25T10:45:00').getTime()
  );
  assert.equal(
    resumed.targetTs,
    new Date('2026-04-25T11:30:00').getTime(),
    'resume should shift the stop target by the paused duration'
  );
}

const tests = [
  testStopAtTimeFutureToday,
  testStopAtTimeRollsToTomorrow,
  testIntervalNormalization,
  testZeroIntervalRejected,
  testPauseResumeFreezesIntervalCountdown,
];

for (const test of tests) {
  test();
}

console.log(`PASS ${tests.length} schedule verification checks`);
