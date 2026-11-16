'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

const STEP = 1 / 60;
const arena = { ...CONFIG, WALLS: [] };

function duel({ baseHp = 240, heavyHp = 20, cooldown = 0, ready = true, walls = [] } = {}) {
  const game = new Game(walls.length ? { ...arena, WALLS: walls } : arena);
  game.phase = 'battle';
  game.base.hp = baseHp;
  const heavy = { id: 'heavy', type: 'heavy', x: 11, y: 13.5, r: 0.5, hp: heavyHp, cooldown };
  game.enemies.push(heavy);
  Object.assign(game.player, { x: 11, y: 10.5, angle: Math.PI / 2, cooldown: ready ? 0 : 0.3 });
  return { game, heavy };
}

function decisions(game) {
  return JSON.parse(game.exportAttemptLog()).events.filter(event => event.type === 'heavy_target');
}

test('heavy spends its ready lethal shot on the base before the aiming player can reload', () => {
  const { game, heavy } = duel({ baseHp: 20, ready: false });
  game.update(STEP);
  assert.equal(game.bullets.find(shot => shot.ownerId === heavy.id)?.dy, 0);
  assert.equal(decisions(game).at(-1)?.target, 'base');
  game.update(0.22, { fire: true, aimX: heavy.x, aimY: heavy.y });
  assert.equal(game.phase, 'lost');
  assert.equal(heavy.hp, 20);
});

test('heavy completes two base hits across a reload when the visible player is not aiming at it', () => {
  const { game, heavy } = duel({ baseHp: 40 });
  game.update(0.25, { aimX: 9, aimY: 9 });
  assert.equal(game.base.hp, 20);
  assert.equal(decisions(game).at(-1)?.baseHits, 2);
  assert.ok(heavy.cooldown > 1.7);
  game.update(1.7, { aimX: 9, aimY: 9 });
  assert.equal(game.base.hp, 20, 'the second shot must wait for the normal reload');
  game.update(0.3, { aimX: 9, aimY: 9 });
  assert.equal(game.base.hp, 0);
});

test('low-HP heavy fights a threatening player when the base needs many more shots', () => {
  const { game, heavy } = duel();
  const start = { x: heavy.x, y: heavy.y };
  game.update(STEP);
  const shot = game.bullets.find(shot => shot.ownerId === heavy.id);
  assert.ok(shot?.dy < -0.99, 'the tank fires at the player instead of the base');
  assert.equal(decisions(game).at(-1)?.reason, 'player_threat');
  game.update(0.34, { aimX: heavy.x, aimY: heavy.y });
  assert.equal(game.player.hp, 40);
  assert.equal(game.base.hp, 240);
  assert.ok(Math.hypot(heavy.x - start.x, heavy.y - start.y) < 0.5);
});

test('an unfinished reload makes a nominally lethal base shot too late', () => {
  const { game, heavy } = duel({ baseHp: 20, cooldown: 1.1 });
  game.update(STEP);
  assert.equal(decisions(game).at(-1)?.target, 'player');
  assert.ok(heavy.cooldown > 1, 'switching the turret does not reset its reload');
  assert.equal(game.bullets.length, 0);
  for (let frame = 0; frame < 84; frame++) {
    game.update(STEP, { aimX: heavy.x, aimY: heavy.y });
  }
  assert.equal(game.player.hp, 40);
  assert.equal(game.base.hp, 20);
});

test('one nearby aim fluctuation holds the duel but losing range returns to the base', () => {
  const { game, heavy } = duel();
  game.update(STEP);
  game.update(STEP, { aimX: 9, aimY: 9 });
  assert.equal(decisions(game).at(-1)?.target, 'player');
  Object.assign(game.player, { x: 11, y: 6.5 });
  game.update(STEP, { aimX: heavy.x, aimY: heavy.y });
  assert.equal(decisions(game).at(-1)?.target, 'base');
});

test('a brief miss in the player aim does not change a contested two-shot finish', () => {
  const { game, heavy } = duel({ baseHp: 40, cooldown: 0.15 });
  game.update(STEP);
  assert.equal(decisions(game).at(-1)?.target, 'player');
  game.update(STEP, { aimX: 9, aimY: 9 });
  assert.equal(decisions(game).at(-1)?.target, 'player');
  game.update(STEP, { aimX: heavy.x, aimY: heavy.y });
  assert.deepEqual(decisions(game).map(event => event.target), ['player']);
});

test('a wall occluding the base prevents a false lethal priority', () => {
  const { game, heavy } = duel({ baseHp: 20, walls: [{ x: 11.8, y: 12.9, w: 0.2, h: 1.2 }] });
  game.update(STEP);
  assert.ok(game.bullets.find(shot => shot.ownerId === heavy.id)?.dy < -0.99);
  assert.equal(decisions(game).at(-1)?.target, 'player');
  assert.equal(decisions(game).at(-1)?.baseHitSeconds, null);
});

test('a wall occluding the player ends the duel without waiting for hysteresis', () => {
  const { game } = duel({ walls: [{ x: 9, y: 8, w: 4, h: 0.2 }] });
  game.update(STEP);
  assert.equal(decisions(game).at(-1)?.target, 'player');
  Object.assign(game.player, { x: 11, y: 7 });
  game.update(STEP);
  assert.equal(decisions(game).at(-1)?.target, 'base');
});

test('the target journal counts an aimed shell already in flight even if the turret turns away', () => {
  const { game, heavy } = duel();
  game._shoot(game.player, heavy, 'player', 40, 20, 6);
  game.update(STEP, { aimX: 9, aimY: 9 });
  assert.equal(decisions(game).at(-1)?.target, 'player');
  assert.equal(decisions(game).at(-1)?.reason, 'player_threat');
});

test('an ally covering the whole base contour prevents a false lethal priority', () => {
  const { game, heavy } = duel({ baseHp: 20 });
  game.enemies.push({ id: 'base-blocker', type: 'heavy', x: 12.01, y: 13.5, r: 0.5, hp: 120 });
  game.update(STEP);
  const shot = game.bullets.find(shot => shot.ownerId === heavy.id);
  assert.ok(shot?.dy < -0.99);
  const firstDecision = decisions(game).find(event => event.enemyId === heavy.id);
  assert.equal(firstDecision?.target, 'player');
  assert.equal(firstDecision?.baseHitSeconds, null);
});
