'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG } = require('./load-core.cjs');

const FRAME = 1 / 60;
const OPEN = { ...CONFIG, WALLS: [] };
const CORRIDOR = { ...CONFIG, WALLS: [
  { x: 0, y: 0, w: 13.2, h: 11 },
  { x: 14.8, y: 0, w: 13.2, h: 11 }
] };

function scene(kind, config = OPEN) {
  const game = new Game(config);
  game.phase = 'battle';
  const isBase = kind === 'base';
  Object.assign(game.player, { x: 14, y: 7.1, alive: kind === 'player', respawn: 100 });
  if (kind === 'wreck') {
    game.wrecks = [{ id: 'barrier', x: 14, y: 7.1, r: 0.5, hp: 120, expiresAfterWave: 2 }];
  }
  const routeVersion = game.navigationVersion;
  const targetWreckId = game.wrecks[0]?.id ?? null;
  game.enemies = ['front', 'rear'].map((id, i) => ({
    id, type: 'medium', hp: 60, r: 0.5, x: 14, y: (isBase ? 9 : 4.6) - i * 1.25,
    route: [], routeIndex: 0, routeVersion, targetWreckId
  }));
  const shots = [];
  const shoot = game._shoot;
  game._shoot = function (shooter, point, ...args) {
    const hit = this._firstCollision(shooter.x, shooter.y, point.x, point.y, shooter.id);
    const fired = shoot.call(this, shooter, point, ...args);
    if (fired) shots.push({ shooter: shooter.id, hit: hit?.kind });
    return fired;
  };
  return { game, shots, front: game.enemies[0], rear: game.enemies[1] };
}

for (const kind of ['wreck', 'base', 'player']) {
  test(`a second enemy finds a separate ray to the ${kind} and both land shots`, () => {
    const { game, shots } = scene(kind);
    const target = kind === 'wreck' ? game.wrecks[0] : game[kind];
    const before = target.hp;
    game.update(1.2 - FRAME);
    assert.deepEqual(shots, [{ shooter: 'front', hit: kind }, { shooter: 'rear', hit: kind }]);
    assert.equal(target.hp, before - 24);
  });
}

test('a one-tank firing corridor keeps its ray open and the next enemy takes over', () => {
  const { game, shots, front, rear } = scene('wreck', CORRIDOR);
  game.update(1.4);
  assert.deepEqual(shots, [{ shooter: 'front', hit: 'wreck' }, { shooter: 'front', hit: 'wreck' }]);
  assert.ok(!rear.firingPosition);
  front.hp = 0;
  game.update(0.4);
  assert.equal(shots.at(-1).shooter, 'rear');
  assert.equal(shots.at(-1).hit, 'wreck');
});

test('a player moving out of the lane releases the reserved position', () => {
  const { game, shots, rear } = scene('player');
  game.update(FRAME);
  assert.equal(rear.firingPosition?.kind, 'player');
  Object.assign(game.player, { x: 10, y: 4.6 });
  game.update(FRAME);
  assert.equal(rear.firingPosition, null);
  assert.deepEqual(shots.map(shot => shot.shooter), ['front', 'rear']);
});

test('a dodge releases a reserved position before tactical movement resumes', () => {
  const { game, rear } = scene('wreck');
  game.update(FRAME);
  assert.equal(rear.firingPosition?.kind, 'wreck');
  game._updateEnemy(rear, FRAME, null, 0, { heading: 0, speed: 1.7, gear: 1 });
  assert.equal(rear.firingPosition, null);
  assert.equal(rear.dodge.speed, 1.7);
  game._updateEnemy(rear, FRAME, null);
  assert.equal(rear.dodge, null);
  assert.ok(rear.dodgeReturn || rear.smoothDrive);
});
