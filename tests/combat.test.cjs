'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

const FRAME = 1 / 60;
const OPEN_ARENA = { ...CONFIG, WALLS: [] };
const FIRING_RANGE = {
  ...OPEN_ARENA,
  WAVES: [[{ start: 10, lane: 'A', types: ['light'] }]]
};

function setPlayer(game, x, y) {
  Object.assign(game.player, { x, y });
}

function addEnemy(game, type, x, y) {
  const hp = CONFIG.ENEMY_TYPES[type].hp;
  const enemy = { id: `fixture-${game.enemies.length}`, type, x, y, r: 0.5, hp, dead: false };
  game.enemies.push(enemy);
  return enemy;
}

function setUpPursuit(enemyX, enemyY, playerX, playerY, config = OPEN_ARENA) {
  const game = new Game(config);
  game.phase = 'battle';
  setPlayer(game, playerX, playerY);
  const enemy = addEnemy(game, 'light', enemyX, enemyY);
  return { game, enemy };
}

test('player taps and held fire share the 0.30 s interval', () => {
  const game = new Game(FIRING_RANGE);
  setPlayer(game, 3, 6);
  game.startWave();
  const fire = { fire: true, aimX: 9, aimY: 6 };

  game.update(FRAME, fire);
  assert.equal(game.stats.shots, 1);
  game.update(FRAME);
  game.update(FRAME, fire);
  assert.equal(game.stats.shots, 1, 'a second tap cannot bypass the interval');
  game.update(15 * FRAME, fire);
  assert.equal(game.stats.shots, 1, 'the interval has not expired after 17 frames');
  game.update(FRAME, fire);
  assert.equal(game.stats.shots, 2, 'holding fire repeats at 0.30 s');
  game.update(FRAME);
  game.update(FRAME, fire);
  assert.equal(game.stats.shots, 2, 'held fire also sets the interval for the next tap');
});

test('aiming at the tank center neither fires nor spends the ready shot', () => {
  const game = new Game(FIRING_RANGE);
  setPlayer(game, 3, 6);
  game.startWave();

  game.update(FRAME, { fire: true, aimX: 3, aimY: 6 });
  assert.equal(game.stats.shots, 0);
  assert.equal(game.bullets.length, 0);
  game.update(FRAME, { fire: true, aimX: 9, aimY: 6 });
  assert.equal(game.stats.shots, 1);
});

test('a fast projectile hits the first contact along its finite segment', () => {
  const game = new Game(OPEN_ARENA);
  game.phase = 'battle';
  setPlayer(game, 3, 6);
  const far = addEnemy(game, 'medium', 8, 6);
  const near = addEnemy(game, 'medium', 5, 6);

  game._updatePlayer(FRAME, { fire: true, aimX: far.x, aimY: far.y });
  game._updateBullets(0.15);
  assert.equal(near.hp, 40);
  assert.equal(far.hp, 60);
  assert.equal(game.bullets.length, 0);
});

test('projectile range includes contact at exactly six units', () => {
  for (const [targetX, hp] of [[9.5, 40], [9.51, 60]]) {
    const game = new Game(OPEN_ARENA);
    game.phase = 'battle';
    setPlayer(game, 3, 6);
    const target = addEnemy(game, 'medium', targetX, 6);

    game._updatePlayer(FRAME, { fire: true, aimX: target.x, aimY: target.y });
    game._updateBullets(0.2);
    assert.equal(target.hp, hp, `target center at x=${targetX}`);
    assert.equal(game.bullets.length, 0);
  }
});

test('a teammate beyond the aim point intercepts an enemy projectile without damage', () => {
  const game = new Game(OPEN_ARENA);
  game.phase = 'battle';
  setPlayer(game, 8, 6);
  const shooter = addEnemy(game, 'medium', 4, 6);
  const ally = addEnemy(game, 'medium', 9, 6);

  game._updateEnemy(shooter, FRAME);
  assert.equal(game.bullets.length, 1);
  setPlayer(game, 8, 7);
  game._updateBullets(0.5);

  const hit = game.drainEvents().find(event => event.type === 'hit');
  assert.equal(hit?.target, 'enemy');
  assert.equal(hit.x, 8.5);
  assert.equal(ally.hp, 60);
  assert.equal(game.player.hp, 60);
  assert.equal(game.bullets.length, 0);
});

test('medium prioritizes base then route wreck then player, while light prefers player', () => {
  const game = new Game(OPEN_ARENA);
  setPlayer(game, 10, 16);
  const enemy = addEnemy(game, 'medium', 10, 13.5);
  const wreck = { id: 'route-wreck', x: 11, y: 11.5, r: 0.5, hp: 60, expiresAfterWave: 2 };
  game.wrecks.push(wreck);
  enemy.targetWreckId = wreck.id;

  assert.equal(game._chooseTarget(enemy, 5)?.kind, 'base');
  enemy.type = 'light';
  assert.equal(game._chooseTarget(enemy, 6)?.kind, 'player');
  enemy.type = 'medium';

  // This wreck covers the base silhouette without hiding the player.
  Object.assign(wreck, { x: 11.3, y: 13.5 });
  assert.equal(game._chooseTarget(enemy, 5)?.object, wreck);
  enemy.targetWreckId = null;
  assert.equal(game._chooseTarget(enemy, 5)?.kind, 'player');
  game.player.alive = false;
  assert.equal(game._chooseTarget(enemy, 5), null, 'an unassigned wreck is never a fallback');
});

test('a ready light waits behind cover and fires immediately while moving once it sees the player', () => {
  const { game, enemy } = setUpPursuit(4, 4, 10, 4, CONFIG);
  enemy.cooldown = 0.1;
  game.update(0.2);
  assert.equal(enemy.pressure, null, 'a nearby player behind the ruin does not start a chase');
  assert.equal(enemy.cooldown, 0);
  assert.equal(game.bullets.length, 0);

  setPlayer(game, 3, 8);
  const origin = { x: enemy.x, y: enemy.y };
  game.update(FRAME);
  const bullet = game.bullets.find(item => item.ownerId === enemy.id);
  assert.ok(bullet);
  assert.ok(enemy.pressure);
  assert.ok(Math.hypot(enemy.x - origin.x, enemy.y - origin.y) > 0);
  const direction = { x: bullet.dx, y: bullet.dy };
  game.update(FRAME, { x: -1 });
  assert.equal(bullet.dx, direction.x);
  assert.equal(bullet.dy, direction.y);
});

test('a light closes on a visible player outside weapon range instead of shooting the base', () => {
  const { game, enemy } = setUpPursuit(10, 13.5, 2.99, 13.5);
  assert.equal(game._chooseTarget(enemy, 6)?.kind, 'base', 'the base is visible before pursuit');

  game.update(FRAME);
  assert.equal(enemy.pressure, null, 'a player just beyond seven units does not start a chase');
  assert.equal(game.bullets.length, 1);
  assert.equal(enemy.x, 10, 'base fire stops the enemy');

  setPlayer(game, 3.25, 13.5);
  enemy.cooldown = 0;
  game.update(FRAME);
  assert.ok(enemy.pressure);
  assert.ok(enemy.x < 10);
  assert.equal(game.bullets.length, 1, 'pursuit takes precedence over a second shot at the base');
  assert.equal(enemy.cooldown, 0);
});

test('a shot aims at the nearest visible base edge when a ruin hides the center', () => {
  const game = new Game();
  game.phase = 'battle';
  const enemy = addEnemy(game, 'medium', 11, 11.1);
  assert.equal(game._firstCollision(enemy.x, enemy.y, 14, 13.5, enemy.id)?.kind, 'wall');

  game.update(FRAME);
  assert.ok(game.bullets.some(bullet => bullet.ownerId === enemy.id));
  game.update(0.4);

  const hit = game.drainEvents().find(event => event.type === 'hit');
  assert.equal(hit?.target, 'base');
  assert.ok(Math.abs(hit.x - 13.1) < 1e-6, 'the projectile reaches the left edge of the base');
  // The nearest clear ray passes just below the lower left corner (11.8, 12.2) of the ruin.
  const tangentY = 11.1 + (12.2 - 11.1) / (11.8 - 11) * (13.1 - 11);
  assert.ok(hit.y >= tangentY - 1e-6 && hit.y < tangentY + 0.001, `hit at y=${hit.y}`);
  assert.equal(game.base.hp, 228);
});

test('light pursues the last visible point for up to 0.8 s after the player hides', () => {
  const { game, enemy } = setUpPursuit(4, 6.2, 10, 6.2, CONFIG);
  game.update(FRAME);
  assert.ok(enemy.pressure);
  setPlayer(game, 10, 6.6);
  game.update(FRAME);
  assert.equal(enemy.pressure.lastSeen.y, 6.6);
  const before = Math.hypot(enemy.x - 10, enemy.y - 6.6);

  setPlayer(game, 10, 4);
  game.update(47 * FRAME);
  assert.equal(enemy.pressure?.lastSeen.x, 10);
  assert.equal(enemy.pressure?.lastSeen.y, 6.6);
  assert.ok(Math.hypot(enemy.x - 10, enemy.y - 6.6) < before);
  game.update(FRAME);
  assert.equal(enemy.pressure, null);
});

test('light ends pursuit after 3 s, routes from its current position and waits 2 s to reacquire', () => {
  const { game, enemy } = setUpPursuit(9, 13.5, 9, 9.5);
  const originalRoute = game.debugRoute(enemy.x, enemy.y).points;
  game.update(179 * FRAME);
  assert.ok(enemy.pressure);
  assert.ok(Math.abs(enemy.y - 11.5) < 1e-6, 'the enemy stopped two units from the player');
  const returnRoute = game.debugRoute(enemy.x, enemy.y).points;
  assert.ok(returnRoute.length);
  assert.notDeepEqual(returnRoute, originalRoute, 'the pursuit changed the available route');

  game.update(FRAME);
  assert.equal(enemy.pressure, null);
  assert.deepEqual(enemy.route, returnRoute);
  assert.ok(enemy.x > 9, 'the enemy resumes movement toward the base');
  game.update(119 * FRAME);
  assert.equal(enemy.pressure, null);
  assert.ok(game._canSeePlayer(enemy), 'the player is still in sight just before reacquisition');
  game.update(FRAME);
  assert.ok(enemy.pressure);
});

test('light ends pursuit after travelling four units from its origin', () => {
  const { game, enemy } = setUpPursuit(4, 4, 11, 4);
  game.update(92 * FRAME);
  assert.ok(enemy.pressure);
  assert.ok(enemy.x < 8);

  game.update(FRAME);
  assert.equal(enemy.pressure, null);
  assert.ok(Math.abs(enemy.x - 8) < 1e-6, 'the leash limits the final movement step');
});

test('light ends a visible pursuit after 0.4 s of physical blockage', () => {
  // The ray clears the ruin corner, but the tank circle cannot follow it.
  const { game, enemy } = setUpPursuit(4.7, 3, 8, 2.3, CONFIG);
  game.update(23 * FRAME);
  assert.ok(enemy.pressure);
  assert.ok(game._canSeePlayer(enemy));

  game.update(FRAME);
  assert.equal(enemy.pressure, null);
  assert.ok(game._canSeePlayer(enemy));
});

test('light stops pursuing a player killed during the chase', () => {
  const { game, enemy } = setUpPursuit(10, 6, 8, 6);
  game.player.hp = 8;
  game.update(FRAME);
  assert.ok(enemy.pressure);

  game.update(0.2);
  assert.equal(game.player.alive, false);
  assert.equal(enemy.pressure, null);
  assert.ok(enemy.reacquireDelay > 0);
});

test('heavy spawns with a diameter of 1 and immediately fires 20 HP shots at 10 units/s every 2 s', () => {
  const spawn = { ...CONFIG.SPAWNS.A, x: 7.1, y: 13.5 };
  const game = new Game({
    ...OPEN_ARENA, SPAWNS: { A: spawn },
    WAVES: [[{ start: 0, lane: 'A', types: ['heavy'] }]]
  });
  setPlayer(game, 7.1, 16);
  assert.equal(game.startWave(), true);
  const [enemy] = game.enemies;
  assert.equal(enemy.hp, 120);
  assert.equal(enemy.r * 2, 1);
  assert.equal(game.player.r * 2, 1);
  game.update(FRAME);
  const [shot] = game.bullets;
  assert.equal(shot.ownerId, enemy.id);
  assert.equal(shot.speed, 10);
  assert.equal(shot.damage, 20);
  assert.ok(Math.abs(shot.remaining + shot.speed * FRAME - 6) < 1e-7);
  assert.equal(enemy.windup, 0);
  assert.equal(enemy.cooldown, 2);
  assert.equal(enemy.stationaryTarget, 'base', 'the base contour at exactly 6 beats a closer player');
  game.update(2 - FRAME);
  assert.equal(game.base.hp, 220);
  assert.equal(game.player.hp, 60);
  assert.equal(game.bullets.length, 0);
  assert.equal(enemy.x, spawn.x);
  assert.equal(enemy.y, spawn.y);
  game.update(FRAME);
  assert.equal(game.bullets.length, 1, 'second shot after 2 s');
});

test('heavy shoots at the player while following a free route, then ignores the player behind a wall', () => {
  const game = new Game({
    ...OPEN_ARENA, WALLS: [{ x: 3, y: 9, w: 4, h: 0.5 }]
  });
  game.phase = 'battle';
  setPlayer(game, 4, 5);
  const enemy = addEnemy(game, 'heavy', 4, 7);
  const start = { x: enemy.x, y: enemy.y };
  game.update(FRAME);
  const [shot] = game.bullets;
  assert.equal(shot.ownerId, enemy.id);
  assert.ok(shot.dy < 0);
  assert.equal(enemy.targetWreckId, null);
  assert.ok(Math.abs(Math.hypot(enemy.x - start.x, enemy.y - start.y) - 1.1 * FRAME) < 1e-7);
  assert.equal(enemy.pressure, null);

  setPlayer(game, 4, 11);
  enemy.cooldown = 0;
  const before = { x: enemy.x, y: enemy.y };
  game.drainEvents();
  game.update(0.2);
  assert.equal(enemy.cooldown, 0, 'no cooldown spent on the hidden player');
  assert.equal(game.drainEvents().filter(e => e.type === 'shot').length, 0);
  assert.equal(enemy.pressure, null);
  assert.equal(enemy.stationaryTarget, null);
  assert.ok(enemy.x > before.x);
});
