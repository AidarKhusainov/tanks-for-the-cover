'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');
const STEP = 1 / 60;

function scene(type, { player, tank, hp, blockers = [] }) {
  const game = new Game();
  game.phase = 'battle';
  Object.assign(game.player, { x: player[0], y: player[1] });
  const spec = CONFIG.ENEMY_TYPES[type];
  const enemy = { id: 'target', type, x: tank[0], y: tank[1], r: 0.5, hp: hp ?? spec.hp, cooldown: 10 };
  game.enemies.push(enemy);
  for (const blocker of blockers) {
    const { kind, x, y } = blocker;
    const body = { id: kind, type: kind === 'wreck' ? 'medium' : 'heavy', x, y, r: 0.5, hp: 60, maxHp: 60,
      cooldown: 10, expiresAfterWave: 2 };
    game[kind === 'wreck' ? 'wrecks' : 'enemies'].push(body);
  }
  return { game, enemy };
}

function fire({game, enemy}, aimX, aimY, speed) {
  assert.ok(game.player.cooldown <= 1e-7);
  const shots = game.stats.shots;
  const trace = [];
  let bulletId;
  for (let step = 0; step < 10; step++) {
    const before = { x: enemy.x, y: enemy.y };
    game.update(STEP, { fire: step === 0, aimX, aimY });
    const bullet = game.bullets.find(bullet => bullet.team === 'player');
    bulletId ??= bullet?.id;
    if (enemy.dodge) {
      const moved = Math.hypot(enemy.x - before.x, enemy.y - before.y);
      assert.equal(enemy.dodge.bulletId, bulletId);
      assert.ok(moved <= speed * STEP + 1e-7);
      trace.push({ moved, hp: enemy.hp });
    }
  }
  assert.equal(game.stats.shots, shots + 1);
  assert.ok(bulletId, 'real projectile observed in flight');
  const hits = Array.from(game.drainEvents()).filter(event => event.type === 'hit' && event.side === 'player');
  game.update(0.30);
  assert.equal(enemy.dodge ?? null, null, 'return to ordinary movement');
  return { bulletId, trace, hits };
}

function grazingAim({game, enemy}, offset) {
  const {x, y} = game.player;
  const angle = Math.atan2(enemy.y - y, enemy.x - x);
  const sideAngle = angle + Math.asin(offset / Math.hypot(enemy.x - x, enemy.y - y));
  return [x + 6 * Math.cos(sideAngle), y + 6 * Math.sin(sideAngle)];
}

for (const type of ['light', 'medium']) {
  test(`${type} dodges two distinct shots after an initial miss without resetting`, () => {
    const isLight = type === 'light';
    const fixture = scene(type, isLight
      ? { player: [3, 6.8], tank: [8.6, 7] }
      : { player: [4, 12.15], tank: [9.4, 12.5] });
    const { enemy, game } = fixture;
    const hp = enemy.hp;
    const speed = isLight ? 3 : 1.7;
    const miss = fire(fixture, ...grazingAim(fixture, -0.9), speed);
    assert.equal(miss.trace.length, 0);
    assert.equal(miss.hits.length, 0);

    const dodged = [];
    for (let i = 0; i < 2; i++) {
      const before = { x: enemy.x, y: enemy.y };
      const shot = fire(fixture, ...grazingAim(fixture, i ? 0.39 : -0.39), speed);
      assert.ok(shot.trace.some(step => step.moved > 0.01));
      assert.ok(shot.trace.some(step => Math.abs(step.moved - speed * STEP) < 1e-6));
      assert.equal(shot.hits.length, 0);
      assert.equal(enemy.hp, hp);
      assert.equal(game.enemies.find(candidate => candidate.id === enemy.id), enemy);
      assert.ok(Math.abs(enemy.y - before.y) > 0.09);
      dodged.push(shot.bulletId);
    }
    assert.equal(new Set([miss.bulletId, ...dodged]).size, 3);

    const before = { x: enemy.x, y: enemy.y };
    game.update(STEP);
    const moved = Math.hypot(enemy.x - before.x, enemy.y - before.y);
    if (isLight) assert.ok(Math.abs(moved - 2.6 * STEP) < 1e-6);
    else {
      assert.equal(enemy.stationaryTarget, 'base');
      assert.equal(moved, 0);
    }
  });
}

test('the center and late grazing shots still hit', () => {
  for (const [player, tank] of [[[3, 6.8], [8.6, 6.8]], [[6.9, 6.8], [8.6, 7]]]) {
    const fixture = scene('light', { player, tank });
    const shot = fire(fixture, 20, player[1], 3);
    assert.equal(shot.trace.length, 0);
    assert.equal(shot.hits[0]?.target, 'enemy');
    assert.equal(fixture.enemy.hp, 0);
  }
});

test('wall, wreck and a live tank can intercept a shot before the target', () => {
  for (const [kind, player, tank, blockers] of [
    ['wall', [3.8, 4.4], [9.8, 4.55], []],
    ['wreck', [3, 6.8], [8.6, 7], [{kind: 'wreck', x: 5.5, y: 6.8}]],
    ['enemy', [3, 6.8], [8.6, 7], [{kind: 'enemy', x: 5.5, y: 6.8}]],
  ]) {
    const fixture = scene('light', { player, tank, blockers });
    const shot = fire(fixture, 20, player[1], 3);
    assert.equal(shot.trace.length, 0);
    assert.equal(shot.hits[0]?.target, kind);
    assert.equal(fixture.enemy.hp, 20);
  }
});

test('a wall, wreck or tank blocking the only viable side leaves a hit', () => {
  for (const [player, tank, blockers] of [
    [[2, 6.5], [6.5, 6.3], []],
    [[3, 6.8], [8.6, 7], [{kind: 'wreck', x: 8.6, y: 8}]],
    [[3, 6.8], [8.6, 7], [{kind: 'enemy', x: 8.6, y: 8}]],
  ]) {
    const fixture = scene('light', { player, tank, blockers });
    const shot = fire(fixture, 20, player[1], 3);
    assert.equal(shot.trace.length, 0);
    assert.equal(shot.hits[0]?.target, 'enemy');
    assert.equal(fixture.enemy.hp, 0);
  }
});

test('light predicts that its pursuit will enter a line currently clear of its hull', () => {
  const fixture = scene('light', { player: [3, 6.8], tank: [8.6, 7.33] });
  const shot = fire(fixture, 20, 6.8, 3);
  assert.ok(shot.trace.length > 0);
  assert.equal(shot.hits.length, 0);
});

test('medium can still leave a wreck across the chosen line with a centered first shot', () => {
  const start = { player: [4, 12.15], tank: [9.4, 12.5], hp: 20 };
  const edge = scene('medium', start);
  const center = scene('medium', start);
  const blocksLine = ({game}) => game._firstCollision(8, 12.15, 11, 12.15, game.player.id)?.kind === 'wreck';

  const first = fire(edge, 20, 12.15, 1.7);
  assert.ok(first.trace.length > 0);
  assert.equal(edge.game.wrecks.length, 0);
  fire(edge, edge.enemy.x, edge.enemy.y, 1.7);
  assert.equal(edge.game.wrecks.length, 1);
  assert.equal(edge.game.wrecks[0].x, 9.4);
  assert.ok(edge.game.wrecks[0].y > 12.65);
  assert.equal(blocksLine(edge), false);

  const precise = fire(center, center.enemy.x, center.enemy.y, 1.7);
  assert.equal(precise.trace.length, 0);
  assert.equal(center.game.wrecks.length, 1);
  assert.equal(center.game.wrecks[0].x, 9.4);
  assert.equal(center.game.wrecks[0].y, 12.5);
  assert.equal(blocksLine(center), true);
});

test('medium predicts when a moving tank will leave the line before the shot reaches it', () => {
  const fixture = scene('medium', { player: [4, 12.15], tank: [9.4, 12.5],
    blockers: [{kind: 'enemy', x: 6.2, y: 12.6475}] });
  const shot = fire(fixture, 20, 12.15, 1.7);
  assert.ok(shot.trace.length > 0);
  assert.equal(fixture.enemy.hp, 60);
});

test('a target can dodge even when a tank farther down the line takes the shot', () => {
  const fixture = scene('light', { player: [3, 6.8], tank: [7, 7.15],
    blockers: [{kind: 'enemy', x: 8.6, y: 6.8}] });
  const shot = fire(fixture, 20, 6.8, 3);
  assert.ok(shot.trace.length > 0);
  assert.equal(fixture.enemy.hp, 20);
  assert.equal(fixture.game.enemies.find(enemy => enemy.id === 'enemy').hp, 40);
});

test('a pursuing tank cannot substitute standing still for a blocked sidestep', () => {
  const fixture = scene('light', { player: [3, 6.8], tank: [8.6, 7.33],
    blockers: [{kind: 'wreck', x: 8.6, y: 8.33}] });
  const shot = fire(fixture, 20, 6.8, 3);
  assert.equal(shot.trace.length, 0);
  assert.equal(shot.hits[0]?.target, 'enemy');
  assert.equal(fixture.enemy.hp, 0);
});

test('medium can dodge when the tank ahead is already dodging the same shot', () => {
  const fixture = scene('medium', { player: [4, 12.15], tank: [9.4, 12.5] });
  const light = { id: 'front', type: 'light', x: 6.6, y: 12.54, r: 0.5, hp: 20, cooldown: 10 };
  fixture.game.enemies.push(light);
  const shot = fire(fixture, 20, 12.15, 1.7);
  assert.ok(shot.trace.length > 0);
  assert.equal(light.hp, 20);
  assert.equal(fixture.enemy.hp, 60);
});

test('a tank that has cleared the shot does not return into it when blocked farther out', () => {
  const fixture = scene('light', { player: [3, 6.8], tank: [8.6, 7.22],
    blockers: [{kind: 'wreck', x: 8.55679, y: 8.32}] });
  const shot = fire(fixture, 20, 6.8, 3);
  assert.ok(shot.trace.some(step => step.moved > 0.01));
  assert.equal(shot.hits.length, 0);
  assert.equal(fixture.enemy.hp, 20);
});
