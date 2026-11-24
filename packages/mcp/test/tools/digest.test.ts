// A zone with clock changes, set before any date is made.
process.env.TZ = 'Europe/Amsterdam';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isDue, sessionHint } from '../../src/digest';

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('isDue: a time of day is due once it has passed since the last digest', () => {
  const s = { times: ['07:30', '18:00'] };
  const last = at(2026, 5, 10, 7, 35);
  assert.equal(isDue(s, last, at(2026, 5, 10, 12, 0)), false, 'before 18:00');
  assert.equal(isDue(s, last, at(2026, 5, 10, 18, 0)), true, 'at 18:00');
  assert.equal(isDue(s, at(2026, 5, 10, 18, 1), at(2026, 5, 10, 23, 59)), false, 'shown after 18:00');
  assert.equal(isDue(s, undefined, at(2026, 5, 10, 18, 0)), false, 'no anchor yet');
  assert.equal(isDue({ times: [] }, last, at(2026, 5, 20, 0, 0)), false, 'no schedule');
});

test('isDue: across midnight, and several missed times give one due digest', () => {
  const s = { times: ['23:30'] };
  assert.equal(isDue(s, at(2026, 5, 10, 23, 31), at(2026, 5, 11, 0, 30)), false, "yesterday's 23:30 was shown");
  assert.equal(isDue(s, at(2026, 5, 10, 22, 0), at(2026, 5, 11, 0, 30)), true, "yesterday's 23:30 was missed");
  const week = at(2026, 5, 3, 8, 0);
  const now = at(2026, 5, 10, 9, 0);
  assert.equal(isDue({ times: ['07:30', '12:00', '18:00'] }, week, now), true, 'a week closed is one due digest');
  assert.equal(isDue({ times: ['07:30', '12:00', '18:00'] }, now, now), false, 'and none once it is shown');
});

test('isDue: days with a clock change keep their times', () => {
  // 29 March 2026: 02:00 becomes 03:00, so 02:30 does not exist and is taken as 03:30.
  const spring = { times: ['02:30'] };
  assert.equal(isDue(spring, at(2026, 3, 28, 12, 0), at(2026, 3, 29, 3, 10)), false);
  assert.equal(isDue(spring, at(2026, 3, 28, 12, 0), at(2026, 3, 29, 4, 0)), true);
  // 25 October 2026 has 25 hours: 07:30 is due once.
  const autumn = { times: ['07:30'] };
  assert.equal(isDue(autumn, at(2026, 10, 24, 7, 31), at(2026, 10, 25, 7, 0)), false);
  assert.equal(isDue(autumn, at(2026, 10, 24, 7, 31), at(2026, 10, 25, 7, 30)), true);
  assert.equal(isDue(autumn, at(2026, 10, 25, 7, 31), at(2026, 10, 25, 23, 0)), false);
});

test('isDue: every N minutes, from 1 up, alone or with times', () => {
  const last = at(2026, 5, 10, 9, 0);
  assert.equal(isDue({ times: [], everyMinutes: 1 }, last, new Date(last.getTime() + 59_000)), false);
  assert.equal(isDue({ times: [], everyMinutes: 1 }, last, new Date(last.getTime() + 60_000)), true);
  assert.equal(isDue({ times: [], everyMinutes: 240 }, last, at(2026, 5, 10, 12, 59)), false);
  assert.equal(isDue({ times: ['12:00'], everyMinutes: 240 }, last, at(2026, 5, 10, 12, 59)), true, 'the time comes first');
});

test('sessionHint: setup when no fact is known, the digest when one is due, else nothing; never a fact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-hint-'));
  assert.match(sessionHint(dir), /set_up_profile/, 'no file yet: a new person');
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":0}');
  assert.match(sessionHint(dir), /set_up_profile/);
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":3}');
  assert.equal(sessionHint(dir), '', 'facts and no schedule');
  writeFileSync(path.join(dir, 'digest.json'), JSON.stringify({ times: ['07:30'], lastAt: at(2026, 5, 9, 8, 0).toISOString() }));
  assert.match(sessionHint(dir, at(2026, 5, 10, 8, 0)), /daily_digest/);
  assert.equal(sessionHint(dir, at(2026, 5, 9, 9, 0)), '');
  writeFileSync(path.join(dir, 'digest.json'), 'not json');
  assert.equal(sessionHint(dir), '', 'an unreadable schedule is no schedule');
});

test('sessionHint: topics waiting for review are offered, with a due digest too, from counts only', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-hint-'));
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":2,"toReview":1,"findingTopics":0}');
  assert.match(sessionHint(dir), /^Mera News setup is not finished: .*review.*get_profile\.$/);
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":2,"toReview":0,"findingTopics":1}');
  assert.match(sessionHint(dir), /setup is not finished/);
  writeFileSync(path.join(dir, 'digest.json'), JSON.stringify({ times: ['07:30'], lastAt: at(2026, 5, 9, 8, 0).toISOString() }));
  assert.match(sessionHint(dir, at(2026, 5, 10, 8, 0)), /setup is not finished.* A Mera News digest is due\./);
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":2,"toReview":0,"findingTopics":0}');
  assert.equal(sessionHint(dir, at(2026, 5, 9, 9, 0)), '', 'setup finished and no digest due');
});

test('sessionHint: facts left with no topics keep setup open in the hint too', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-hint-'));
  writeFileSync(path.join(dir, 'hint.json'), '{"facts":1,"toReview":0,"findingTopics":0,"noTopics":1}');
  assert.match(sessionHint(dir), /^Mera News setup is not finished: .*get_profile\.$/);
});
