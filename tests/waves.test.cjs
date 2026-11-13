'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

const FRAME = 1 / 60;
const NEST = { x: 16.4, y: 17.2 };
const ENTRANCES = [
  { lane: 'A', edge: { x: 3, y: 2.5 }, outside: { x: 0, y: 1 } },
  { lane: 'B', edge: { x: 25, y: 2.5 }, outside: { x: 0, y: 1 } },
  { lane: 'C', edge: { x: 25.5, y: 8.5 }, outside: { x: -1, y: 0 } }
];

const EMPTY_WAVES = { ...CONFIG, WAVES: [[], [], [], []] };
const ENTRANCE_WAVES = {
  ...CONFIG,
  WAVES: ENTRANCES.map(({ lane }) => [{ start: 0, lane, types: ['light', 'medium'] }])
};

function position(actor) {
  return { x: actor.x, y: actor.y };
}

function offset(point, direction, distance) {
  return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
}

function mediumAt(point, id = 'test-medium') {
  return { ...point, id, type: 'medium', r: 0.5, hp: 60, maxHp: 60, dead: false };
}

function holdPosition(game, enemy) {
  Object.assign(enemy, { route: [], routeIndex: 0, routeVersion: game._navVersion, cooldown: 10 });
}

function shootEnemy(game, from, to, damage = 12) {
  assert.equal(game._shoot({ ...from, id: 'test-shooter' }, to, 'enemy', 10, damage, 5), true);
}

for (const [waveIndex, { lane, edge, outside }] of ENTRANCES.entries()) {
  test(`entrance ${lane} excludes wreck centers inside and on the boundary`, () => {
    const game = new Game();
    for (const distance of [-0.05, 0]) {
      game._killEnemy(mediumAt(offset(edge, outside, distance)));
      assert.equal(game.wrecks.length, 0);
    }

    const justOutside = offset(edge, outside, 0.05);
    game._killEnemy(mediumAt(justOutside));
    assert.equal(game.wrecks.length, 1);
    assert.deepEqual(position(game.wrecks[0]), justOutside);
  });

  test(`entrance ${lane} blocks the player's full contour in prep and battle but passes shots`, () => {
    const game = new Game(EMPTY_WAVES);
    const start = offset(edge, outside, 1);
    const input = { x: -outside.x, y: -outside.y };
    Object.assign(game.player, start);
    game.update(0.25, input);
    const tangent = offset(edge, outside, 0.5);
    assert.ok(Math.hypot(game.player.x - tangent.x, game.player.y - tangent.y) < 0.001);

    Object.assign(game.player, start);
    assert.equal(game.startWave(), true);
    const target = mediumAt(offset(edge, outside, -0.75));
    game.enemies.push(target);
    holdPosition(game, target);
    game.update(0.25, { ...input, aimX: target.x, aimY: target.y, fire: true });
    assert.ok(Math.hypot(game.player.x - tangent.x, game.player.y - tangent.y) < 0.001);
    assert.equal(target.hp, 40);
  });

  test(`occupied entrance ${lane} delays spawns and preserves the 2.5 s interval`, () => {
    const game = new Game(ENTRANCE_WAVES);
    game.waveIndex = waveIndex;
    const spawn = CONFIG.SPAWNS[lane];
    const blocker = mediumAt(position(spawn));
    holdPosition(game, blocker);
    game.enemies.push(blocker);
    assert.equal(game.startWave(), true);
    game.update(5.5);
    assert.equal(game.remaining, 3);
    assert.deepEqual(Array.from(game.enemies, enemy => enemy.id), [blocker.id]);
    assert.deepEqual(position(blocker), position(spawn));

    game.enemies.pop();
    game.update(FRAME);
    assert.equal(game.enemies.length, 1);
    assert.equal(game.enemies[0].type, 'light');
    game.update(2.5 - FRAME);
    assert.equal(game.enemies.length, 1);
    assert.equal(game.remaining, 2);
    game.update(FRAME);
    assert.deepEqual(Array.from(game.enemies, enemy => enemy.type), ['light', 'medium']);
    const [first, second] = game.enemies;
    assert.ok(Math.hypot(first.x - second.x, first.y - second.y) >= first.r + second.r);
  });
}

test('lethal projectile is consumed and the next projectile damages the new wreck', () => {
  const game = new Game(EMPTY_WAVES);
  assert.equal(game.startWave(), true);
  const player = { x: 3, y: 6.5 };
  const target = mediumAt({ x: 5.13, y: 6.5 });
  Object.assign(game.player, player);
  target.hp = 20;
  holdPosition(game, target);
  game.enemies.push(target);
  const fire = { aimX: target.x, aimY: target.y, fire: true };

  // Keep the phase in battle with another enemy far from this line of fire.
  game.enemies.push(mediumAt({ x: 24, y: 2 }, 'other-medium'));
  game.update(0.1, fire);
  assert.equal(game.wrecks.length, 1);
  const wreck = game.wrecks[0];
  assert.deepEqual(position(wreck), position(target));
  assert.equal(wreck.r, target.r);
  assert.equal(wreck.hp, 60);
  assert.equal(game.bullets.length, 0);

  game.update(0.3, fire);
  assert.equal(game.wrecks.length, 1);
  assert.equal(wreck.hp, 40);
});

test('settling preserves airborne shots and ages only older wrecks after the last hit', () => {
  const game = new Game(EMPTY_WAVES);
  game._killEnemy(mediumAt({ x: 5, y: 7.2 }));
  const oldWreck = game.wrecks[0];
  game.startWave();
  game.update(FRAME);
  assert.equal(game.waveNumber, 2);
  assert.ok(game.wrecks.includes(oldWreck));
  game.startWave();
  Object.assign(game.player, { x: 3, y: 6 });
  const lastEnemy = mediumAt({ x: 6.4, y: 6.5 });
  lastEnemy.hp = 20;
  holdPosition(game, lastEnemy);
  game.enemies.push(lastEnemy);
  shootEnemy(game, { x: 9, y: 13.5 }, game.base);

  game.update(0.1, { aimX: lastEnemy.x, aimY: lastEnemy.y, fire: true });
  assert.equal(game.remaining, 0);
  assert.equal(game.phase, 'settling');
  assert.equal(game.base.hp, 240);
  assert.equal(game.wrecks.length, 2);
  const newWreck = game.wrecks[1];
  newWreck.hp = 40; // Observe preservation of a damaged hull across the phase boundary.
  assert.equal(game.bullets.length, 1);
  game.update(0.25, { fire: true });
  assert.equal(game.phase, 'settling');
  assert.equal(game.stats.shots, 1);
  game.update(0.1, { fire: true });
  assert.equal(game.base.hp, 228);
  assert.equal(game.phase, 'prep');
  assert.equal(game.waveNumber, 3);
  assert.equal(game.wrecks.length, 1);
  assert.equal(game.wrecks[0], newWreck);
  assert.equal(newWreck.hp, 40);

  const wreckState = { ...newWreck };
  game.update(12, { fire: true });
  assert.deepEqual({ ...newWreck }, wreckState);
  assert.equal(game.wrecks[0], newWreck);
  assert.equal(game.bullets.length, 0);
  assert.equal(game.stats.shots, 1); // Only the shot that killed the last enemy.
  game.startWave();
  game.update(FRAME);
  assert.equal(game.waveNumber, 4);
  assert.equal(game.wrecks.length, 0);
});

for (const [baseHp, finalPhase] of [[12, 'lost'], [13, 'won']]) {
  test(`final wave waits for the last shot before declaring ${finalPhase}`, () => {
    const game = new Game(EMPTY_WAVES);
    game.waveIndex = 3;
    game.base.hp = baseHp;
    game.startWave();
    shootEnemy(game, { x: 10.6, y: 13.5 }, game.base);
    game.update(0.1);
    assert.equal(game.phase, 'settling');
    assert.equal(game.base.hp, baseHp);
    assert.equal(game.bullets.length, 1);
    game.update(0.2, { fire: true });
    assert.equal(game.phase, finalPhase);
    assert.equal(game.base.hp, baseHp - 12);
    assert.equal(game.stats.shots, 0);
  });
}

test('pause stops battle and the 4 s respawn timer, and reset starts a fresh attempt', () => {
  const config = { ...CONFIG, WAVES: [[{ start: 10, lane: 'A', types: ['light'] }]] };
  const game = new Game(config);
  game._killEnemy(mediumAt({ x: 6.4, y: 6.5 }));
  game.startWave();
  Object.assign(game.player, { x: 3, y: 6, hp: 12 });
  shootEnemy(game, { x: 4, y: 6 }, game.player);
  game.update(0.05);
  assert.equal(game.player.alive, false);
  assert.equal(game.player.respawn, 4);
  assert.equal(game.stats.deaths, 1);
  assert.equal(game.wrecks.length, 1);

  const time = game.stats.time;
  game.paused = true;
  game.update(20, { x: 1, fire: true });
  assert.equal(game.stats.time, time);
  assert.equal(game.player.respawn, 4);
  assert.equal(game.enemies.length, 0);
  assert.equal(game.repairFromWreck(game.wrecks[0].id).ok, false);

  game.paused = false;
  game.update(4 - FRAME);
  assert.equal(game.player.alive, false);
  game.update(FRAME);
  assert.equal(game.player.alive, true);
  assert.equal(game.player.hp, 60);
  assert.deepEqual(position(game.player), NEST);

  game.base.hp = 20;
  shootEnemy(game, { x: 10.6, y: 13.5 }, game.base);
  assert.equal(game.bullets.length, 1);
  game.paused = true;
  game.reset();
  const fresh = new Game(config);
  assert.equal(game.phase, 'prep');
  assert.equal(game.waveNumber, 1);
  assert.equal(game.paused, false);
  assert.equal(game.canUndo, false);
  assert.equal(game.remaining, 0);
  assert.deepEqual(game.stats, fresh.stats);
  assert.deepEqual(game.player, fresh.player);
  assert.deepEqual(game.base, fresh.base);
  assert.deepEqual(game.wrecks, fresh.wrecks);
  assert.deepEqual(game.bullets, fresh.bullets);
  assert.deepEqual(game.drainEvents(), fresh.drainEvents());
  assert.equal(game.startWave(), true);
  game.update(10 - FRAME);
  assert.equal(game.enemies.length, 0);
  game.update(FRAME);
  assert.equal(game.enemies.length, 1);
  assert.equal(game.enemies[0].lane, 'A');
});

test('next preparation revives the player immediately and restores an injured survivor', () => {
  for (const hp of [0, 12]) {
    const game = new Game(EMPTY_WAVES);
    Object.assign(game.player, { x: 3, y: 6, hp, alive: hp > 0, respawn: hp ? 0 : 4 });
    game.startWave();
    game.update(FRAME);
    assert.equal(game.phase, 'prep');
    assert.equal(game.player.hp, 60);
    assert.equal(game.player.alive, true);
    assert.equal(game.player.respawn, 0);
    assert.deepEqual(position(game.player), hp ? { x: 3, y: 6 } : NEST);
  }
});

test('repair caps at max HP, full base permits dismantling, and undo restores each position', () => {
  const game = new Game();
  game.base.hp = 228;
  Object.assign(game.player, { x: 3, y: 6 });
  game._killEnemy(mediumAt({ x: 4.1, y: 6 }));
  game._killEnemy(mediumAt({ x: 3, y: 7.3 }));
  const [first, second] = game.wrecks;

  const firstPosition = position(game.player);
  assert.deepEqual({ ...game.repairFromWreck(first.id) }, { ok: true, hp: 12 });
  assert.equal(game.base.hp, 240);
  assert.ok(!game.wrecks.includes(first));
  game.update(0.4, { x: 1 });
  const secondPosition = position(game.player);
  assert.ok(secondPosition.x > first.x);
  assert.deepEqual({ ...game.repairFromWreck(second.id) }, { ok: true, hp: 0 });
  assert.equal(game.wrecks.length, 0);
  game.update(0.2, { y: 1 });

  assert.equal(game.undo(), true);
  assert.deepEqual(position(game.player), secondPosition);
  assert.equal(game.base.hp, 240);
  assert.deepEqual({ ...game.wrecks[0] }, { ...second });
  assert.equal(game.undo(), true);
  assert.deepEqual(position(game.player), firstPosition);
  assert.equal(game.base.hp, 228);
  assert.deepEqual(Array.from(game.wrecks, wreck => wreck.id), [first.id, second.id]);
  assert.equal(game.undo(), false);
});

test('start commits repairs and the next preparation cannot undo combat losses', () => {
  const game = new Game(EMPTY_WAVES);
  for (const x of [3, 4.2, 5.4]) game._killEnemy(mediumAt({ x, y: 6 }));
  const [dismantled, destroyed, survivor] = game.wrecks;
  assert.equal(game.repairFromWreck(dismantled.id).ok, true);
  assert.equal(game.canUndo, true);
  assert.equal(game.startWave(), true);
  assert.equal(game._undo.length, 0); // Battle also disables undo, independently of clearing history.
  assert.equal(game.undo(), false);
  shootEnemy(game, { x: 3, y: 6 }, destroyed, 60);
  game.update(0.2);
  assert.equal(game.phase, 'prep');
  assert.deepEqual(Array.from(game.wrecks, wreck => wreck.id), [survivor.id]);
  assert.equal(game.undo(), false);
  assert.equal(game.repairFromWreck(survivor.id).ok, true);
  assert.equal(game.undo(), true);
  assert.deepEqual(Array.from(game.wrecks, wreck => wreck.id), [survivor.id]);
  assert.equal(game.undo(), false);
});
