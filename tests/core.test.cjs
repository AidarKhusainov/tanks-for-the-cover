'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

function mediumAt(x, y, id = 'e-test') {
  return { id, type: 'medium', x, y, r: 0.5, hp: 0, maxHp: 60, dead: false };
}

test('battlefield has three entrances and four waves', () => {
  assert.deepEqual(Object.keys(CONFIG.SPAWNS).sort(), ['A', 'B', 'C']);
  assert.equal(CONFIG.WAVES.length, 4);
  assert.equal(CONFIG.AI_MODE, 'roles');
});

test('enemies have immediate fire without windup', () => {
  assert.equal(CONFIG.ENEMY_WINDUP, 0);
  assert.equal(CONFIG.ENEMY_TYPES.light.range, 6);
  assert.equal(CONFIG.ENEMY_TYPES.light.cooldown, 1.4);
  assert.equal(CONFIG.ENEMY_TYPES.medium.cooldown, 1.2);
});

test('new attempt starts in preparation, with healthy player and base', () => {
  const game = new Game();
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.hp, 60);
  assert.equal(game.base.hp, 240);
  assert.equal(game.wrecks.length, 0);
});

test('wave starts and creates the first enemy at a scheduled entrance', () => {
  const game = new Game();
  assert.equal(game.startWave(), true);
  assert.equal(game.phase, 'battle');
  assert.equal(game.enemies.length, 1);
  assert.equal(game.enemies[0].lane, 'A');
  assert.ok(game.remaining >= game.enemies.length);
});

test('player cannot cross a solid ruin or enter enemy spawn zones', () => {
  const game = new Game();
  assert.equal(game._positionFree(6, 4, game.player, true), false);
  assert.equal(game._positionFree(3, 1.5, game.player, true), false);
  assert.equal(game._positionFree(3, 1.5, game.player, false), true);
});

test('medium death creates a wreck at the exact position', () => {
  const game = new Game();
  const enemy = mediumAt(9.4, 12.5);
  game._killEnemy(enemy);
  assert.equal(enemy.dead, true);
  assert.equal(game.wrecks.length, 1);
  assert.equal(game.wrecks[0].x, 9.4);
  assert.equal(game.wrecks[0].y, 12.5);
  assert.equal(game.wrecks[0].expiresAfterWave, 2);
});

test('medium destroyed inside an entrance does not create a wreck', () => {
  const game = new Game();
  game._killEnemy(mediumAt(3, 1.5));
  assert.equal(game.wrecks.length, 0);
});

test('dismantling a wreck repairs the base and supports undo', () => {
  const game = new Game();
  game.base.hp = 197;
  game._killEnemy(mediumAt(9.4, 12.5));
  const wreckId = game.wrecks[0].id;
  const result = game.repairFromWreck(wreckId);
  assert.equal(result.ok, true);
  assert.equal(result.hp, 30);
  assert.equal(game.base.hp, 227);
  assert.equal(game.wrecks.length, 0);
  assert.equal(game.undo(), true);
  assert.equal(game.base.hp, 197);
  assert.equal(game.wrecks[0].id, wreckId);
});

test('medium wreck lasts through its next wave and then expires', () => {
  const game = new Game();
  game._killEnemy(mediumAt(9.4, 12.5));
  assert.equal(game.wrecks[0].expiresAfterWave, 2);
  game._completeWave();
  assert.equal(game.waveNumber, 2);
  assert.equal(game.wrecks.length, 1);
  game._completeWave();
  assert.equal(game.waveNumber, 3);
  assert.equal(game.wrecks.length, 0);
});

test('route preview includes all three entrance lanes', () => {
  const game = new Game();
  const routes = game.getPreviewPaths();
  assert.deepEqual(Array.from(routes, route => route.lane).sort(), ['A', 'B', 'C']);
  assert.ok(routes.every(route => route.points.length >= 2));
});

test('enemy has immediate shot at visible player when weapon is ready', () => {
  const game = new Game();
  game.phase = 'battle';
  game.player.x = 10;
  game.player.y = 8;
  game._spawnQueue = [];
  game.enemies.push({
    id: 'e1', type: 'light', lane: 'A', x: 10, y: 6, r: 0.5,
    hp: 20, maxHp: 20, cooldown: 0, windup: 0,
    dead: false, route: [], routeIndex: 0, routeVersion: -1
  });
  game.update(1 / 60);
  assert.equal(game.enemies[0].windup, 0);
  assert.ok(game.enemies[0].cooldown > 0);
  assert.ok(game.bullets.some(bullet => bullet.team === 'enemy'));
});

test('destroyed base ends the attempt in defeat', () => {
  const game = new Game();
  game.startWave();
  game.base.hp = 0;
  game.update(1 / 60);
  assert.equal(game.phase, 'lost');
});

function controlScene(config = CONFIG) {
  const game = new Game(config);
  for (const [id, x, y] of [['left', 12.2, 13.4], ['right', 15.8, 13.4], ['extra', 11, 13.4]]) {
    assert.equal(game._positionFree(x, y, { r: 0.5 }, false), true, id);
    game.wrecks.push({ id, x, y, r: 0.5, hp: 60, maxHp: 60, expiresAfterWave: 2 });
  }
  return game;
}

function hullContacts(game, from, points) {
  const contacts = [];
  for (const to of points) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSq = dx * dx + dy * dy;
    for (const hull of game.wrecks) {
      const progress = lengthSq ? Math.max(0, Math.min(1,
        ((hull.x - from.x) * dx + (hull.y - from.y) * dy) / lengthSq)) : 0;
      const clearance = (hull.x - from.x - progress * dx) ** 2 + (hull.y - from.y - progress * dy) ** 2;
      if (clearance < (0.5 + hull.r) ** 2 - 1e-7) contacts.push(hull.id);
    }
    from = to;
  }
  return contacts;
}

function pathLength(points) {
  return points.slice(1).reduce((length, point, i) =>
    length + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0);
}

test('blocked navigation finds only left in the control scene and preserves that hull after smoothing', () => {
  const game = controlScene();
  const start = CONFIG.SPAWNS.A;
  const route = game.debugRoute(start.x, start.y);
  assert.equal(route.blockedWreckId, 'left');
  assert.deepEqual([...new Set(hullContacts(game, start, route.points))], ['left']);
  let from = start;
  for (const to of route.points) {
    assert.equal(game._navigationSegmentFree(from.x, from.y, to.x, to.y, true), true);
    from = to;
  }
  game.wrecks = game.wrecks.filter(hull => hull.id !== 'left');
  assert.equal(game.debugRoute(start.x, start.y).blockedWreckId, null);
});

test('breach minimizes distinct hulls before grid length, even with repeated contact on the shortest route', () => {
  const game = controlScene();
  const { x, y } = CONFIG.SPAWNS.B;
  const raw = game._findBreachPath?.(x, y) ?? [];
  const contacts = hullContacts(game, { x, y }, raw.slice(1));
  assert.ok(contacts.length > 1);
  assert.deepEqual([...new Set(contacts)], ['right']);
  // Exhaustive single-hull removal on this graph gives 16.867359793658096 via right
  // versus 24.83487421493029 via left. The right route crosses more occupied edges.
  assert.ok(Math.abs(pathLength(raw) - 16.867359793658096) < 1e-7);
  assert.equal(game.debugRoute(x, y).blockedWreckId, 'right');
});

test('a free detour beats a shorter breach through a nearly destroyed hull', () => {
  const game = controlScene();
  const { x, y } = CONFIG.SPAWNS.A;
  game.wrecks = game.wrecks.filter(hull => hull.id !== 'right');
  game.wrecks[0].hp = 1;
  const route = game.debugRoute(x, y);
  assert.ok(route.points.length > 0);
  assert.equal(route.blockedWreckId, null);
  assert.deepEqual(hullContacts(game, { x, y }, route.points), []);
});

test('equal-length breaches are stable across hull order, HP and live tanks', () => {
  const config = { ...CONFIG, WALLS: [
    { x: 11.8, y: 10.6, w: 4.4, h: 1.6 },
    { x: 0, y: 14.6, w: 28, h: 0.4 }
  ] };
  const game = controlScene(config);
  const { x, y } = { x: 14, y: 9.875 };
  game.wrecks.pop();
  const openLengths = game.wrecks.map(hull => {
    const singleHullGame = new Game(config);
    singleHullGame.wrecks.push(hull);
    const open = singleHullGame._findOpenPath(x, y);
    assert.ok(open);
    return pathLength(open);
  });
  assert.ok(Math.abs(openLengths[0] - openLengths[1]) < 1e-7);
  const route = game.debugRoute(x, y);
  assert.ok(['left', 'right'].includes(route.blockedWreckId));
  const rearranged = new Game(config);
  rearranged.wrecks = game.wrecks.map(hull => ({ ...hull, hp: 1 })).reverse();
  rearranged.enemies.push({ id: 'live', x: 12.4, y: 9.8, r: 0.5, hp: 20 });
  rearranged.player.x = 15.6;
  rearranged.player.y = 9.8;
  assert.deepEqual(rearranged.debugRoute(x, y), route);
});

test('blocked preview ends at the same first contact used by the enemy and updates from its current position', () => {
  const game = controlScene();
  const { x, y } = CONFIG.SPAWNS.A;
  const enemy = { id: 'test', x, y, r: 0.5, type: 'medium', hp: 60 };
  game.enemies.push(enemy);
  game._assignRoute(enemy);
  const preview = game.getPreviewPaths().find(path => path.lane === 'A');
  const hull = game.wrecks.find(hull => hull.id === 'left');
  const end = preview.points.at(-1);
  assert.equal(preview.blockedWreckId, 'left');
  assert.equal(enemy.targetWreckId, 'left');
  assert.deepEqual(end, enemy.route.at(-1));
  assert.ok(Math.abs(Math.hypot(end.x - hull.x, end.y - hull.y) - (enemy.r + hull.r)) < 1e-7);
  assert.deepEqual(hullContacts(game, { x, y }, preview.points), []);
  game.player.alive = false;
  for (let i = 0; i < 900; i++) {
    game._followRoute(enemy, 1.7, 1 / 60);
    assert.equal(game._positionFree(enemy.x, enemy.y, enemy, false), true);
  }
  assert.ok(Math.hypot(enemy.x - end.x, enemy.y - end.y) < 1e-7);
  const previousVersion = enemy.routeVersion;
  game._applyHit({ kind: 'wreck', object: hull }, { team: 'enemy', damage: 60 });
  game._updateEnemy(enemy, 1 / 60);
  assert.ok(enemy.routeVersion > previousVersion);
  assert.equal(enemy.targetWreckId, null);
  assert.ok(game._navigationSegmentFree(end.x, end.y, enemy.route[0].x, enemy.route[0].y, false));
  for (let i = 0; i < 60; i++) game._updateEnemy(enemy, 1 / 60);
  assert.ok(Math.hypot(enemy.x - end.x, enemy.y - end.y) > 0.2);
  const reopened = game.getPreviewPaths().find(path => path.lane === 'A');
  assert.equal(reopened.blockedWreckId, null);
  assert.deepEqual(reopened.points.at(-1), enemy.route.at(-1));
});
