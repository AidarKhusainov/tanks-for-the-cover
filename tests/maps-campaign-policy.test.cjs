'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Game, CONFIG } = require('./load-core.cjs');
const policy = require('../tools/maps-campaign-policy.cjs');

const wall = { x: 11.8, y: 0, w: 5.2, h: 9.9 };
const config = {
  ...CONFIG,
  WALLS: [wall],
  SPAWNS: {},
  BASE_RECT: { x: 1, y: 14, w: 1, h: 1 }
};

function observe(game) {
  return {
    player: { ...game.player },
    enemies: game.enemies,
    wrecks: game.wrecks,
    bullets: game.bullets,
    queue: [],
    battleSeconds: 0
  };
}

test('campaign input escapes a wall and hull tangent to reach a shot on the original target', () => {
  const game = new Game(config);
  Object.assign(game.player, { x: 17.566, y: 10.086, module: 'barrel' });
  const start = { ...game.player };
  const wreck = { id: 'hull', x: 18.364, y: 10.689, r: .5 };
  const enemy = { id: 'target', type: 'medium', x: 3, y: 7.9, r: .5, hp: 40 };
  game.wrecks.push(wreck);
  game.enemies.push(enemy);
  policy.setup(config);

  let input;
  for (let decision = 0; decision < 120; decision++) {
    input = policy.decide(observe(game));
    if (input.fire && Math.hypot(input.aimX - enemy.x, input.aimY - enemy.y) < .5) break;
    // Isolate the player movement used by Game.update with the obstacles held fixed.
    // The campaign driver holds each policy decision for three ticks.
    for (let tick = 0; tick < 3; tick++) {
      game._updatePlayer(1 / 60, input);
      const { x, y, r } = game.player;
      const dx = Math.max(wall.x - x, 0, x - wall.x - wall.w);
      const dy = Math.max(wall.y - y, 0, y - wall.y - wall.h);
      assert.ok(Math.hypot(dx, dy) >= r - 1e-6, 'player overlaps the wall');
      for (const actor of [wreck, enemy]) {
        assert.ok(Math.hypot(x - actor.x, y - actor.y) >= r + actor.r - 1e-6,
          `player overlaps ${actor.id}`);
      }
    }
    if (decision === 19) {
      assert.ok(Math.hypot(game.player.x - start.x, game.player.y - start.y) > .75,
        'player should leave the tangent within one second of ordinary input');
    }
  }
  assert.ok(input.fire && Math.hypot(input.aimX - enemy.x, input.aimY - enemy.y) < .5,
    'player should resume its approach until it can fire at the original enemy');
  const hpBefore = enemy.hp;
  game.phase = 'battle';
  game._updatePlayer(1 / 60, input);
  game._updateBullets(.5);
  assert.ok(enemy.hp < hpBefore, 'the resulting shot hits the original enemy in Game');
});

test('campaign input holds position while aiming at an unobstructed target', () => {
  const game = new Game(config);
  Object.assign(game.player, { x: 5, y: 4 });
  const enemy = { id: 'target', type: 'medium', x: 8, y: 4, r: .5, hp: 40 };
  game.enemies.push(enemy);
  policy.setup(config);

  assert.deepEqual(policy.decide(observe(game)), { x: 0, y: 0, fire: true, aimX: 8, aimY: 4 });
});
