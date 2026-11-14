'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { run } = require('../experiments/warm-town-2d/warm-city-src/check.cjs');

const root = path.resolve(__dirname, '../experiments/warm-town-2d');
const build = path.join(root, 'warm-city-src/build.cjs');
const html = path.join(root, 'tanks-warm-town.html');

test('Warm Town builds the exact checked-in offline HTML', () => {
  const result = spawnSync(process.execPath, [build, '--stdout'], { encoding: 'buffer' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(result.stdout.equals(fs.readFileSync(html)), 'Regenerate the checked-in HTML with build.cjs');
});

test('Warm Town preserves the donor campaign and approved collision geometry', () => {
  const checked = run(html);
  assert.equal(checked.enemies, 66);
  assert.equal(checked.enemyRuns.length, 3);
  assert.equal(checked.courtyardCollision.bypassWithWreck, true);
});
