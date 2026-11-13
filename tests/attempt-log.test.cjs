'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG, PLAYER_MODULES, PLAYER_WEAPON } = require('./load-core.cjs');

const FRAME = 1 / 60;
const config = { ...CONFIG, WAVES: [[], []] };
const read = game => JSON.parse(game.exportAttemptLog());
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

function createWreck(game, type, x) {
  game._killEnemy({ type, x, y: 6 });
  return game.wrecks.at(-1);
}

function hit(game, kind, object, team, damage = object.hp) {
  game._applyHit({ kind, object }, { team, damage });
}

test('attempt log preserves actual wave, wreck and player transitions across pauses and effect drains', () => {
  const game = new Game(config);
  game.update(1.25);
  game.paused = true;
  game.update(10);
  game.paused = false;
  assert.equal(game.startWave(), true);

  const expired = createWreck(game, 'medium', 5);
  const playerDestroyed = createWreck(game, 'medium', 7);
  const enemyDestroyed = createWreck(game, 'heavy', 9);
  hit(game, 'wreck', playerDestroyed, 'player');
  hit(game, 'wreck', enemyDestroyed, 'enemy');

  game.enemies.push({ type: 'light', hp: 20, x: 11, y: 5, cooldown: 99 });
  hit(game, 'player', game.player, 'enemy');
  game.paused = true;
  game.update(10);
  game.paused = false;
  game.update(4);
  assert.equal(game.player.alive, true);
  hit(game, 'player', game.player, 'enemy');
  game.enemies.length = 0;
  game.update(FRAME);
  assert.equal(game.player.alive, true);
  assert.equal(game.waveNumber, 2);

  game.update(0.75);
  assert.equal(game.startWave(), true);
  game.update(FRAME);
  assert.equal(game.phase, 'won');

  const log = read(game);
  assert.equal(log.formatVersion, 1);
  assert.ok(log.buildId);
  assert.deepEqual(log.configuration.game.WAVES, [[], []]);
  assert.deepEqual(log.configuration.game.WALLS, JSON.parse(JSON.stringify(CONFIG.WALLS)));
  assert.deepEqual(log.configuration.playerWeapon, { ...PLAYER_WEAPON });
  assert.deepEqual(log.events.map(event => event.type), [
    'attempt_start', 'wave_start', 'wreck_created', 'wreck_created', 'wreck_created',
    'wreck_removed', 'wreck_removed', 'player_death', 'player_return', 'player_death',
    'wave_end', 'player_return', 'wave_start', 'wreck_removed', 'wave_end', 'attempt_end'
  ]);
  for (const [index, event] of log.events.entries()) {
    assert.equal(event.sequence, index + 1);
    if (index) {
      assert.ok(event.preparationSeconds >= log.events[index - 1].preparationSeconds);
      assert.ok(event.battleSeconds >= log.events[index - 1].battleSeconds);
    }
  }
  const events = type => log.events.filter(event => event.type === type);
  const [created] = events('wreck_created');
  assert.equal(created.wave, 1);
  assert.deepEqual(created.wreck, JSON.parse(JSON.stringify(expired)));
  assert.deepEqual(events('wreck_removed').map(event => [event.wreck.id, event.reason, event.wave]), [
    [playerDestroyed.id, 'destroyed_by_player', 1], [enemyDestroyed.id, 'destroyed_by_enemy', 1],
    [expired.id, 'expired', 2]
  ]);
  const [timedReturn, betweenWaves] = events('player_return');
  closeTo(timedReturn.battleSeconds - events('player_death')[0].battleSeconds, 4);
  assert.equal(timedReturn.reason, 'respawn_timer');
  assert.equal(betweenWaves.wave, 2);
  assert.equal(betweenWaves.reason, 'wave_transition');
  const [firstStart, secondStart] = events('wave_start');
  const [firstEnd] = events('wave_end');
  closeTo(firstStart.preparationSeconds, 1.25);
  closeTo(firstStart.battleSeconds, 0);
  closeTo(secondStart.preparationSeconds - firstEnd.preparationSeconds, 0.75);
  assert.equal(firstEnd.wave, 1);
  assert.equal(firstEnd.baseHp, game.base.hp);
  assert.deepEqual([firstEnd.player.alive, firstEnd.player.hp, firstEnd.player.module], [false, 0, null]);
  assert.deepEqual([betweenWaves.player.alive, betweenWaves.player.hp], [true, 60]);
  assert.equal(events('attempt_end')[0].outcome, 'won');
  assert.equal(log.current.stats.deaths, 2);
  assert.equal(log.current.phase, 'won');
  assert.equal(log.current.wrecks.length, 0);
  assert.ok(game.drainEvents().some(event => event.type === 'win'));
  assert.deepEqual(game.drainEvents().length, 0);
  game.update(10);
  assert.deepEqual(read(game), log);
});

test('preparation records actual results and links each undo to its original action', () => {
  const game = new Game(config);
  assert.equal(game.startWave(), true);
  const repair = createWreck(game, 'medium', 5);
  const engine = createWreck(game, 'medium', 7);
  const armor = createWreck(game, 'heavy', 9);
  const donor = createWreck(game, 'medium', 11);
  const target = createWreck(game, 'heavy', 13);
  hit(game, 'base', game.base, 'enemy', 17);
  hit(game, 'wreck', target, 'player', 90);
  game.update(FRAME);
  assert.equal(game.repairFromWreck(repair.id).hp, 17);
  assert.equal(game.installModuleFromWreck(engine.id).module, 'engine');
  assert.equal(game.installModuleFromWreck(armor.id).module, 'armor');
  assert.equal(game.reinforceWreck(donor.id, target.id).ok, true);
  assert.equal(game.reinforceWreck('missing', target.id).ok, false);
  const beforeUndo = read(game);
  for (let i = 0; i < 4; i++) assert.equal(game.undo(), true);
  assert.equal(game.undo(), false);

  const log = read(game);
  assert.deepEqual(log.events.slice(0, beforeUndo.events.length), beforeUndo.events);
  const actions = log.events.filter(event => ['repair', 'module_change', 'reinforce'].includes(event.type));
  const [repairEvent, engineEvent, armorEvent, reinforcement] = actions;
  assert.deepEqual([repairEvent.wreckId, repairEvent.hpRestored, repairEvent.baseHp], [repair.id, 17, 240]);
  assert.deepEqual([engineEvent.wreckId, engineEvent.previousModule, engineEvent.player.module], [engine.id, null, 'engine']);
  assert.deepEqual([armorEvent.wreckId, armorEvent.previousModule, armorEvent.player.maxHp], [armor.id, 'engine', PLAYER_MODULES.armor.maxHp]);
  assert.deepEqual([reinforcement.donorId, reinforcement.target.id, reinforcement.target.hp,
    reinforcement.target.expiresAfterWave, reinforcement.target.reinforced], [donor.id, target.id, 90, 4, true]);
  assert.deepEqual(log.events.filter(event => event.type === 'wreck_removed')
    .map(event => [event.wreck.id, event.reason, event.actionSequence]),
  [repair.id, engine.id, armor.id, donor.id].map((id, i) => [id, 'salvaged', actions[i].sequence]));
  const undos = log.events.filter(event => event.type === 'undo');
  assert.deepEqual(undos.map(event => event.actionSequence), actions.map(event => event.sequence).reverse());
  assert.deepEqual(undos[0].wrecks.map(wreck => [wreck.id, wreck.hp, wreck.expiresAfterWave]),
    [[donor.id, 60, 2], [target.id, 30, 3]]);
  assert.equal(undos[1].player.module, 'engine');
  assert.equal(undos[2].player.module, null);
  assert.equal(undos[3].baseHp, 223);
  assert.equal(log.current.baseHp, game.base.hp);
  assert.equal(log.current.stats.repairs, 0);
  assert.equal(log.current.stats.baseRepaired, 0);
  assert.deepEqual(log.current.wrecks.map(wreck => wreck.id), [repair.id, engine.id, armor.id, donor.id, target.id]);
});

test('loss exports the actual final state and reset starts an independent attempt', () => {
  const game = new Game(config);
  game.update(0.5);
  assert.equal(game.startWave(), true);
  hit(game, 'player', game.player, 'enemy');
  hit(game, 'base', game.base, 'enemy');
  game.update(FRAME);
  game.update(1);

  const log = read(game);
  assert.deepEqual(log.events.map(event => event.type), ['attempt_start', 'wave_start', 'player_death', 'wave_end', 'attempt_end']);
  const [endWave, endAttempt] = log.events.slice(-2);
  assert.equal(endWave.outcome, 'lost');
  assert.deepEqual([endAttempt.outcome, endAttempt.wave, endAttempt.baseHp, endAttempt.player.alive], ['lost', 1, 0, false]);
  assert.deepEqual(endAttempt.player, log.current.player);
  assert.equal(endAttempt.battleSeconds, log.current.battleSeconds);
  assert.equal(log.current.phase, 'lost');

  game.reset();
  const next = read(game);
  assert.equal(next.attemptNumber, log.attemptNumber + 1);
  assert.deepEqual(next.events.map(event => [event.type, event.wave, event.preparationSeconds, event.battleSeconds]),
    [['attempt_start', 1, 0, 0]]);
  assert.equal(next.current.baseHp, 240);
  assert.equal(next.current.stats.deaths, 0);
});
