'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const directory = path.resolve(__dirname, '..');
const layout = require('../src/layout.json');
const input = process.argv[2] ?? path.join(directory, 'src/game.html');
const step = 1 / 60;
// SHA-256 from the approved gameplay donor tanks-twin-gates.html. Normalizing
// the build identifier preserves the integrity check when the lab is moved.
const baselineCore = 'f116e717a20e29c29b81959a96517bb17def35c28469805d6190b7a724f8a07d';
const baselineCampaign = 'c79afd141b9d3f285849bf50cdb4015c8e7d15f435577f20ea072a5ead81e94d';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function loadCore(filename) {
  const html = fs.readFileSync(filename, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  let embeddedLayout = layout;
  if (!html.includes('<!-- THREE_RENDERER -->')) {
    const declaration = html.match(/^window\.TownLayout = (.*);$/m);
    assert.ok(declaration, 'Standalone build must embed the geometry');
    embeddedLayout = JSON.parse(declaration[1]);
    assert.deepEqual(embeddedLayout, layout, 'Standalone build is out of date');
  }
  const context = vm.createContext({ TownLayout: JSON.parse(JSON.stringify(embeddedLayout)) });
  const coreScript = scripts.find(script => /root\.TankCore\s*=/.test(script));
  vm.runInContext(scripts.find(script => /root\.TankScenarios\s*=/.test(script)), context);
  vm.runInContext(coreScript, context);
  return { core: context.TankCore, coreScript };
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

function midpoints(edges) {
  const sorted = [...new Set(edges.map(value => Number(value.toFixed(5))))].sort((a, b) => a - b);
  return sorted.slice(1).map((value, index) => (value + sorted[index]) / 2);
}

function verifyWallFootprints() {
  for (const building of layout.buildings) {
    const pieces = layout.walls.filter(wall => wall.buildingId === building.id);
    assert.ok(pieces.length, `${building.id}: missing collision footprint`);
    const xSamples = midpoints([...building.shape.map(p => p[0]), ...pieces.flatMap(wall => [wall.x, wall.x + wall.w])]);
    const ySamples = midpoints([...building.shape.map(p => p[1]), ...pieces.flatMap(wall => [wall.y, wall.y + wall.h])]);
    for (const x of xSamples) {
      for (const y of ySamples) {
        const solidPieces = pieces.filter(wall => x > wall.x && x < wall.x + wall.w && y > wall.y && y < wall.y + wall.h);
        assert.equal(solidPieces.length, Number(insidePolygon(x, y, building.shape)),
          `${building.id}: collision rectangles differ from approved polygon at ${x},${y}`);
      }
    }
  }
}

function drive(game, coordinates, player, label) {
  const [start, ...waypoints] = coordinates.map(([x, y]) => ({ x, y }));
  const tank = player ? game.player : { id: label, r: game.player.r };
  Object.assign(tank, start);
  assert.ok(game._positionFree(tank.x, tank.y, tank, player), `${label}: blocked start`);
  for (const target of waypoints) {
    for (let tick = 0; pointDistance(tank, target) > .001; tick++) {
      assert.ok(tick < 500, `${label}: waypoint ${JSON.stringify(target)} unreachable`);
      const gap = pointDistance(tank, target);
      const travel = Math.min(gap, 4 * step);
      const prior = { x: tank.x, y: tank.y };
      game._moveCircle(tank, (target.x - tank.x) / gap * travel, (target.y - tank.y) / gap * travel, player);
      assert.ok(pointDistance(tank, prior) > .0001, `${label}: collision at ${tank.x.toFixed(3)},${tank.y.toFixed(3)}`);
    }
  }
}

function verifyCombatInteractions(Game) {
  // This isolated scenario exercises the genuine projectile and preparation
  // rules on the new square. Browser evidence covers live enemies and input.
  const game = new Game();
  assert.equal(game._firstCollision(3.8, 3.5, 5.2, 3.5, 'player').kind, 'wall');
  assert.equal(game._firstCollision(26.4, 12.3, 26.4, 17.1, 'player'), null);
  assert.equal(game._firstCollision(13, 11.8, 14, 13.5, 'player').kind, 'base');

  function leaveWreck(id, type, x, y) {
    game._killEnemy({ id, type, x, y, r: game.player.r });
    return game.wrecks.at(-1);
  }

  const first = leaveWreck('salvage-test-1', 'medium', 12, 11.75);
  const second = leaveWreck('salvage-test-2', 'heavy', 14.5, 11.75);
  assert.equal(game._firstCollision(10.5, 11.75, 15.9, 11.75, 'player').object.id, first.id);
  assert.equal(game._positionFree(11.1, 11.75, game.player, true), false);
  game._shoot({ id: 'test-shooter', x: 10.5, y: 11.75 }, { x: 15.8, y: 11.75 }, 'player', 40, 20, 6);
  game._updateBullets(.10);
  assert.equal(game.bullets.length, 0);
  assert.equal(first.hp, first.maxHp - 20);
  assert.equal(second.hp, second.maxHp);

  game.base.hp = 190;
  assert.equal(game.repairFromWreck(first.id).hp, 30);
  assert.equal(game.base.hp, 220);
  assert.equal(game.wrecks.length, 1);
  assert.ok(game.undo());
  assert.equal(game.base.hp, 190);
  assert.equal(game.wrecks.length, 2);
  assert.equal(game.installModuleFromWreck(second.id).module, 'armor');
  assert.equal(game.player.module, 'armor');
  assert.ok(game.undo());
  assert.equal(game.player.module, null);
  assert.ok(game.reinforceWreck(second.id, first.id).ok);
  assert.equal(game.wrecks.length, 1);
  assert.equal(game.wrecks[0].hp, first.maxHp);
  assert.equal(game.wrecks[0].expiresAfterWave, first.expiresAfterWave + 1);
  assert.ok(game.wrecks[0].reinforced);
  assert.ok(game.undo());
  assert.equal(game.wrecks.length, 2);
  assert.equal(game.wrecks.find(wreck => wreck.id === first.id).reinforced, false);
}

const { core, coreScript } = loadCore(input);
const withoutBuildId = script => script.replace(/const BUILD_ID = '[^']+';/, "const BUILD_ID = '<map-build-id>';");
assert.equal(sha256(withoutBuildId(coreScript)), baselineCore, 'Core engine changed outside the build identifier');
assert.equal(sha256(JSON.stringify(core.CONFIG.WAVES)), baselineCampaign, 'Wave schedule changed');
assert.equal(core.CONFIG.WAVES.length, 8);
assert.equal(core.CONFIG.WAVES.flat().flatMap(group => group.types).length, 66);
assert.equal(core.CONFIG.mapId, 'warm-town-3d');
assert.deepEqual(JSON.stringify(core.CONFIG.WALLS), JSON.stringify(layout.walls));
verifyWallFootprints();
const { Game, CONFIG } = core;
const geometry = new Game();
assert.deepEqual([geometry.base.x, geometry.base.y, geometry.base.w, geometry.base.h], [layout.base.x, layout.base.y, layout.base.w, layout.base.h]);

const entranceChecks = {};
for (const [lane, coordinates] of Object.entries(layout.routes)) {
  drive(geometry, coordinates, false, `${lane}: agreed corridor`);
  for (const type of ['light', 'medium', 'heavy']) {
    const route = geometry.getPreviewPaths({ lane, type })[0];
    assert.ok(route?.points.length > 1 && route.blockedWreckId === null, `${lane}/${type}: preview route`);
    assert.ok(pointDistance(route.points.at(-1), geometry.base) < 2, `${lane}/${type}: route ends too far from base`);
    drive(geometry, route.points.map(({x, y}) => [x, y]), false, `${lane}/${type}: actual planner corridor`);
  }
  // Release a baseline medium through the normal wave entry and let it reach a
  // legal firing position. This isolates each lane without editing the actors.
  const local = new Game({ ...CONFIG, WAVES: [[{ start: 0, lane, types: ['medium'] }]] });
  local.startWave();
  let tick = 0;
  while (local.base.hp === local.base.maxHp && tick < 60 * 60) {
    local.update(step);
    tick++;
  }
  assert.ok(local.base.hp < local.base.maxHp, `${lane}: enemy failed to reach and fire on base`);
  entranceChecks[lane] = { secondsUntilBaseHit: Number((tick * step).toFixed(2)) };
}

const alley = [[3, 9.5], [18, 9.5]];
const courtyard = [[25.8, 11.4], [25.8, 12], [17, 12]];
const southeast = [[25.8, 11.4], [26.4, 11.4], [26.4, 17.2]];
const lowerStreet = [[.51, 17.2], [27.49, 17.2]];
for (const [label, points] of Object.entries({ alley, courtyard, southeast, lowerStreet })) {
  drive(new Game(), points, true, label);
}

let samples = 0;
for (let y = 16.2; y <= 17.5 + 1e-6; y += .1) {
  for (let x = .5; x <= 27.5 + 1e-6; x += .1) {
    assert.ok(geometry._positionFree(x, y, geometry.player, true), `lower street blocked at ${x.toFixed(2)},${y.toFixed(2)}`);
    samples++;
  }
}

for (const [direction, input] of Object.entries({ forward: { y: -1 }, left: { x: -1 }, right: { x: 1 } })) {
  const local = new Game();
  const start = { x: local.player.x, y: local.player.y };
  for (let tick = 0; tick < 36; tick++) local.update(step, input);
  assert.ok(pointDistance(start, local.player) > 2.35, `${direction}: blocked return exit`);
}
const returning = new Game();
returning.player.alive = false;
returning.player.respawn = 4;
for (let tick = 0; tick <= 240; tick++) returning._updateRespawn(step);
assert.ok(returning.player.alive);
assert.equal(pointDistance(returning.player, layout.returnPoint), 0);
verifyCombatInteractions(Game);

console.log(JSON.stringify({ pureSimulationUnchanged: true, waves: 8, enemies: 66, entranceChecks,
  verifiedWallFootprints: layout.buildings.length, actualPlannerChecks: 9,
  drives: ['alley', 'courtyard', 'southeast', 'lowerStreet'], lowerStreetSamples: samples,
  returnExits: ['forward', 'left', 'right'], respawnSeconds: 4,
  isolatedCombatChecks: ['wall', 'open exit', 'base', 'wreck collision and damage', 'repair', 'module', 'reinforcement', 'undo'] }, null, 2));
