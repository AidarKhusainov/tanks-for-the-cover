'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../art-directions/layout-approved.html'), 'utf8');
function approved(name, next) {
  const match = source.match(new RegExp(`^ const ${name}=(.+?[\\s\\S]*?);\\n const ${next}=`, 'm'));
  if (!match) throw new Error(`Missing ${name} in the approved layout`);
  return vm.runInNewContext(`(${match[1]})`, {}, { timeout: 100 });
}

const buildings = approved('buildings', 'contextBuildings');
for (const [index, [x, y, w, h]] of approved('contextBuildings', 'doors').entries()) {
  const round = number => Number(number.toFixed(4));
  const right = round(x + w), bottom = round(y + h);
  buildings.push({ id: `edge-${index}`, shape: [[x, y], [right, y], [right, bottom], [x, bottom]] });
}

// TankCore accepts rectangles. Slice each orthogonal footprint at its vertex
// heights and pair its crossed edges to get the same solid without seams.
function collisionRects({ id, shape }) {
  const ys = [...new Set(shape.map(([, y]) => y))].sort((a, b) => a - b);
  const edges = shape.map((p, i) => [p, shape[(i + 1) % shape.length]]);
  return ys.slice(1).flatMap((bottom, row) => {
    const y = ys[row], mid = (bottom + y) / 2;
    const xs = edges.filter(([[, a], [, b]]) => Math.min(a, b) < mid && mid < Math.max(a, b))
      .map(([[x]]) => x).sort((a, b) => a - b);
    return xs.filter((_, i) => i % 2 === 0).map((x, i) => ({
      id, x, y, w: Number((xs[i * 2 + 1] - x).toFixed(4)), h: Number((bottom - y).toFixed(4)), kind: 'building'
    }));
  });
}

const walls = buildings.flatMap(collisionRects);
const routes = approved('routes', 'saved');
const directions = { A: 'down', B: 'down', C: 'left' };
const spawns = Object.fromEntries(Object.entries(routes).map(([lane, [[x, y]]]) => {
  // Keep the player exclusion zone within the entry pocket and north of the
  // turn into the southeast bypass. Enemy tank dimensions are unchanged.
  const [w, h] = lane === 'C' ? [2, 1.8] : [3, 2];
  return [lane, { x, y, w, h, direction: directions[lane] }];
}));
const city = {
  buildings: buildings.map(({ id, shape }) => ({ id, shape })),
  doors: approved('doors', 'routes'),
  plaza: { x: 9, y: 10.3, w: 9.9, h: 5.5 },
  tradeCourt: [[6.6, 4.8], [10.5, 4.8], [10.5, 6.8], [6.6, 6.8]],
  eastCourt: [[24.1, 8.1], [27.8, 8.1], [27.8, 13], [18.9, 13], [18.9, 11], [24.1, 11]]
};

module.exports = { walls, spawns, city };
