'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

const STEP = 1 / 60;
const TOLERANCE = 0.001;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function assertNear(actual, expected, description) {
  assert.ok(Math.abs(actual - expected) < TOLERANCE,
    `${description}: expected ${expected}, got ${actual}`);
}

function assertSeparated(a, b) {
  assert.ok(distance(a, b) >= a.r + b.r - 1e-6,
    `${a.id} and ${b.id} overlap`);
}

function medium(id, x, y) {
  return { id, type: 'medium', x, y, r: 0.5, hp: 60, cooldown: 1.2 };
}

// A cross-wall with two openings makes the short path, detour and contact
// with a blocker observable without depending on exact navigation waypoints.
const upperWall = { x: 7, y: 0, w: 0.5, h: 7.5 };
const twoOpenings = {
  ...CONFIG,
  WALLS: [upperWall, { x: 7, y: 9.5, w: 0.5, h: 3 }, { x: 7, y: 14.5, w: 0.5, h: 3.5 }]
};
const oneOpening = {
  ...CONFIG,
  WALLS: [upperWall, { x: 7, y: 9.5, w: 0.5, h: 8.5 }]
};

test('diagonal movement covers the same distance as cardinal movement', () => {
  const game = new Game();
  const start = { x: 2, y: 7 };

  Object.assign(game.player, start);
  game.update(0.5, { x: 1 });
  assertNear(distance(game.player, start), 2, 'cardinal movement');

  Object.assign(game.player, start);
  game.update(0.5, { x: 1, y: 1 });
  assertNear(game.player.x - start.x, Math.SQRT2, 'diagonal x movement');
  assertNear(game.player.y - start.y, Math.SQRT2, 'diagonal y movement');
});

test('player stops at the contour of walls, the base, wrecks and live tanks', () => {
  const game = new Game();
  const wreckPosition = { x: 6, y: 13 };
  game._killEnemy(medium('fallen', wreckPosition.x, wreckPosition.y));
  const wreck = game.wrecks[0];
  const guard = medium('guard', 10, 13.5);

  const contacts = [
    { name: 'wall', x: 4, y: 4, stop: 4.7 },
    { name: 'base', x: 11, y: 13.5, stop: 12.6 },
    { name: 'wreck', x: 4.5, y: 13, stop: 5 },
    { name: 'live tank', x: 8.5, y: 13.5, stop: 9 }
  ];

  for (const { name, x, y, stop } of contacts) {
    if (name === 'live tank') {
      game.phase = 'battle';
      game.enemies.push(guard); // Holds a clear line to the base.
    }
    Object.assign(game.player, { x, y });
    game.update(0.8, { x: 1 });
    assertNear(game.player.x, stop, name);
    assert.equal(game.player.y, y);
    assert.deepEqual({ x: wreck.x, y: wreck.y }, wreckPosition);
  }
  assert.equal(guard.x, 10);
  assert.equal(guard.y, 13.5);
  assertSeparated(game.player, guard);
});

test('player leaves the respawn niche through its bent exit using movement input', () => {
  const game = new Game();

  // Go around the divider, then around the bottom of the left wall.
  game.update(0.375, { y: -1 });
  game.update(0.65, { x: -1 });
  game.update(0.425, { y: 1 });
  game.update(0.725, { x: -1 });
  game.update(0.8, { y: -1 });

  assertNear(game.player.x, 10.9, 'x outside the niche');
  assertNear(game.player.y, 14.2, 'y outside the niche');
});

test('niche walls intercept direct shots at R, which has no respawn invulnerability', () => {
  // Keep a wave active during respawn without adding unrelated fire to the scene.
  const game = new Game({
    ...CONFIG,
    WAVES: [[{ start: 10, lane: 'A', types: ['light'] }]]
  });
  const { player } = game;
  const shots = [
    { x: 16.6, y: 13.3, direction: 'north' },
    { x: 20, y: 17.2, direction: 'east' },
    { x: 10.8, y: 17.2, direction: 'west via the exit' },
    { x: 11.5, y: 16.1, direction: 'west along the upper edge of the exit' },
    { x: 11.5, y: 15.5, direction: 'west above the exit' }
  ];

  function hitFrom(position) {
    assert.equal(game._shoot({ id: 'shooter', ...position }, player, 'enemy', 10, 12, 6), true);
    game._updateBullets(0.6);
    const hits = game.drainEvents().filter(event => event.type === 'hit');
    assert.equal(hits.length, 1);
    return hits[0].target;
  }

  for (const shot of shots) {
    assert.equal(hitFrom(shot), 'wall', shot.direction);
    assert.equal(player.hp, 60, shot.direction);
  }

  const inside = { x: 16.4, y: 15.6 };
  assert.equal(game.startWave(), true);
  player.hp = 12;
  assert.equal(hitFrom(inside), 'player');
  assert.equal(player.alive, false);
  game.update(4);
  assert.equal(player.alive, true);
  assert.equal(player.hp, 60);
  assert.equal(hitFrom(inside), 'player');
  assert.equal(player.hp, 48);
});

test('enemies from A, B and C can traverse the current map to the base', () => {
  const game = new Game({
    ...CONFIG,
    // Disable enemy fire to observe the full route, including the final approach.
    ENEMY_TYPES: { ...CONFIG.ENEMY_TYPES, medium: { ...CONFIG.ENEMY_TYPES.medium, range: 0 } },
    WAVES: [['A', 'B', 'C'].map(lane => ({ start: 0, lane, types: ['medium'] }))]
  });

  assert.equal(game.startWave(), true);
  assert.deepEqual(Array.from(game.enemies, enemy => enemy.lane), ['A', 'B', 'C']);
  for (let frame = 0; frame < 18 * 60; frame++) {
    game.update(STEP);
    const [a, b, c] = game.enemies;
    assertSeparated(a, b);
    assertSeparated(b, c);
    assertSeparated(c, a);
  }
  for (const enemy of game.enemies) {
    const dx = Math.max(0, Math.abs(enemy.x - game.base.x) - game.base.w / 2);
    const dy = Math.max(0, Math.abs(enemy.y - game.base.y) - game.base.h / 2);
    const clearance = Math.hypot(dx, dy);
    assert.ok(clearance >= enemy.r - 1e-6 && clearance < enemy.r + 0.15,
      `entrance ${enemy.lane} should reach the base perimeter, got clearance ${clearance}`);
  }
});

test('a new wreck triggers a free detour even at low HP, and removal reopens the shortcut', () => {
  const game = new Game(twoOpenings);
  game.phase = 'battle';
  const enemy = { ...medium('scout', 4, 8.5), cooldown: 0 };
  game.enemies.push(enemy);
  game.update(STEP); // Begin taking the upper opening.
  const before = { x: enemy.x, y: enemy.y };

  game._killEnemy(medium('fallen', 7.25, 8.5));
  const wreck = game.wrecks[0];
  wreck.hp = 1;
  game.update(0.5);
  assert.ok(enemy.y > before.y + 0.5, 'enemy should turn toward the lower opening');
  assert.equal(enemy.targetWreckId, null);
  assert.equal(wreck.hp, 1);

  Object.assign(game.player, { x: 8.5, y: 8.5 });
  game.update(0.04, { fire: true, aimX: wreck.x, aimY: wreck.y });
  assert.equal(game.wrecks.length, 0);
  const atRemoval = { x: enemy.x, y: enemy.y };

  game.update(0.5);
  assert.ok(enemy.x > atRemoval.x + 0.75, 'enemy should advance toward the shortcut');
  assert.ok(enemy.y < atRemoval.y, 'enemy should turn back toward the upper opening');
});

test('a live queue waits for the same breach and moves through once the opening is clear', () => {
  const game = new Game(oneOpening);
  game.phase = 'battle';
  const front = medium('front', 4, 8.5);
  const rear = medium('rear', 2.9, 8.5);
  game.enemies.push(front, rear);
  game._killEnemy(medium('fallen', 7.25, 8.5));
  const wreck = game.wrecks[0];

  for (let frame = 0; frame < 36; frame++) {
    game.update(STEP);
    assertSeparated(front, rear);
    assert.equal(front.targetWreckId, wreck.id);
    assert.equal(rear.targetWreckId, wreck.id);
    assert.equal(front.x, 4);
    assert.equal(front.y, 8.5);
  }
  assert.ok(rear.x < 3.1, 'rear tank should wait at the front tank');

  Object.assign(game.player, { x: 8.6, y: 8.5 });
  wreck.hp = 20;
  game.update(0.04, { fire: true, aimX: wreck.x, aimY: wreck.y });
  assert.equal(game.wrecks.length, 0);
  Object.assign(game.player, { x: 16.4, y: 17.2 });

  for (let frame = 0; frame < 240; frame++) {
    game.update(STEP);
    assertSeparated(front, rear);
    assert.equal(front.targetWreckId, null);
    assert.equal(rear.targetWreckId, null);
  }
  assert.ok(front.x > 8 && rear.x > 8, 'both tanks should clear the opening');
});

test('tanks caught in a contact jam yield and pass through the open gap', () => {
  const game = new Game({
    ...CONFIG,
    WALLS: [upperWall, { x: 7, y: 8.7, w: 0.5, h: 9.3 }]
  });
  game.phase = 'battle';
  const rear = medium('rear', 4, 6.5);
  const upper = medium('upper', 5.25, 7.1);
  const lower = medium('lower', 6.3, 9.8);
  game.enemies.push(rear, upper, lower);

  function advance(frames) {
    for (let frame = 0; frame < frames; frame++) {
      game.update(STEP);
      assertSeparated(rear, upper);
      assertSeparated(upper, lower);
      assertSeparated(lower, rear);
    }
  }

  // Two tanks converge on the mouth of the gap from opposite sides.
  advance(90);
  assert.ok(distance(upper, lower) < 1.01, 'both approaching tanks should be in contact');
  const jammedRearX = rear.x;

  advance(90);
  assert.ok(rear.x < jammedRearX - 0.5, 'the rear tank should back away from the gap');
  assert.ok(upper.x > 8, 'the upper tank should clear the gap while the rear yields');

  advance(9 * 60);
  assert.ok(game.enemies.every(enemy => enemy.x > 8), 'all three tanks should clear the gap');
});

test('an enemy can damage the player blocking the route without pushing them', () => {
  const game = new Game(oneOpening);
  game.phase = 'battle';
  const block = { x: 7.25, y: 8.5 };
  Object.assign(game.player, block);
  const enemy = { ...medium('advancing', 4, 8.5), cooldown: 0 };
  game.enemies.push(enemy);

  for (let frame = 0; frame < 120; frame++) {
    game.update(STEP);
    assertSeparated(enemy, game.player);
  }
  assert.equal(game.player.x, block.x);
  assert.equal(game.player.y, block.y);
  assert.ok(game.player.hp < 60, 'the player should take damage from the advancing enemy');
  assert.equal(enemy.targetWreckId, null);
});
