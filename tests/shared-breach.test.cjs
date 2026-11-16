'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Game, CONFIG } = require('./load-core.cjs');

const fork = {
  ...CONFIG,
  WALLS: [
    { x: 7, y: 8, w: 6.4, h: 4 },
    { x: 14.6, y: 8, w: 6.4, h: 4 }
  ]
};
const hull = (id, x, y, hp) => ({ id, x, y, r: 0.5, hp, maxHp: 120, expiresAfterWave: 2 });
const tank = (id, x, y, type = 'light', cooldown = 0) => ({
  id, x, y, type, cooldown, lane: 'A', r: 0.5, hp: CONFIG.ENEMY_TYPES[type].hp
});

test('the same fork selects a quick breach and detours around an intact hull', () => {
  const game = new Game(fork);
  game.player.alive = false;
  const enemy = tank('scout', 14, 6.7);
  game.wrecks = [hull('gate', 14, 10.6, 1)];
  const quick = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.equal(quick.blockedWreckId, 'gate');
  assert.ok(quick.breachSeconds < quick.detourSeconds);
  assert.ok(quick.estimatedSeconds < 1.5);
  game.wrecks[0].hp = 120;
  const intact = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.equal(intact.blockedWreckId, null);
  assert.ok(intact.detourSeconds < intact.breachSeconds);
});

test('a follower in a one-tank corridor adds no simultaneous damage or fictitious spawns', () => {
  const game = new Game({ ...fork, WALLS: [
    { x: 0, y: 0, w: 13.36, h: 12 },
    { x: 14.64, y: 0, w: 13.36, h: 12 }
  ] });
  game.player.alive = false;
  const lead = tank('lead', 14, 6.7, 'medium', 0.8);
  game.wrecks = [hull('gate', 14, 10.6, 36)];
  game.enemies = [lead];
  const alone = game.debugRoute(lead.x, lead.y, lead);
  const rear = tank('rear', 14, 5.5, 'heavy');
  game.enemies.push(rear);
  game._spawnQueue = [{ lane: 'A', type: 'heavy', at: 0 }];
  const queue = game.debugRoute(lead.x, lead.y, lead);
  assert.equal(queue.blockedWreckId, 'gate');
  assert.equal(queue.breachSeconds, alone.breachSeconds);
  assert.deepEqual(Array.from(queue.shooters), ['lead']);
  assert.ok(queue.breachSeconds >= 0.8 + 2 * CONFIG.ENEMY_TYPES.medium.cooldown);
});

test('a second reachable firing lane changes the group choice and losing its shooter changes it back', () => {
  const game = new Game({ ...fork, WALLS: [
    { x: 7, y: 8, w: 6.48, h: 4 },
    { x: 14.52, y: 8, w: 6.48, h: 4 }
  ] });
  game.phase = 'battle';
  game.player.alive = false;
  const lead = tank('lead', 13.45, 6.7);
  const helper = tank('support', 14.55, 6.7, 'heavy');
  game.enemies = [lead];
  game.wrecks = [hull('gate', 14, 10.6, 64)];
  game._assignRoute(lead);
  assert.equal(lead.targetWreckId, null);

  game.enemies.push(helper);
  game._assignRoute(lead);
  game._assignRoute(helper);
  assert.equal(lead.targetWreckId, 'gate');
  assert.equal(helper.targetWreckId, 'gate');
  assert.doesNotThrow(() => JSON.stringify(helper), 'a reserved waypoint must be independent of the tank');
  const shared = JSON.parse(game.exportAttemptLog()).events.filter(event => event.type === 'ai_route').at(-1);
  assert.deepEqual(shared.shooters, ['lead', 'support']);
  assert.equal(shared.decision, 'breach');

  helper.hp = 0;
  game._assignRoute(lead);
  assert.equal(lead.targetWreckId, null);
});

test('a supporting tank moves around the corner and contributes real breach fire', () => {
  const game = new Game({ ...fork, WALLS: [
    { x: 7, y: 8, w: 6.48, h: 4 },
    { x: 14.52, y: 8, w: 6.48, h: 4 }
  ] });
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 120 });
  const lead = tank('lead', 13.7, 6.7);
  const support = tank('support', 15.2, 6.4, 'heavy');
  lead.bodyAngle = support.bodyAngle = Math.PI / 2;
  game.enemies = [lead, support];
  const gate = hull('gate', 14, 10.6, 64);
  game.wrecks = [gate];
  assert.equal(game._clearShot(support, gate, 'wreck'), false);
  const estimate = game.debugRoute(lead.x, lead.y, lead);
  assert.deepEqual(Array.from(estimate.shooters), ['lead', 'support']);
  assert.equal(estimate.decision, 'breach');

  const supportHits = [];
  const applyHit = game._applyHit;
  game._applyHit = function (hit, bullet) {
    if (hit.object === gate && bullet.ownerId === support.id) supportHits.push(this._waveTime);
    applyHit.call(this, hit, bullet);
  };
  game.update(8);
  assert.ok(supportHits.length > 0);
  assert.equal(game.wrecks.includes(gate), false);
  assert.ok(game.base.hp < game.base.maxHp);
});

test('a hull after a blind turn adds another sequential clearance and whole reloads', () => {
  const game = new Game({ ...fork, WALLS: [
    { x: 0, y: 0, w: 9.36, h: 12.6 },
    { x: 10.64, y: 0, w: 17.36, h: 9.8 },
    { x: 9.36, y: 11.2, w: 4, h: 1.4 },
    { x: 14.64, y: 9.8, w: 13.36, h: 2.8 }
  ] });
  game.player.alive = false;
  const enemy = tank('turn', 10, 4.5, 'medium');
  game.enemies = [enemy];
  const first = hull('first', 10, 7.5, 1);
  const second = hull('second', 12.3, 10.5, 1);
  game.wrecks = [first];
  const single = game.debugRoute(enemy.x, enemy.y, enemy);

  game.wrecks.push(second);
  const weak = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.equal(game._clearShot(enemy, second, 'wreck'), false);
  assert.equal(weak.blockedWreckId, 'first');
  assert.deepEqual(Array.from(weak.breachIds), ['first', 'second']);
  assert.ok(weak.breachSeconds > single.breachSeconds);

  second.hp = 24;
  const twoHits = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.ok(Math.abs(twoHits.breachSeconds - weak.breachSeconds - CONFIG.ENEMY_TYPES.medium.cooldown) < 1e-6);

  game.phase = 'battle';
  game.player.respawn = 120;
  for (let tick = 0; tick < 720 && game.base.hp === game.base.maxHp; tick++) game.update(1 / 60);
  const removed = JSON.parse(game.exportAttemptLog()).events.filter(event => event.type === 'wreck_removed');
  assert.deepEqual(removed.map(event => [event.wreck.id, event.reason]),
    [['first', 'destroyed_by_enemy'], ['second', 'destroyed_by_enemy']]);
  assert.ok(removed[1].battleSeconds - removed[0].battleSeconds > 1.2, 'the second hull needs a new approach');
  assert.ok(game.base.hp < game.base.maxHp, 'the tank advances and lands a shot after both hulls are cleared');
});

test('a blocked base ray looks for a reachable position with actual line of fire', () => {
  const game = new Game({ ...CONFIG, WALLS: [] });
  game.player.alive = false;
  const shooter = tank('shooter', 8.1, 13.5, 'medium');
  const blocking = { ...tank('crossing', 10, 13.5, 'medium'), lane: 'B' };
  game.enemies = [shooter, blocking];
  assert.equal(game._visibleBasePoint(shooter, 5), null);

  const route = game.debugRoute(shooter.x, shooter.y, shooter);
  assert.ok(route.estimatedSeconds > 0);
  assert.ok(route.points.length > 0);
  const pos = { ...shooter, ...route.points.at(-1) };
  assert.ok(game._visibleBasePoint(pos, 5));
  assert.ok(game._positionFree(pos.x, pos.y, shooter, false));
});

test('the last approach reaches actual weapon range before exhausting the route', () => {
  const game = new Game({ ...CONFIG, WALLS: [] });
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 120 });
  const shooter = tank('shooter', 14, 4, 'medium');
  game.enemies = [shooter];
  game.update(5);
  assert.ok(game.base.hp < game.base.maxHp);
});

test('a clear base ray does not make an occupied firing position reachable', () => {
  const game = new Game({ ...CONFIG, WALLS: [] });
  game.player.alive = false;
  const shooter = tank('shooter', 14, 4, 'medium');
  const blocker = { ...tank('crossing', 13.875, 6.75, 'medium'), lane: 'B' };
  game.enemies = [shooter, blocker];
  const route = game.debugRoute(shooter.x, shooter.y, shooter);
  assert.ok(route.points.length > 0);
  const end = route.points.at(-1);
  assert.ok(game._positionFree(end.x, end.y, shooter, false));
  assert.ok(game._visibleBasePoint({ ...shooter, ...end }, 5));
});

test('group time to base uses the ready shooter rather than the closest reloading one', () => {
  const game = new Game({ ...CONFIG, WALLS: [] });
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 100 });
  game.wrecks = [hull('irrelevant', 22, 3, 60)];
  const closer = tank('front', 10, 13.5, 'heavy', 2);
  const ready = tank('rear', 8.9, 12);
  game.enemies = [closer, ready];
  assert.equal(game.debugRoute(closer.x, closer.y, closer).estimatedSeconds, 0);
  assert.equal(game.debugRoute(ready.x, ready.y, ready).estimatedSeconds, 0);
  game.update(1 / 60);
  assert.deepEqual(Array.from(game.bullets, shell => shell.ownerId), ['rear']);
});

test('a previously fired shell counts only when its remaining ray still reaches the hull', () => {
  const game = new Game(fork);
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 100 });
  const enemy = tank('barrier-gun', 14, 6.7, 'heavy');
  game.wrecks = [hull('gate', 14, 10.6, 20)];
  game.enemies = [enemy];
  const plan = () => game.debugRoute(enemy.x, enemy.y, enemy);
  assert.ok(Math.abs(plan().breachSeconds - 2) < 1e-7);
  game.update(1 / 60);
  assert.equal(game.bullets.length, 1);
  assert.ok(Math.abs(plan().breachSeconds - 2) < 1e-7);

  game.enemies.push({ ...tank('crossing', 14, 8.2, 'medium'), lane: 'B' });
  assert.deepEqual(Array.from(game._pendingWreckHits(game.wrecks[0])), []);
  assert.ok(plan().breachSeconds === null || plan().breachSeconds > 2);
});

test('a close timing change holds the committed route until the advantage is material', () => {
  const game = new Game(fork);
  game.player.alive = false;
  const enemy = tank('scout', 14, 6.7);
  game.enemies = [enemy];
  game.wrecks = [hull('gate', 14, 10.6, 32)];

  // Seed the plan from the previous observation of this decision scene.
  enemy.routeDecision = { key: 'gate', decision: 'breach' };
  const close = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.ok(close.detourSeconds < close.breachSeconds);
  assert.equal(close.decision, 'breach');

  game.wrecks[0].hp = 40;
  const material = game.debugRoute(enemy.x, enemy.y, enemy);
  assert.equal(material.decision, 'detour');
});

test('a base shot through a narrow slit counts immediately when the real firing ray is clear', () => {
  const game = new Game({ ...CONFIG, WALLS: [
    { x: 11, y: 0, w: 0.1, h: 13.22 },
    { x: 11, y: 13.30, w: 0.1, h: 4.70 }
  ] });
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 100 });
  const shooter = tank('shooter', 9, 13.5, 'heavy');
  game.enemies = [shooter];
  assert.ok(game._visibleBasePoint(shooter, 6));
  assert.equal(game.debugRoute(shooter.x, shooter.y, shooter).estimatedSeconds, 0);
  game.update(1 / 60);
  assert.deepEqual(Array.from(game.bullets, shell => shell.ownerId), ['shooter']);
});
