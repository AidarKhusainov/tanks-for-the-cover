'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function loadCore(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const context = vm.createContext({});
  for (const pattern of [/root\.TankScenarios\s*=/, /root\.TankCore\s*=/]) {
    const script = scripts.find(value => pattern.test(value));
    assert.ok(script, 'Missing scenario or core script');
    vm.runInContext(script, context);
  }
  return context.TankCore;
}


const donor = path.resolve(__dirname, '../tanks-twin-gates.html');

function readApprovedLayout() {
  const html = fs.readFileSync(path.join(__dirname, '../art-directions/layout-approved.html'), 'utf8');
  const model = html.match(/const buildings=[\s\S]*?(?=\n const saved=)/)?.[0];
  assert.ok(model, 'Approved map has no geometry model');
  return vm.runInNewContext(model + '\n({ buildings, contextBuildings, doors, routes })', {}, { timeout: 100 });
}

// Keep this self-contained so it can also run against TankCore in Chromium.
function geometryChecks(core, layout) {
  const step = 1 / 60;
  const tolerance = 1e-6;
  const round = value => Math.round(value * 1000) / 1000;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const point = ([x, y]) => ({ x, y });
  const requireThat = (value, description) => { if (!value) throw Error(description); };
  const config = core.CONFIG;
  const game = new core.Game();
  const result = {
    mapId: config.mapId,
    waves: config.WAVES.length,
    enemies: config.WAVES.flat().reduce((total, entry) => total + entry.types.length, 0)
  };

  requireThat(config.W === 28 && config.H === 18, 'World must be 28×18');
  requireThat(game.base.x === 14 && game.base.y === 13.5 && game.base.w === 1.8 && game.base.h === 1.8, 'Base geometry changed');

  const rectangle = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const approved = [...layout.buildings.map(building => building.shape), ...layout.contextBuildings.map(rectangle)];
  const walls = config.WALLS.map(wall => [wall.x, wall.y, wall.w, wall.h]);
  requireThat(walls.every(([x, y, w, h]) =>
    [x, y, w, h].every(Number.isFinite) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= config.W + tolerance && y + h <= 16 + tolerance),
  'Wall extends outside of the playable region or into the bottom street');

  // Within each cell of this partition, every polygon has constant membership.
  // Splitting at all polygon and wall edges catches both missing and extra area.
  const vertices = [...approved, ...walls.map(rectangle)].flat();
  const breaks = (axis, max) => [...new Set([0, max, ...vertices.map(p => Math.round(p[axis] * 1e6) / 1e6)])]
    .sort((a, b) => a - b);
  const xBreaks = breaks(0, config.W);
  const yBreaks = breaks(1, config.H);
  function inside(x, y, polygon) {
    let crossed = false;
    for (let i = 0; i < polygon.length; i++) {
      const [ax, ay] = polygon[i];
      const [bx, by] = polygon[(i + 1) % polygon.length];
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) crossed = !crossed;
    }
    return crossed;
  }
  for (let i = 1; i < xBreaks.length; i++) {
    for (let j = 1; j < yBreaks.length; j++) {
      const x = (xBreaks[i - 1] + xBreaks[i]) / 2;
      const y = (yBreaks[j - 1] + yBreaks[j]) / 2;
      const expected = approved.some(shape => inside(x, y, shape));
      const solid = walls.some(([left, top, width, height]) => x > left && y > top && x < left + width && y < top + height);
      requireThat(expected === solid, `Collision footprint differs from approved plan at ${round(x)},${round(y)}`);
    }
  }
  result.footprints = { polygons: approved.length, testedCells: (xBreaks.length - 1) * (yBreaks.length - 1) };
  const city = config.CITY;
  const renderShapes = city.buildings.map(building => building.shape);
  const normalized = value => JSON.stringify(value, (_key, item) => typeof item === 'number' ? round(item) : item);
  requireThat(normalized(renderShapes) === normalized(approved), 'Rendered outlines differ from the approved polygons');
  requireThat(normalized(city.doors) === normalized(layout.doors), 'Rendered doors differ from the approved door segments');
  requireThat(city.plaza.x === 9 && city.plaza.y === 10.3 && city.plaza.w === 9.9 && city.plaza.h === 5.5, 'Plaza footprint changed');

  // Check projectile contact with the actual collision edges along the contours,
  // including on both sides of any rectangular decomposition seams.
  let contourContacts = 0;
  for (const shape of approved) {
    for (let index = 0; index < shape.length; index++) {
      const [ax, ay] = shape[index];
      const [bx, by] = shape[(index + 1) % shape.length];
      const dx = ax === bx ? .025 : 0;
      const dy = ay === by ? .025 : 0;
      const samples = Math.ceil(Math.hypot(bx - ax, by - ay) / .1);
      for (let sample = 0; sample < samples; sample++) {
        const t = (sample + .5) / samples;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const sign = inside(x + dx, y + dy, shape) ? 1 : -1;
        const hit = game._firstCollision(x - sign * dx, y - sign * dy, x + sign * dx, y + sign * dy, game.player.id);
        requireThat(hit?.kind === 'wall' && Math.abs(hit.t - .5) < tolerance, `Projectile contact differs from building contour at ${round(x)},${round(y)}`);
        contourContacts++;
      }
    }
  }
  result.footprints.contourContacts = contourContacts;

  const doorHits = [];
  for (const door of layout.doors) {
    const [[ax, ay], [bx, by]] = door.p;
    const x = (ax + bx) / 2;
    const y = (ay + by) / 2;
    const dx = ax === bx ? .1 : 0;
    const dy = ay === by ? .1 : 0;
    const plus = approved.some(shape => inside(x + dx, y + dy, shape));
    const minus = approved.some(shape => inside(x - dx, y - dy, shape));
    requireThat(plus !== minus, `Door is missing an exposed edge: ${door.name}`);
    const sign = plus ? 1 : -1;
    const hit = game._firstCollision(x - sign * dx, y - sign * dy, x + sign * dx, y + sign * dy, game.player.id);
    requireThat(hit?.kind === 'wall' && Math.abs(hit.t - .5) < tolerance, `Projectile does not stop at doorway wall: ${door.name}`);
    doorHits.push({ door: door.name, x, y, exterior: [x - sign * dx, y - sign * dy].map(round) });
  }
  const hall = doorHits.find(door => door.x === 10.2 && door.y === 13.6);
  requireThat(hall && hall.exterior[1] < 13.6, 'Town hall entrance must face north');
  result.doors = doorHits;

  function drive(name, points, isPlayer) {
    const motionGame = new core.Game();
    // Use a tank with the real radius. Enemy approaches may start inside their
    // spawn exclusion zone, whereas the other drives must honor player rules.
    const actor = motionGame.player;
    Object.assign(actor, point(points[0]));
    requireThat(motionGame._positionFree(actor.x, actor.y, actor, isPlayer), `${name}: blocked start`);
    let moved = 0;
    for (const next of points.slice(1)) {
      const target = point(next);
      let count = 0;
      while (distance(actor, target) > .002 && count++ < 1200) {
        const gap = distance(actor, target);
        const travel = Math.min(gap, 4 * step);
        const before = { x: actor.x, y: actor.y };
        motionGame._moveCircle(actor, (target.x - actor.x) / gap * travel, (target.y - actor.y) / gap * travel, isPlayer);
        const progress = distance(before, actor);
        moved += progress;
        requireThat(progress > .0001, `${name}: blocked at ${round(actor.x)},${round(actor.y)} toward ${next}`);
      }
      requireThat(distance(actor, target) <= .002, `${name}: did not reach ${next}`);
    }
    return { name, points, moved: round(moved), reached: { x: round(actor.x), y: round(actor.y) } };
  }

  result.streetDrives = [];
  for (const [lane, points] of Object.entries(layout.routes)) {
    const spawn = config.SPAWNS[lane];
    requireThat(distance(spawn, point(points[0])) < tolerance, `Spawn ${lane} has moved from the approved center`);
    const left = spawn.x - spawn.w / 2, right = spawn.x + spawn.w / 2;
    const top = spawn.y - spawn.h / 2, bottom = spawn.y + spawn.h / 2;
    requireThat(left >= 0 && right <= config.W && top >= 0 && bottom <= config.H, `Spawn ${lane} extends outside the map`);
    requireThat(!walls.some(([x, y, w, h]) => x < right && x + w > left && y < bottom && y + h > top), `Spawn ${lane} extends through a building`);
    result.streetDrives.push(drive(`approved approach ${lane}`, points, false));
  }
  const alley = [[3, 9.5], [18, 9.5]];
  const drives = {
    'north lateral alley': alley,
    'eastern through court': [[24.9, 11.25], [24.9, 12], [18.2, 12], [17, 12]],
    'southeast court bypass': [[22.5, 12], [25.8, 12], [25.8, 11.4], [26.4, 11.4], [26.4, 17.2]],
    'lower street eastbound': [[.5, 17.2], [27.5, 17.2]],
    'lower street westbound': [[27.5, 17.2], [.5, 17.2]]
  };
  for (const [name, points] of Object.entries(drives)) result.streetDrives.push(drive(name, points, true));

  let samples = 0;
  for (let y = 16.2; y <= 17.5 + tolerance; y += .1) {
    for (let x = .5; x <= 27.5 + tolerance; x += .1) {
      requireThat(game._positionFree(x, y, game.player, true), `Lower street blocked at ${round(x)},${round(y)}`);
      samples++;
    }
  }
  result.bottomStreet = { samples, x: [.5, 27.5], y: [16.2, 17.5] };

  result.returnExits = [];
  for (const [key, input] of [['W', { y: -1 }], ['A', { x: -1 }], ['D', { x: 1 }]]) {
    const local = new core.Game();
    const start = { x: local.player.x, y: local.player.y };
    requireThat(start.x === 16.4 && start.y === 17.2, 'Return point has moved');
    for (let frame = 0; frame < 36; frame++) local.update(step, input);
    requireThat(distance(start, local.player) > 2.35, `Return point blocks ${key}`);
    result.returnExits.push({ key, start, reached: { x: round(local.player.x), y: round(local.player.y) } });
  }
  const respawn = new core.Game();
  const expectedReturn = { x: respawn.player.x, y: respawn.player.y };
  respawn.player.alive = false;
  respawn.player.respawn = 4;
  for (let frame = 0; frame < 241; frame++) respawn._updateRespawn(step);
  requireThat(respawn.player.alive && distance(respawn.player, expectedReturn) < tolerance, 'Respawn timer or return placement failed');
  result.respawn = { seconds: 4, returned: expectedReturn };

  result.entrances = [];
  for (const lane of ['A', 'B', 'C']) {
    for (const type of ['light', 'medium', 'heavy']) {
      const preview = game.getPreviewPaths({ lane, type })[0];
      requireThat(preview?.points.length > 1 && preview.blockedWreckId === null, `${lane}/${type}: no open preview to base`);
      const actor = { id: 'path-sample', r: core.TANK_RADIUS };
      let length = 0;
      for (let index = 1; index < preview.points.length; index++) {
        const a = preview.points[index - 1];
        const b = preview.points[index];
        const count = Math.max(1, Math.ceil(distance(a, b) / .025));
        length += distance(a, b);
        for (let sample = 0; sample <= count; sample++) {
          const t = sample / count;
          requireThat(game._positionFree(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, actor, false), `${lane}/${type}: preview intersects collision`);
        }
      }
      const end = preview.points.at(-1);
      requireThat(distance(end, game.base) < 2, `${lane}/${type}: route does not approach base`);
      result.entrances.push({ lane, type, length: round(length), points: preview.points });
    }
  }

  result.enemyRuns = [];
  for (const lane of ['A', 'B', 'C']) {
    const local = new core.Game({ ...config, WAVES: [[{ start: 0, lane, types: ['medium'] }]] });
    local.startWave();
    const enemy = local.enemies[0];
    requireThat(local.enemies.length === 1 && enemy.type === 'medium' && enemy.lane === lane, `${lane}: isolated medium did not spawn`);
    let frames = 0;
    let shots = 0;
    while (local.base.hp === local.base.maxHp && frames < 60 * 50) {
      local.update(step);
      frames++;
      shots += local.drainEvents().filter(event => event.type === 'shot' && event.side === 'enemy').length;
      requireThat(local.enemies.length === 1 && local.enemies[0] === enemy, `${lane}: unexpected actor in isolated run`);
    }
    requireThat(shots > 0 && local.base.hp < local.base.maxHp, `${lane}: medium never reached firing position at base`);
    result.enemyRuns.push({ lane, secondsToBaseHit: round(frames * step), baseHp: local.base.hp, shots, reached: { x: round(enemy.x), y: round(enemy.y) } });
  }

  const throughCourt = new core.Game();
  const clear = throughCourt._firstCollision(20, 12, 24, 12, throughCourt.player.id);
  requireThat(clear === null, 'Projectile hits an obstacle in the clear courtyard');
  // Exercise the normal death → wreck path in a controlled local geometry test.
  throughCourt._killEnemy({ id: 'courtyard-test-medium', x: 22, y: 12, type: 'medium', r: core.TANK_RADIUS });
  const hull = throughCourt.wrecks[0];
  const collision = throughCourt._firstCollision(20, 12, 24, 12, throughCourt.player.id);
  requireThat(collision?.kind === 'wreck' && collision.object === hull, 'Courtyard wreck does not intercept projectile');
  for (const y of [11.5, 12, 12.5]) {
    requireThat(!throughCourt._positionFree(22, y, throughCourt.player, true), 'Wreck allows overlap in the eastern court');
  }
  const bypassWithWreck = throughCourt._positionFree(26.4, 14, throughCourt.player, true);
  requireThat(bypassWithWreck, 'Courtyard wreck obstructs the independent southeast bypass');
  const detour = throughCourt.getPreviewPaths({ lane: 'C' })[0];
  requireThat(detour.blockedWreckId === null && detour.points.some(p => p.x > 25.5 && p.y >= 16),
    'Spawn C cannot reroute through the southeast bypass when the court is blocked');
  result.courtyardCollision = {
    clearBefore: true, hit: collision.kind, impactX: round(20 + 4 * collision.t), bypassWithWreck, detour: detour.points
  };

  return result;
}

function run(input, baseline = donor) {
  const bytes = fs.readFileSync(input);
  const candidate = bytes.toString('utf8');
  const original = fs.readFileSync(baseline, 'utf8');
  const core = loadCore(candidate);
  const base = loadCore(original);
  assert.deepEqual(JSON.parse(JSON.stringify(core.CONFIG.WAVES)), JSON.parse(JSON.stringify(base.CONFIG.WAVES)), 'The eight-wave campaign changed');
  assert.equal(core.CONFIG.WAVES.length, 8);
  assert.equal(core.CONFIG.AI_MODE, base.CONFIG.AI_MODE);
  assert.equal(core.CONFIG.SPAWN_INTERVAL, base.CONFIG.SPAWN_INTERVAL);
  const simulation = html => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => /root\.TankCore\s*=/.test(script))
    ?.replace(/const BUILD_ID = '[^']+';/, "const BUILD_ID = '<map-build-id>';");
  assert.equal(simulation(candidate), simulation(original), 'Simulation differs from the donor beyond the build ID');
  return {
    source: path.resolve(input),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pureSimulationUnchanged: true,
    ...geometryChecks(core, readApprovedLayout())
  };
}

module.exports = { loadCore, readApprovedLayout, geometryChecks, run };
if (require.main === module) {
  assert.ok(process.argv[2], 'Usage: node warm-city-src/check.cjs <warm-town.html> [baseline.html]');
  console.log(JSON.stringify(run(process.argv[2], process.argv[3]), null, 2));
}
