import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun } from '../extension/schedule.js';

// Wednesday 2026-10-21 10:30 local time
const wed = new Date(2026, 9, 21, 10, 30).getTime();
const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();

test('off and empty schedules never run', () => {
  assert.equal(nextRun({ type: 'off' }, wed), null);
  assert.equal(nextRun(null, wed), null);
  assert.equal(nextRun({ type: 'weekly', days: [], time: '09:00' }, wed), null);
});

test('daily: later today, or tomorrow if the time has passed', () => {
  assert.equal(nextRun({ type: 'daily', time: '11:00' }, wed), at(21, 11, 0));
  assert.equal(nextRun({ type: 'daily', time: '09:00' }, wed), at(22, 9, 0));
  assert.equal(nextRun({ type: 'daily', time: '10:30' }, wed), at(22, 10, 30));
});

test('weekly: next chosen weekday', () => {
  assert.equal(nextRun({ type: 'weekly', days: [1], time: '09:00' }, wed), at(26, 9, 0)); // Monday
  assert.equal(nextRun({ type: 'weekly', days: [3], time: '09:00' }, wed), at(28, 9, 0)); // next Wednesday
  assert.equal(nextRun({ type: 'weekly', days: [3], time: '12:00' }, wed), at(21, 12, 0)); // today
});

test('every N hours counts from now', () => {
  assert.equal(nextRun({ type: 'hours', every: 6 }, wed), wed + 6 * 3600e3);
  assert.equal(nextRun({ type: 'hours', every: 0 }, wed), wed + 3600e3);
});
