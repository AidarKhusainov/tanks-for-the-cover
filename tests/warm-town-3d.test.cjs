'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = path.resolve(__dirname, '../experiments/warm-town-3d');
const artifact = 'tanks-warm-town-3d.html';
const run = (cwd, ...args) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000 });

test('3D town rebuilds offline from a clean source tree and preserves the shipped HTML', t => {
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-3d-build-'));
  t.after(() => fs.rmSync(clean, { recursive: true, force: true }));
  for (const name of ['src', 'tools', 'vendor', 'build.cjs']) {
    fs.cpSync(path.join(source, name), path.join(clean, name), { recursive: true });
  }
  run(clean, 'build.cjs');
  const shipped = fs.readFileSync(path.join(source, artifact));
  assert.deepEqual(fs.readFileSync(path.join(clean, artifact)), shipped, 'Rebuild differs from the committed standalone game');
  run(clean, 'build.cjs');
  assert.deepEqual(fs.readFileSync(path.join(clean, artifact)), shipped, 'Build is not deterministic');
  const verification = JSON.parse(run(clean, 'tools/verify-game.cjs', artifact));
  assert.equal(verification.pureSimulationUnchanged, true);
  assert.equal(verification.waves, 8);
  assert.equal(verification.enemies, 66);
  assert.equal(verification.actualPlannerChecks, 9);
  run(clean, 'build.cjs', '--blockout');
  assert.ok(fs.statSync(path.join(clean, 'evidence/blockout.html')).size > 0, 'Blockout works without pre-existing evidence');
});

// Keep the canopy regression in the normal repository/CI test command.
require('../experiments/warm-town-3d/tools/geometry.test.cjs');
