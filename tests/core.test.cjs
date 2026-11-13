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
