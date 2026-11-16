'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG, MAP_CONFIGS, TANK_RADIUS } = require('./load-core.cjs');

const relocated = {
  ...CONFIG,
  BASE_RECT: { x: 3.5, y: 8, w: 2, h: 2 },
  PLAYER_START: { x: 5, y: 15 },
  PLAYER_RETURN_AREA: { x: 4, y: 14, w: 2, h: 2 },
  WALLS: [],
  WAVES: [[], [{ lane: 'A', start: 4, types: ['medium', 'light'] }]]
};

test('a relocated base governs collision, firing and navigation', () => {
  const game = new Game(relocated);
  assert.deepEqual([game.base.x, game.base.y, game.base.w, game.base.h], [4.5, 9, 2, 2]);
  assert.equal(game._positionFree(4.5, 9, game.player, true), false);
  assert.equal(game._positionFree(14, 13.5, game.player, true), true);
  assert.equal(game._firstCollision(1, 9, 5, 9, 'projectile-owner').kind, 'base');
  assert.equal(game._firstCollision(12, 13.5, 16, 13.5, 'projectile-owner'), null);
  const [route] = game.getPreviewPaths({ lane: 'A', type: 'medium' });
  assert(route.estimatedSeconds > 0);
  assert(route.points.at(-1).x < 6, 'approach should end in firing range of the relocated base');
});

test('a relocated start governs reset, timed return and wave-transition return', () => {
  const game = new Game(relocated);
  const playerPosition = () => [game.player.x, game.player.y];
  assert.deepEqual(playerPosition(), [5, 15]);
  game.player.x = 10;
  game.reset();
  assert.deepEqual(playerPosition(), [5, 15]);

  game.waveIndex = 1;
  game.startWave();
  Object.assign(game.player, { x: 9, y: 12, alive: false, respawn: 0.1 });
  game.update(0.2);
  assert.equal(game.player.alive, true);
  assert.deepEqual(playerPosition(), [5, 15]);

  game.reset();
  game.startWave();
  Object.assign(game.player, { x: 9, y: 12, alive: false, respawn: 4 });
  game.update(1 / 60);
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.alive, true);
  assert.deepEqual(playerPosition(), [5, 15]);
});

test('an occupied start falls back to a free position in the relocated return area', () => {
  const game = new Game(relocated);
  game.waveIndex = 1;
  game.startWave();
  const hull = { id: 'occupying-hull', x: 5, y: 15, r: TANK_RADIUS, hp: 60, type: 'medium' };
  game.wrecks.push(hull);
  Object.assign(game.player, { x: 9, y: 12, alive: false, respawn: 0.1 });
  game.update(0.2);
  assert.equal(game.player.alive, true);
  assert(game.player.x >= 4 && game.player.x <= 6);
  assert(game.player.y >= 14 && game.player.y <= 16);
  assert(Math.hypot(game.player.x - hull.x, game.player.y - hull.y) >= 2 * TANK_RADIUS);
});

test('a wave transition waits for a free return when the entire return area is occupied', () => {
  const game = new Game({ ...relocated, PLAYER_RETURN_AREA: { x: 5, y: 15, w: 0, h: 0 } });
  game.startWave();
  Object.assign(game.player, { x: 9, y: 12, alive: false, respawn: 4 });
  game.wrecks.push({
    id: 'occupying-hull', x: 5, y: 15, r: TANK_RADIUS, hp: 60, type: 'medium', expiresAfterWave: 2
  });
  game.update(1 / 60);
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.alive, false);
  game.wrecks = [];
  game.update(1 / 60);
  assert.equal(game.player.alive, true);
  assert.deepEqual([game.player.x, game.player.y], [5, 15]);
});

test('entry warning changes from plan to countdown to blocked and clears on first release', () => {
  const game = new Game({
    ...relocated,
    WAVES: [[
      { lane: 'A', start: 0, types: ['light'] },
      { lane: 'C', start: 4, types: ['medium', 'light'] }
    ]]
  });
  const signal = lane => game.getEntrySignals().find(entry => entry.lane === lane);
  const advance = seconds => game.update(seconds);
  assert.deepEqual([signal('A').status, signal('A').start, signal('C').start], ['planned', 0, 4]);
  game.startWave();
  assert.equal(signal('A').status, 'active');
  assert.equal(signal('C'), undefined);
  advance(1.25);
  assert.deepEqual([signal('C').status, signal('C').seconds], ['countdown', 3]);

  const spawn = game.config.SPAWNS.C;
  const hull = { id: 'blocking-spawn', x: spawn.x, y: spawn.y, r: TANK_RADIUS, hp: 60, type: 'medium' };
  game.wrecks.push(hull);
  advance(6);
  assert.deepEqual([signal('C').status, signal('C').seconds], ['waiting', 0]);
  assert.equal(game.enemies.some(enemy => enemy.lane === 'C'), false);
  game.wrecks = [];
  advance(1 / 60);
  assert.equal(signal('C').status, 'active');
  assert.equal(game.enemies.filter(enemy => enemy.lane === 'C').length, 1);
  advance(2.4);
  assert.equal(game.enemies.filter(enemy => enemy.lane === 'C').length, 1);
  advance(0.15);
  assert.equal(game.enemies.filter(enemy => enemy.lane === 'C').length, 2);
});

test('the two selectable maps start independent shared-core attempts', () => {
  assert.deepEqual(Object.keys(MAP_CONFIGS).sort(), ['city', 'magnetic']);
  const first = new Game(MAP_CONFIGS.magnetic);
  const secondConfig = MAP_CONFIGS.city;
  first.base.hp = 120;
  first.wrecks.push({
    id: 'previous-hull', x: 8, y: 9, r: TANK_RADIUS, hp: 60,
    type: 'medium', expiresAfterWave: 2
  });
  assert.equal(first.installModuleFromWreck('previous-hull', 'barrel').ok, true);
  assert.equal(first.canUndo, true);

  const second = new Game(secondConfig);
  assert.notDeepEqual(second.config.SPAWNS, first.config.SPAWNS);
  assert.notDeepEqual([second.base.x, second.base.y], [first.base.x, first.base.y]);
  assert.deepEqual([second.base.hp, second.player.hp, second.player.module, second.wrecks.length, second.canUndo],
    [240, 60, null, 0, false]);
  const log = JSON.parse(second.exportAttemptLog());
  assert.equal(log.configuration.game.mapId, 'city');
  assert.equal(log.configuration.game.mapVersion, secondConfig.mapVersion);
  assert.deepEqual(log.events.map(event => event.type), ['attempt_start']);
});

test('both maps use the v1 campaign roster and preserve the order inside each group', () => {
  const roster = [
    'A:lmll', 'A:mlmll', 'C:lmlmll', 'B:lmlm C:mhll',
    'B:mhll C:lmll', 'A:lml B:mll C:mlll', 'A:mhll B:lhml C:mll', 'A:hlmll B:mlll C:hlmll'
  ];
  for (const [id, config] of Object.entries(MAP_CONFIGS ?? {})) {
    assert.equal(config.mapId, id);
    assert.equal(config.AI_MODE, 'roles');
    assert.equal(config.SPAWN_INTERVAL, 2.5);
    assert.deepEqual(Array.from(config.WAVES, wave => Array.from(wave, group =>
      `${group.lane}:${group.types.map(type => type[0]).join('')}`
    ).sort().join(' ')), roster);
    for (const wave of config.WAVES) {
      assert.equal(Math.min(...wave.map(group => group.start)), 0);
      assert(wave.every(group => Number.isFinite(group.start) && group.start >= 0));
    }
  }
  assert.equal(Object.keys(MAP_CONFIGS ?? {}).length, 2);
});

function follow(game, points) {
  for (const [x, y] of points) {
    const dx = x - game.player.x, dy = y - game.player.y;
    const distance = Math.hypot(dx, dy);
    game.update(distance / 4, { x: dx / distance, y: dy / distance });
    assert(Math.hypot(game.player.x - x, game.player.y - y) < .01, `player cannot reach ${x}, ${y}`);
  }
}

test('both protected returns have an exit traversable with ordinary movement', () => {
  for (const [id, config] of Object.entries(MAP_CONFIGS)) {
    const game = new Game(config);
    assert(game._positionFree(game.player.x, game.player.y, game.player, true));
    for (const spawn of Object.values(config.SPAWNS)) {
      const collision = game._firstCollision(spawn.x, spawn.y, game.player.x, game.player.y, 'enemy');
      assert(['wall', 'base'].includes(collision.kind));
    }
    const { x, y } = game.player;
    assert.equal(game._firstCollision(x, y - 2, x, y, 'enemy').kind, 'wall');
    if (id === 'magnetic') {
      follow(game, [[16.4, 15.85], [13.65, 15.85], [13.65, 17.2], [11.75, 17.2]]);
    } else {
      // Hold each key against the wall, so exiting needs no precisely timed turns.
      for (const [x, y, ticks] of [[0, -1, 60], [-1, 0, 60], [0, 1, 60], [-1, 0, 36], [0, -1, 54]]) {
        for (let tick = 0; tick < ticks; tick++) game.update(1 / 60, { x, y });
      }
      assert(game.player.x < 2 && game.player.y < 12, 'held WASD movement exits to the west street');
    }
  }
});

test('city return and its fallback positions are shielded from the west street', () => {
  const game = new Game(MAP_CONFIGS.city);
  assert(game._navigationSegmentFree(1.8, 16.8, 25.5, 16.8, false), 'the outer street stays open');
  const shooter = { id: 'west-light', x: 1.8, y: 14.8, type: 'light', r: TANK_RADIUS, hp: 20 };
  assert(game._positionFree(shooter.x, shooter.y, shooter, false));
  game.enemies.push(shooter);
  game.phase = 'battle';
  assert(game._shoot(shooter, game.player, 'enemy', 10, 8, 6));
  game._updateBullets(.6);
  assert.equal(game.player.hp, 60, 'a light on the exterior street cannot shoot the returned player');

  const { x, y, w, h } = game.config.PLAYER_RETURN_AREA;
  for (const point of [
    game.config.PLAYER_START, { x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }
  ]) {
    assert(game._positionFree(point.x, point.y, game.player, true));
    for (const ys of [14.1, 14.8, 15.2, 16.8]) {
      for (const targetY of [point.y - TANK_RADIUS, point.y, point.y + TANK_RADIUS]) {
        assert.equal(game._firstCollision(1.8, ys, point.x, targetY, shooter.id)?.kind, 'wall');
      }
    }
  }

  const preferred = game.config.PLAYER_START;
  game.wrecks = [{ ...preferred, id: 'blocked-return', type: 'medium', hp: 60, r: TANK_RADIUS }];
  Object.assign(game.player, { alive: false, respawn: 0.1 });
  game.update(0.11);
  assert.equal(game.player.alive, true);
  assert.equal(game.player.hp, 60);
  const returned = game.player;
  assert(returned.x >= x && returned.x <= x + w && returned.y >= y && returned.y <= y + h);
  assert(Math.hypot(returned.x - preferred.x, returned.y - preferred.y) >= 2 * TANK_RADIUS);
});

test('magnetic fallback returns are shielded and wait if no center fits', () => {
  const config = MAP_CONFIGS.magnetic;
  const game = new Game(config);
  game.wrecks = placeHulls([config.PLAYER_START]);
  game.player.alive = false;
  game.player.respawn = 0;
  game._updateRespawn(0);
  assert.equal(game.player.alive, true);
  const first = { x:game.player.x, y:game.player.y };
  assert.notDeepEqual(first, config.PLAYER_START);

  const shooter = { id:'west-light', x:10.5, y:16.6, type:'light', r:TANK_RADIUS, hp:20 };
  assert(game._positionFree(shooter.x, shooter.y, shooter, false));
  game.enemies.push(shooter);
  assert(game._shoot(shooter, game.player, 'enemy', 10, 8, 6));
  game._updateBullets(.6);
  assert.equal(game.player.hp, 60, 'a light outside the bunker cannot hit the fallback return');

  game.wrecks = placeHulls([config.PLAYER_START, first]);
  game.player.alive = false;
  const second = game._respawnPosition();
  assert(second, 'another fallback fits if both preferred and first are occupied');
  game.wrecks = placeHulls([config.PLAYER_START, first, second]);
  game._updateRespawn(0);
  assert.equal(game.player.alive, false);
});

function clearSegment(game, a, b) {
  return game._navigationSegmentFree(a.x, a.y, b.x, b.y, false);
}

function crossesGate(game, axis, hull, area) {
  const across = axis === 'x' ? 'y' : 'x';
  const width = across === 'x' ? area.w : area.h;
  for (let sample = 0; sample <= 20; sample++) {
    const lateral = area[across] + width * sample / 20;
    const a = { [axis]: hull[axis] - 1.6, [across]: lateral };
    const b = { [axis]: hull[axis] + 1.6, [across]: lateral };
    if (clearSegment(game, a, b)) return true;
  }
  return false;
}

function placeHulls(hulls) {
  return hulls.map((point, index) => ({ ...point, id: `hull-${index}`, r: TANK_RADIUS, hp: 60, type: 'medium' }));
}

test('A and C choke points close across their useful areas while their bypasses stay free', () => {
  for (const [id, config] of Object.entries(MAP_CONFIGS)) {
    for (const lane of ['A', 'C']) {
      const game = new Game(config);
      const { bypass, blockers: [center], usefulAreas: [area] } = config.TACTICS[lane];
      const axis = id === 'city' && lane === 'C' ? 'x' : 'y';
      const across = axis === 'x' ? 'y' : 'x';
      const width = across === 'x' ? area.w : area.h;
      assert(crossesGate(game, axis, center, area), `${id}/${lane} should be open without a hull`);
      for (let step = 0; step <= 20; step++) {
        const fraction = step / 20;
        const hull = { ...center, [across]: area[across] + fraction * width };
        assert(game._positionFree(hull.x, hull.y, game.player, true));
        game.wrecks = placeHulls([hull]);
        assert.equal(crossesGate(game, axis, hull, area), false, `${id}/${lane} leaked at lateral fraction ${fraction}`);
        assert(bypass.slice(1).every((point, index) => clearSegment(game, bypass[index], point)));
        game.wrecks = [];
      }
    }
  }
});

test('magnetic B lets either single hull be passed locally and closes with both', () => {
  const game = new Game(MAP_CONFIGS.magnetic);
  const { blockers, usefulAreas: [area], bypass } = game.config.TACTICS.B;
  for (const hull of blockers) {
    game.wrecks = placeHulls([hull]);
    assert(crossesGate(game, 'y', hull, area));
  }
  game.wrecks = placeHulls(blockers);
  assert.equal(crossesGate(game, 'y', blockers[0], area), false);
  assert(bypass.slice(1).every((point, index) => clearSegment(game, bypass[index], point)));
});

test('either city B blocker closes the short route at a different street', () => {
  const game = new Game(MAP_CONFIGS.city);
  const { blockers, usefulAreas, bypass } = game.config.TACTICS.B;
  for (const [index, axis] of ['x', 'x'].entries()) {
    const hull = blockers[index], area = usefulAreas[index];
    game.wrecks = [];
    assert(crossesGate(game, axis, hull, area));
    game.wrecks = placeHulls([hull]);
    assert.equal(crossesGate(game, axis, hull, area), false);
    assert(bypass.slice(1).every((point, index) => clearSegment(game, bypass[index], point)));
  }
});
