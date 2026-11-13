'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG, PLAYER_WEAPON } = require('./load-core.cjs');

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
  assert.equal(game._shoot({ id: 'test-shooter', ...from }, to, 'enemy', 10, damage, 5), true);
}

for (const [waveIndex, { lane, edge, outside }] of ENTRANCES.entries()) {
  test(`entrance ${lane} excludes both wreck types inside and on the boundary`, () => {
    const game = new Game();
    for (const type of ['medium', 'heavy']) {
      for (const distance of [-0.05, 0]) {
        game._killEnemy({ ...mediumAt(offset(edge, outside, distance)), type });
        assert.equal(game.wrecks.length, 0, `${type} at offset ${distance}`);
      }
      const justOutside = offset(edge, outside, 0.0001);
      game._killEnemy({ ...mediumAt(justOutside), type });
      assert.equal(game.wrecks.length, 1, `${type} just outside`);
      assert.deepEqual(position(game.wrecks.pop()), justOutside);
    }
    game._killEnemy({ ...mediumAt(offset(edge, outside, 2)), type: 'light' });
    assert.equal(game.wrecks.length, 0, 'light leaves no resource outside the zone either');
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

for (const [type, hp] of [['medium', 60], ['heavy', 120]]) {
  test(`${type}: lethal shot is consumed, then both sides can hit and destroy the wreck`, () => {
    const game = new Game(EMPTY_WAVES);
    assert.equal(game.startWave(), true);
    Object.assign(game.player, { x: 3, y: 6.5 });
    const target = { ...mediumAt({ x: 5.13, y: 6.5 }), type, hp: 20, maxHp: hp };
    const rear = mediumAt({ x: 7.13, y: 6.5 }, 'rear');
    game.enemies.push(target, rear);
    // Advance only the weapon and projectiles so route changes don't move
    // the actors out of this deliberately aligned fixture.
    const fire = () => {
      game._updatePlayer(0.3, { aimX: rear.x, aimY: rear.y, fire: true });
      game._updateBullets(0.2);
    };
    const rearPosition = position(rear);
    const playerPosition = position(game.player);

    fire();
    assert.equal(game.wrecks.length, 1);
    const [wreck] = game.wrecks;
    assert.equal(wreck.type, type);
    assert.deepEqual(position(wreck), position(target));
    assert.deepEqual(position(rear), rearPosition);
    assert.deepEqual(position(game.player), playerPosition);
    assert.equal(wreck.r, target.r);
    assert.equal(wreck.r * 2, 1);
    assert.equal(wreck.hp, hp);
    assert.equal(wreck.maxHp, hp);
    assert.equal(game.bullets.length, 0);

    fire();
    assert.equal(wreck.hp, hp - 20);
    assert.equal(rear.hp, 60);
    shootEnemy(game, rear, game.player, 20);
    game._updateBullets(0.3);
    assert.equal(wreck.hp, hp - 40);
    assert.equal(game.player.hp, 60);

    const navVersion = game._navVersion;
    for (let remaining = hp - 40; remaining > 0; remaining -= 20) fire();
    assert.equal(game.wrecks.length, 0);
    assert.ok(game._navVersion > navVersion, 'destroying the wreck invalidates routes');
    assert.equal(rear.hp, 60, 'the shot destroying the wreck is also consumed');
    fire();
    assert.equal(rear.hp, 40);
  });
}

test('heavy wreck survives the creation wave and two following waves without HP decay', () => {
  const game = new Game(EMPTY_WAVES);
  game.startWave();
  game._killEnemy({ ...mediumAt({ x: 5.13, y: 6.5 }), type: 'heavy' });
  assert.equal(game.wrecks.length, 1);
  const [wreck] = game.wrecks;
  wreck.hp = 61;
  for (const next of [2, 3]) {
    game.update(FRAME);
    assert.equal(game.waveNumber, next);
    assert.equal(game.wrecks[0], wreck);
    assert.equal(wreck.expiresAfterWave, 3);
    assert.equal(wreck.hp, 61);
    assert.equal(game.startWave(), true);
  }
  game.update(FRAME);
  assert.equal(game.waveNumber, 4);
  assert.equal(game.wrecks.length, 0);
});

for (const [type, capacity] of [['medium', 30], ['heavy', 50]]) {
  test(`${type}: repair preview and action agree at low, nearly full and full base; undo restores the hull`, () => {
    const game = new Game();
    game._killEnemy({ ...mediumAt({ x: 5.13, y: 6.5 }), type });
    assert.equal(game.wrecks.length, 1);
    Object.assign(game.player, { x: 3, y: 6.5 });
    for (const missing of [70, 7, 0]) {
      const [wreck] = game.wrecks;
      wreck.hp = 23;
      const snapshot = { ...wreck };
      game.base.hp = 240 - missing;
      const player = position(game.player);
      const restored = Math.min(missing, capacity);
      const before = JSON.stringify(game);
      const actions = game.getWreckActions(wreck.id);
      assert.equal(actions.repairBaseHp, 240 - missing + restored);
      assert.equal(JSON.stringify(game), before, 'reading repair options leaves the game unchanged');
      assert.equal(game.getWreckRepairHp(wreck.id), restored);
      assert.deepEqual({ ...game.repairFromWreck(wreck.id) }, { ok: true, hp: restored });
      assert.equal(game.base.hp, actions.repairBaseHp);
      assert.equal(game.wrecks.length, 0);
      game.update(0.2, { x: 1 });
      assert.notDeepEqual(position(game.player), player);
      assert.equal(game.undo(), true);
      assert.deepEqual({ ...game.wrecks[0] }, snapshot);
      assert.equal(game.base.hp, 240 - missing);
      assert.deepEqual(position(game.player), player);
    }
  });
}

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

function createWreck(game, type, x, y = 6) {
  game._killEnemy({ ...mediumAt({ x, y }, `test-${type}-${x}-${y}`), type });
  return game.wrecks.at(-1);
}

function assertLoadout(game, module, hp, speed) {
  assert.equal(game.player.module, module);
  assert.equal(game.player.maxHp, hp);
  assert.equal(game.player.hp, hp);
  const x = game.player.x;
  game.update(0.1, { x: 1 });
  assert.ok(Math.abs(game.player.x - x - speed * 0.1) < 1e-7);
}

test('module preview reports both replacements and the resulting tank stats without installing anything', () => {
  const game = new Game();
  Object.assign(game.player, { x: 3, y: 6.5 });
  for (const [type, module, replacedModule, speed, maxHp] of [
    ['medium', 'engine', null, 5, 60],
    ['heavy', 'armor', 'engine', 4, 90],
    ['medium', 'engine', 'armor', 5, 60]
  ]) {
    const wreck = createWreck(game, type, 22, 13);
    const before = JSON.stringify(game);
    const preview = game.getWreckActions(wreck.id);
    assert.equal(preview.replacedModule, replacedModule);
    assert.equal(preview.module, module);
    assert.deepEqual({ ...preview.moduleStats }, { speed, maxHp });
    assert.equal(JSON.stringify(game), before);
    assert.equal(game.installModuleFromWreck(wreck.id).ok, true);
    assertLoadout(game, module, preview.moduleStats.maxHp, preview.moduleStats.speed);
  }
});

test('one module slot swaps engine → armor → engine, then resets on a new attempt', () => {
  const game = new Game(EMPTY_WAVES);
  Object.assign(game.player, { x: 3, y: 6.5 });
  assertLoadout(game, null, 60, 4);
  const engine = createWreck(game, 'medium', 22, 13);
  const armor = createWreck(game, 'heavy', 24, 13);
  const nextEngine = createWreck(game, 'medium', 26, 13);
  for (const [wreck, module, hp, speed] of [
    [engine, 'engine', 60, 5],
    [armor, 'armor', 90, 4],
    [nextEngine, 'engine', 60, 5]
  ]) {
    assert.equal(game.getWreckActions(wreck.id).module, module);
    assert.equal(game.installModuleFromWreck(wreck.id).ok, true);
    assert.equal(game.wrecks.some(w => w.id === wreck.id), false);
    assertLoadout(game, module, hp, speed);
  }
  assert.equal(game.wrecks.length, 0, 'discarded modules do not become resources');

  assert.equal(game.startWave(), true);
  game.update(FRAME, { fire: true, aimX: 2, aimY: 6.5 });
  const [shot] = game.bullets;
  assert.equal(shot.damage, PLAYER_WEAPON.damage);
  assert.equal(shot.speed, PLAYER_WEAPON.speed);
  assert.ok(Math.abs(shot.remaining + FRAME * shot.speed - PLAYER_WEAPON.range) < 1e-7);
  assert.equal(game.player.cooldown, PLAYER_WEAPON.cooldown);
  game.reset();
  assert.equal(game.canUndo, false);
  assert.equal(game.waveNumber, 1);
  Object.assign(game.player, { x: 3, y: 6.5 });
  assertLoadout(game, null, 60, 4);
});

test('unavailable preparation operations explain their reason and leave state and history intact', () => {
  const game = new Game(EMPTY_WAVES);
  const first = createWreck(game, 'medium', 7);
  const same = createWreck(game, 'medium', 9);
  const armor = createWreck(game, 'heavy', 12);
  const expired = createWreck(game, 'heavy', 20);
  expired.expiresAfterWave = 0;
  const destroyed = createWreck(game, 'heavy', 22);
  destroyed.hp = 0;
  assert.equal(game.installModuleFromWreck(first.id).ok, true);
  function reject(id, reason) {
    const before = JSON.stringify([game.player, game.wrecks, game.base, game.stats]);
    assert.equal(game.getWreckActions(id).moduleReason, reason);
    assert.deepEqual({ ...game.installModuleFromWreck(id) }, { ok: false, reason });
    assert.equal(JSON.stringify([game.player, game.wrecks, game.base, game.stats]), before);
  }
  reject(same.id, 'same-module');
  assert.equal(game.getWreckRepairHp(same.id), 0, 'same-type hull can still clear a passage');
  reject('unknown', 'missing-wreck');
  reject(expired.id, 'unusable-wreck');
  reject(destroyed.id, 'unusable-wreck');
  assert.equal(game.getWreckRepairHp(expired.id), null);
  game.paused = true;
  reject(armor.id, 'paused');
  assert.equal(game.getWreckRepairHp(armor.id), null);
  assert.equal(game.canUndo, false);
  assert.equal(game.undo(), false);
  game.paused = false;
  assert.equal(game.undo(), true);
  assert.equal(game.player.module, null);
  assert.equal(game.canUndo, false, 'only the first installation created history');
  assert.equal(game.installModuleFromWreck(same.id).ok, true);
  assert.equal(game.startWave(), true);
  reject(armor.id, 'not-prep');
  assert.equal(game.getWreckRepairHp(armor.id), null);
  assert.equal(game.undo(), false);
  game.update(FRAME);
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.module, 'engine');
  assert.equal(game.undo(), false, 'starting combat committed the installation');
});

test('mixed preparation undo restores hull order, repair counters, modules and earlier positions', () => {
  const game = new Game(EMPTY_WAVES);
  Object.assign(game.player, { x: 3, y: 6.5 });
  game.base.hp = 191;
  const repair = createWreck(game, 'medium', 4.2, 6.5);
  const engine = createWreck(game, 'medium', 22, 13);
  const armor = createWreck(game, 'heavy', 24, 13);
  const left = createWreck(game, 'heavy', 26, 13);
  armor.hp = 43;
  const snapshot = () => ({
    wrecks: Array.from(game.wrecks, w => ({ ...w })),
    base: game.base.hp,
    module: game.player.module,
    hp: game.player.hp,
    maxHp: game.player.maxHp,
    repairs: game.stats.repairs,
    baseRepaired: game.stats.baseRepaired,
    position: position(game.player)
  });
  const beforeRepair = snapshot();
  assert.deepEqual({ ...game.repairFromWreck(repair.id) }, { ok: true, hp: 30 });
  game.update(0.65, { x: 1 });
  assert.ok(game.player.x > repair.x + 1, 'tank moved fully past the hull');
  const beforeEngine = snapshot();
  const beforeInstallNav = game.navigationVersion;
  assert.equal(game.installModuleFromWreck(engine.id).ok, true);
  assert.ok(game.navigationVersion > beforeInstallNav);
  game.update(0.2, { y: 1 });
  const beforeArmor = snapshot();
  assert.equal(game.installModuleFromWreck(armor.id).ok, true);
  game.update(0.2, { x: -1 });
  assert.notDeepEqual(position(game.player), beforeArmor.position);
  assert.deepEqual(Array.from(game.wrecks, w => w.id), [left.id]);

  let nav = game.navigationVersion;
  for (const before of [beforeArmor, beforeEngine, beforeRepair]) {
    assert.equal(game.undo(), true);
    assert.deepEqual(snapshot(), before);
    assert.ok(game.navigationVersion > nav);
    nav = game.navigationVersion;
  }
  assert.equal(game.undo(), false);
});

test('armor stays equipped through timed respawn, early wave end, preparation and the next battle', () => {
  const config = { ...CONFIG, WAVES: [[{ start: 12, lane: 'A', types: ['light'] }], [], [], []] };
  const game = new Game(config);
  const armor = createWreck(game, 'heavy', 24, 13);
  assert.equal(game.installModuleFromWreck(armor.id).ok, true);
  game.player.hp = 29;
  assert.equal(game.startWave(), true);
  assert.equal(game.player.hp, 90);

  function killPlayer() {
    Object.assign(game.player, { x: 3, y: 6 });
    shootEnemy(game, { x: 4, y: 6 }, game.player, 90);
    game.update(0.05);
    assert.equal(game.player.alive, false);
    assert.equal(game.player.module, 'armor');
    assert.equal(game.player.respawn, 4);
  }
  killPlayer();
  game.update(4 - FRAME);
  assert.equal(game.player.alive, false);
  game.update(FRAME);
  assert.equal(game.player.alive, true);
  assert.equal(game.player.hp, 90);
  assert.deepEqual(position(game.player), NEST);

  killPlayer();
  game._spawnQueue.length = 0; // No further enemies; the wave ends before the second timer.
  game.update(FRAME);
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.alive, true);
  assert.equal(game.player.module, 'armor');
  assert.equal(game.player.hp, 90);
  assert.deepEqual(position(game.player), NEST);
  assert.equal(game.startWave(), true);
  assert.equal(game.player.hp, 90);
  game.player.hp = 12;
  game.update(FRAME);
  assert.equal(game.phase, 'prep');
  assert.equal(game.player.hp, 90);
  assert.equal(game.player.module, 'armor');
});

test('reinforcement uses the target type, current HP and remaining service for every donor type', () => {
  for (const [targetType, donorType, hp, expectedHp, expectedMax] of [
    ['medium', 'medium', 10, 40, 60],
    ['medium', 'heavy', 60, 60, 60],
    ['heavy', 'medium', 30, 90, 120],
    ['heavy', 'heavy', 100, 120, 120]
  ]) {
    const game = new Game(EMPTY_WAVES);
    const target = createWreck(game, targetType, 22, 13);
    const donor = createWreck(game, donorType, 24, 13);
    Object.assign(donor, { hp: 1, expiresAfterWave: 4, reinforced: true });
    target.hp = hp;
    const expected = {
      ...target, hp: expectedHp, maxHp: expectedMax,
      expiresAfterWave: target.expiresAfterWave + 1, reinforced: true
    };
    const before = JSON.stringify(game.wrecks);
    const nav = game.navigationVersion;
    assert.deepEqual({ ...game.getWreckReinforcement(donor.id, target.id) },
      { reason: null, hp: expected.hp, expiresAfterWave: expected.expiresAfterWave });
    assert.equal(JSON.stringify(game.wrecks), before, 'query has no side effects');
    assert.equal(game.canUndo, false);
    assert.equal(game.reinforceWreck(donor.id, target.id).ok, true);
    assert.deepEqual(Array.from(game.wrecks, w => ({ ...w })), [expected]);
    assert.equal(game.navigationVersion, nav + 1);
  }
});

test('reinforcement refuses invalid pairs, repeat repair, pause and combat without side effects', () => {
  const game = new Game(EMPTY_WAVES);
  const donor = createWreck(game, 'medium', 7);
  const target = createWreck(game, 'heavy', 9);
  const other = createWreck(game, 'medium', 12);
  const expired = createWreck(game, 'heavy', 20);
  expired.expiresAfterWave = 0;
  const destroyed = createWreck(game, 'heavy', 22);
  destroyed.hp = 0;
  const unsupported = createWreck(game, 'heavy', 24);
  unsupported.type = 'light';

  function reject(from, to, reason) {
    const snapshot = () => JSON.stringify([
      game.wrecks, game.player, game.base, game.stats, game._undo, game._events, game.lastMessage, game.navigationVersion
    ]);
    const before = snapshot();
    assert.equal(game.getWreckReinforcement(from, to).reason, reason);
    assert.deepEqual({ ...game.reinforceWreck(from, to) }, { ok: false, reason });
    assert.equal(snapshot(), before);
  }
  reject(donor.id, donor.id, 'same-wreck');
  for (const [id, reason] of [
    ['missing', 'missing-wreck'], [expired.id, 'unusable-wreck'],
    [destroyed.id, 'unusable-wreck'], [unsupported.id, 'unusable-wreck']
  ]) {
    reject(id, target.id, reason);
    reject(donor.id, id, reason);
  }
  game.paused = true;
  reject(donor.id, target.id, 'paused');
  game.paused = false;
  assert.equal(game.reinforceWreck(donor.id, target.id).ok, true);
  target.hp = 30;
  reject(other.id, target.id, 'already-reinforced');
  assert.equal(game.undo(), true);
  assert.equal(game.canUndo, false);
  assert.equal(game.startWave(), true);
  reject(donor.id, target.id, 'not-prep');
});

test('reinforced hulls remain ordinary resources and one undo restores both hulls in a mixed chain', () => {
  const game = new Game(EMPTY_WAVES);
  Object.assign(game.player, { x: 3, y: 6.5 });
  game.base.hp = 135;
  const repair = createWreck(game, 'medium', 4.2, 6.5);
  const target = createWreck(game, 'heavy', 22, 13);
  const engine = createWreck(game, 'medium', 24, 13);
  const donor = createWreck(game, 'medium', 26, 13);
  target.hp = 30;
  const snapshots = [];
  const snapshot = () => ({
    hulls: Array.from(game.wrecks, w => ({ ...w })),
    base: game.base.hp, stats: { ...game.stats }, player: { ...game.player }
  });
  function step(action, input, dt) {
    const before = snapshot();
    snapshots.push(before);
    assert.equal(action().ok, true);
    game.update(dt, input);
    assert.notDeepEqual(position(game.player), position(before.player));
  }
  step(() => game.repairFromWreck(repair.id), { x: 1 }, 0.65);
  step(() => game.installModuleFromWreck(engine.id), { y: 1 }, 0.2);
  step(() => game.reinforceWreck(donor.id, target.id), { x: -1 }, 0.2);
  assert.equal(game.getWreckActions(target.id).repairHp, 50);
  assert.equal(game.getWreckActions(target.id).module, 'armor');
  step(() => game.installModuleFromWreck(target.id), { y: 1 }, 0.2);
  assert.equal(game.player.hp, 90);
  assert.equal(game.wrecks.length, 0);

  for (const before of snapshots.reverse()) {
    assert.equal(game.undo(), true);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(game.undo(), false);
  assert.equal(game.reinforceWreck(donor.id, target.id).ok, true);
  assert.deepEqual({ ...game.repairFromWreck(target.id) }, { ok: true, hp: 50 });
});

test('undo preview reads the next snapshot, including the previous tank position and both kinds of hull changes', () => {
  const game = new Game();
  Object.assign(game.player, { x: 3, y: 6.5 });
  game.base.hp = 231;
  const repair = createWreck(game, 'medium', 4.2, 6.5);
  const engine = createWreck(game, 'medium', 22, 13);
  const target = createWreck(game, 'heavy', 24, 13);
  const donor = createWreck(game, 'medium', 26, 13);
  target.hp = 30;
  const steps = [
    { action: () => game.repairFromWreck(repair.id), ids: [repair.id], move: { x: 1 }, dt: 0.65 },
    { action: () => game.installModuleFromWreck(engine.id), ids: [engine.id], move: { y: 1 }, dt: 0.2 },
    { action: () => game.reinforceWreck(donor.id, target.id), ids: [donor.id, target.id], move: { x: -1 }, dt: 0.2 }
  ];
  assert.equal(game.getUndoPreview().reason, 'no-undo');
  const positions = [];
  for (const { action, move, dt } of steps) {
    positions.push(position(game.player));
    assert.equal(action().ok, true);
    game.update(dt, move);
    assert.notDeepEqual(position(game.player), positions.at(-1));
  }

  game.paused = true;
  assert.equal(game.getUndoPreview().reason, 'paused');
  game.paused = false;
  for (const { ids } of steps.reverse()) {
    const before = JSON.stringify(game);
    const preview = game.getUndoPreview();
    const expectedPosition = positions.pop();
    assert.equal(preview.reason, null);
    assert.deepEqual(position(preview.player), expectedPosition);
    assert.deepEqual(Array.from(preview.wrecks, wreck => wreck.id), ids);
    assert.equal(JSON.stringify(game), before, 'hovering does not pop or reorder the stack');
    assert.equal(game.undo(), true);
    assert.deepEqual(position(game.player), expectedPosition);
    assert.equal(game.player.module, preview.player.module);
    assert.equal(game.player.hp, preview.player.hp);
    assert.equal(game.base.hp, preview.baseHp);
    for (const wreck of preview.wrecks) assert.deepEqual(game.wrecks.find(w => w.id === wreck.id), wreck);
  }
  assert.equal(game.getUndoPreview().reason, 'no-undo');
  assert.equal(game.startWave(), true);
  assert.equal(game.getUndoPreview().reason, 'not-prep');
});

test('starting a wave commits reinforcement; target expires one wave later, including the final wave rule', () => {
  const game = new Game(EMPTY_WAVES);
  const target = createWreck(game, 'medium', 22, 13);
  const ordinary = createWreck(game, 'medium', 24, 13);
  const donor = createWreck(game, 'medium', 26, 13);
  assert.equal(game.startWave(), true); // Creation wave does not count.
  game.update(FRAME);
  assert.equal(game.waveNumber, 2);
  assert.equal(game.reinforceWreck(donor.id, target.id).ok, true);
  assert.equal(game.startWave(), true);
  assert.equal(game.undo(), false);
  game.update(FRAME);
  assert.equal(game.waveNumber, 3);
  assert.equal(game.canUndo, false);
  assert.deepEqual(Array.from(game.wrecks, w => w.id), [target.id]);
  assert.ok(!game.wrecks.includes(ordinary));
  assert.equal(game.startWave(), true);
  game.update(FRAME);
  assert.equal(game.waveNumber, 4);
  assert.equal(game.wrecks.length, 0);

  const lastTarget = createWreck(game, 'heavy', 22, 13);
  const lastDonor = createWreck(game, 'medium', 24, 13);
  Object.assign(lastTarget, { hp: 30, expiresAfterWave: 4 });
  assert.equal(game.reinforceWreck(lastDonor.id, lastTarget.id).ok, true);
  assert.equal(lastTarget.hp, 90);
  assert.equal(lastTarget.expiresAfterWave, 5, 'lifetime is extended even beyond the last wave');
  assert.equal(game.startWave(), true);
  game.update(FRAME);
  assert.equal(game.phase, 'won');
  assert.equal(game.undo(), false);
});

// PDD §8, approved in #2. Each line records the start, lane and ordered types.
const APPROVED_WAVES = [
  '0 A ЛС; 5 B ЛЛ',
  '0 B СЛЛ; 4 C ЛС',
  '0 A СЛ; 2 B ЛС; 6 C ЛЛ',
  '0 A СЛТ; 1 B ЛСЛ; 4 C ЛС',
  '0 A ЛСЛ; 1 C ЛСЛ; 6 B ТЛ',
  '0 A ЛСЛ; 0 B ЛЛС; 5 C ЛСЛЛ',
  '0 B ЛТЛС; 0 C ЛЛС; 4 A СЛЛТ',
  '0 A ТЛСЛЛ; 2 B ЛСЛЛ; 5 C ТЛСЛЛ'
];
const TYPE_MARKS = { light: 'Л', medium: 'С', heavy: 'Т' };

test('battlefield packages and totals match the approved eight-wave table', () => {
  const actual = Array.from(CONFIG.WAVES, wave => Array.from(wave, ({ start, lane, types }) =>
    `${start} ${lane} ${types.map(type => TYPE_MARKS[type]).join('')}`
  ).join('; '));
  assert.deepEqual(actual, APPROVED_WAVES);

  const types = CONFIG.WAVES.flatMap(wave => wave.flatMap(group => group.types));
  assert.deepEqual(Object.fromEntries(Object.keys(TYPE_MARKS).map(type =>
    [type, types.filter(item => item === type).length]
  )), { light: 41, medium: 19, heavy: 6 });
});

test('the approved campaign advances through eight waves, settles and resets', () => {
  const game = new Game();
  // The fixture clears enemies immediately after observing each real spawn.
  // Queue, clock, wreck expiry and completion still run through Game.update.
  const spawnTimes = [];
  game._updateEnemy = enemy => {
    spawnTimes.push([game._waveTime, enemy.lane, TYPE_MARKS[enemy.type]]);
    game._killEnemy(enemy);
  };

  Object.assign(game.player, { x: 3, y: 6.5 });
  game.base.hp = 210;
  game._killEnemy(mediumAt({ x: 5, y: 6.5 }));
  assert.equal(game.repairFromWreck(game.wrecks[0].id).ok, true);
  const armor = createWreck(game, 'heavy', 7, 6.5);
  assert.equal(game.installModuleFromWreck(armor.id).ok, true);
  assert.equal(game.player.module, 'armor');
  assert.equal(game.player.hp, 90);
  assert.equal(game.player.maxHp, 90);
  game.update(0.25, { x: -1 });
  assert.equal(game.undo(), true);
  assert.deepEqual(position(game.player), { x: 3, y: 6.5 });
  assert.equal(game.player.module, null);
  assert.equal(game.player.hp, 60);
  assert.equal(game.player.maxHp, 60);
  assert.equal(game.base.hp, 240, 'undo only reverses the module installation');
  assert.equal(game.wrecks[0].id, armor.id);
  assert.equal(game.installModuleFromWreck(armor.id).ok, true);
  game.update(60);
  assert.equal(game.phase, 'prep', 'preparation has no timer');

  for (const [index, wave] of APPROVED_WAVES.entries()) {
    const waveNumber = index + 1;
    const expected = wave.split('; ').flatMap(group => {
      const [start, lane, marks] = group.split(' ');
      return [...marks].map((mark, position) => [Number(start) + position * 2.5, lane, mark]);
    }).sort(([leftTime, leftLane], [rightTime, rightLane]) =>
      leftTime - rightTime || leftLane.localeCompare(rightLane)
    );
    assert.equal(game.phase, 'prep', `preparation for wave ${waveNumber}`);
    assert.equal(game.waveNumber, waveNumber);
    assert.equal(game.startWave(), true);
    assert.equal(game.remaining, expected.length);
    assert.deepEqual(position(game.player), { x: 3, y: 6.5 });
    assert.equal(game.base.hp, 240);
    assert.equal(game.player.module, 'armor');
    assert.equal(game.player.hp, 90);
    assert.equal(game.player.maxHp, 90);
    assert.equal(game._undo.length, 0);
    assert.equal(game.undo(), false);
    game.player.hp = 30;

    for (const enemy of game.enemies) game._updateEnemy(enemy); // Start-time spawns.
    game.update(expected.at(-1)[0] - FRAME);
    assert.equal(game.phase, 'battle');
    assert.ok(game.remaining > 0);

    if (waveNumber === APPROVED_WAVES.length) {
      shootEnemy(game, { x: 10.6, y: 13.5 }, game.base);
    }
    game.update(FRAME * 2);
    assert.deepEqual(spawnTimes.splice(0).map(([time, lane, mark]) =>
      [Math.round(time * 60) / 60, lane, mark]
    ), expected, `spawns in wave ${waveNumber}`);

    if (waveNumber === APPROVED_WAVES.length) {
      assert.equal(game.phase, 'settling');
      assert.equal(game.remaining, 0);
      assert.equal(game.base.hp, 240);
      assert.equal(game.bullets.length, 1);
      game.update(0.3, { fire: true });
      assert.equal(game.phase, 'won');
      assert.equal(game.base.hp, 228);
      assert.equal(game.stats.shots, 0);
      assert.match(game.lastMessage, /8/);
    }
  }

  game.reset();
  const fresh = new Game();
  assert.equal(game.phase, 'prep');
  assert.equal(game.waveNumber, 1);
  assert.deepEqual(game.player, fresh.player);
  assert.equal(game.player.module, null);
  assert.deepEqual(game.base, fresh.base);
  assert.deepEqual(game.stats, fresh.stats);
  assert.equal(game.remaining, 0);
  assert.equal(game.wrecks.length, 0);
  assert.equal(game.bullets.length, 0);
  assert.equal(game.canUndo, false);
  game.startWave();
  assert.equal(game.remaining, 4);
  assert.deepEqual(Array.from(game.enemies, enemy => [enemy.lane, enemy.type]), [['A', 'light']]);
});
