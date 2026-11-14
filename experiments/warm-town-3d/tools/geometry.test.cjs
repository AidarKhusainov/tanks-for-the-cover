'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const directory = path.resolve(__dirname, '..');
const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(directory, 'vendor/three-r187.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(directory, 'src/town.mjs'), 'utf8')
  .replace('export function buildTown', 'function buildTown'), context);
context.layout = JSON.parse(fs.readFileSync(path.join(directory, 'src/layout.json'), 'utf8'));

test('market facade and canopy remain near the building instead of escaping the scene', () => {
  // Exercise the actual facade geometry without mocking THREE or rasterizing
  // textures. An omitted positional awning argument previously became y=0xd5bd96.
  const positions = vm.runInContext(`(() => {
    const building = layout.buildings.find(item => item.id === 'market');
    const batches = { detail: new Faces(THREE), plaster: new Faces(THREE),
      width: layout.width, height: layout.height };
    facade(building, HOUSES.market, boundary(building.shape)[1], layout.doors,
      batches, seededRandom(1), 1);
    return batches.detail.position;
  })()`, context);
  assert.ok(positions.length > 100, 'market must generate visible facade detail');
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = positions.slice(i, i + 3);
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'finite facade vertex');
    assert.ok(x > 12 && x < 18 && z > 0 && z < 6, `market detail outside footprint vicinity: ${x},${z}`);
    assert.ok(y >= -.1 && y < 3, `market facade vertex is ${y} units above the ground`);
  }
});
