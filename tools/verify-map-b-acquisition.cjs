'use strict';

// Controlled replay of a recorded, ordinary preparation-7 snapshot. The sole
// state restoration is labelled separately from the subsequent ordinary inputs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadCore} = require('./calibrate-maps.cjs');
const policy = require('./maps-campaign-policy.cjs');

const STEP = 1 / 60;
const CACHE_KEYS = new Set(['config', '_grid', '_openField', '_breachSearch', '_shotFields', '_traffic', '_applyHit']);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b) => distance(a, b) < 0.00001;
const inside = (p, r) => p.x >= r.x - 1e-7 && p.x <= r.x + r.w + 1e-7 &&
  p.y >= r.y - 1e-7 && p.y <= r.y + r.h + 1e-7;

function observation(game) {
  return {
    phase: game.phase, wave: game.waveNumber, player: {...game.player}, baseHp: game.base.hp,
    enemies: game.enemies.map(e => ({...e})), wrecks: game.wrecks.map(w => ({...w})),
    bullets: game.bullets.map(b => ({...b})), queue: game._spawnQueue.map(q => ({...q})),
    battleSeconds: game.stats.time
  };
}

function savePreparation(game, sha256, tick) {
  const state = Object.fromEntries(Object.entries(game).filter(([key]) => !CACHE_KEYS.has(key)));
  return {label: 'Controlled ordinary-command replay reached preparation 8; B7 hulls unspent',
    sha256, mapId: game.config.mapId, mode: game.player.module, tick, state};
}

function clearTarget(game, target) {
  return target && game._firstCollision(game.player.x, game.player.y, target.x, target.y, game.player.id)?.object === target;
}

function aimAt(input, game, target) {
  if (clearTarget(game, target)) Object.assign(input, {aimX: target.x, aimY: target.y, fire: true});
  return input;
}

function ordinaryAcquisitionInput(game, control, bKills) {
  const p = game.player;
  const heavy = game.enemies.find(e => e.lane === 'B' && e.type === 'heavy');
  const medium = game.enemies.find(e => e.lane === 'B' && e.type === 'medium');
  const lights = game.enemies.filter(e => e.lane === 'B' && e.type === 'light');
  const mediumMade = bKills.some(k => k.type === 'medium');
  const pairMade = mediumMade && bKills.some(k => k.type === 'heavy');
  let target;
  if (game.config.mapId === 'city') {
    if (medium && medium.x < 21.3 && clearTarget(game, medium)) target = medium;
    else if (heavy && ((heavy.hp > 40 && heavy.x < 20.5) || heavy.x < 14.2)) target = heavy;
    else target = lights.filter(e => distance(p, e) < 5.8 && clearTarget(game, e)).sort((a, b) => a.x - b.x)[0];
    const bullet = game.bullets.find(b => b.team === 'enemy' && Math.abs(b.dx) > 0.2 &&
      (p.x - b.x) * b.dx > 0 && Math.abs(b.x - p.x) < 4);
    if (bullet) {
      const crossing = bullet.y + (p.x - bullet.x) * bullet.dy / bullet.dx;
      if (Math.abs(crossing - p.y) < 0.8) control.y = crossing < 12.2 ? 13 : 11.8;
    }
    if (pairMade) control.stage = 'finish';
    return aimAt({x: mediumMade && p.x < 17.8 ? 1 : 0,
      y: Math.abs(control.y - p.y) > 0.03 ? Math.sign(control.y - p.y) : 0}, game, target);
  }
  if (heavy && heavy.y >= 4.8) target = heavy;
  else if (medium && !heavy && medium.y >= 6) target = medium;
  else target = lights.filter(e => distance(p, e) < 5.8).sort((a, b) => b.y - a.y)[0];
  const bullet = game.bullets.find(b => b.team === 'enemy' && b.dy > 0.5 && b.y < p.y && p.y - b.y < 4);
  if (bullet) {
    const crossing = bullet.x + (p.y - bullet.y) * bullet.dx / bullet.dy;
    if (Math.abs(crossing - p.x) < 0.8) control.x = crossing < 21.6 ? 22.6 : 20.6;
  }
  if (pairMade) control.x = 23;
  if (pairMade && !lights.length && !game._spawnQueue.some(e => e.lane === 'B')) control.stage = 'finish';
  return aimAt({x: Math.abs(control.x - p.x) > 0.03 ? Math.sign(control.x - p.x) : 0}, game, target);
}

function protectAcquiredHulls(game, input, bKills) {
  if (!input.fire) return;
  const p = game.player, length = Math.hypot(input.aimX - p.x, input.aimY - p.y);
  if (!(length > 0)) { input.fire = false; return; }
  const r = game.playerWeaponRange;
  const hit = game._firstCollision(p.x, p.y, p.x + (input.aimX - p.x) / length * r,
    p.y + (input.aimY - p.y) / length * r, p.id);
  if (hit?.kind === 'wreck' && bKills.some(k => near(k, hit.object))) input.fire = false;
}

function replay(core, config, snapshot, sha256, output) {
  assert.equal(snapshot.sha256, sha256, 'Preparation snapshot must match these exact HTML bytes');
  assert.equal(snapshot.state.phase, 'prep');
  assert.equal(snapshot.state.waveIndex, 6, 'Expected preparation 7');
  assert.equal(snapshot.state.stats.kills, 41, 'Expected the complete first six waves');
  assert.equal(snapshot.state.enemies.length, 0);
  assert.equal(snapshot.state.bullets.length, 0);
  for (const key of CACHE_KEYS) assert(!Object.hasOwn(snapshot.state, key), `Fixture may not replace ${key}`);
  const game = new core.Game(config);
  Object.assign(game, structuredClone(snapshot.state)); // Sole, explicitly labelled restoration.
  game._invalidateNavigation();
  policy.setup(config);
  const commands = [], observations = [], bKills = [], costs = [];
  let tick = 0, previous = null, prepIndex = 0;
  const control = {stage: 'prepare', x: 21.6, y: 12.2};
  const initialModule = game.player.module;

  // Public salvage actions remove the old approach blockers. Repair may legally
  // dismantle a hull with zero HP gained; its actual return value is recorded.
  for (const wreck of [...game.wrecks]) {
    const remove = config.mapId === 'magnetic' ? wreck.x > 19 :
      (wreck.x > 18 && wreck.y > 12) || (wreck.x < 8 && wreck.y > 5.2);
    if (!remove) continue;
    const result = game.repairFromWreck(wreck.id);
    assert.equal(result.ok, true, 'Only successful public preparation actions are allowed');
    const action = {tick, kind: 'repairFromWreck', id: wreck.id, type: wreck.type, result};
    commands.push(action); costs.push(action);
  }
  assert.equal(game.player.module, initialModule);

  const originalHit = game._applyHit;
  game._applyHit = function (hit, bullet) {
    const enemy = hit.kind === 'enemy' ? hit.object : null, hp = enemy?.hp;
    const result = originalHit.call(this, hit, bullet);
    if (enemy?.lane === 'B' && hp > 0 && enemy.hp <= 0 && this.waveNumber === 7) {
      bKills.push({time: this._waveTime, id: enemy.id, type: enemy.type, x: enemy.x, y: enemy.y});
    }
    return result;
  };
  const prepRoute = config.mapId === 'magnetic' ? [{x:21.6,y:10.2}] :
    game.player.y > 16.2 && game.player.x > 7.5 ?
      [{x:24.8,y:17},{x:24.8,y:14.2},{x:18,y:14.2},{x:16.8,y:12.2}] : [{x:16.8,y:12.2}];

  for (; tick < 15000 && !['lost', 'won'].includes(game.phase) && game.waveNumber === 7; tick++) {
    const s = observation(game), p = game.player;
    let input;
    if (game.phase === 'prep') {
      const goal = prepRoute[prepIndex];
      if (distance(p, goal) < 0.12) {
        if (prepIndex < prepRoute.length - 1) { prepIndex++; continue; }
        const ok = game.startWave();
        commands.push({tick, kind:'startWave', wave:7, ok});
        assert(ok); control.stage = 'acquire'; continue;
      }
      input = distance(p, goal) < 0.4 ? {
        x: Math.abs(p.x - goal.x) > 0.04 ? Math.sign(goal.x - p.x) : 0,
        y: Math.abs(p.y - goal.y) > 0.04 ? Math.sign(goal.y - p.y) : 0
      } : policy.decide(s, previous, goal);
      if (tick > 1800) break;
    } else if (control.stage === 'acquire') input = ordinaryAcquisitionInput(game, control, bKills);
    else {
      input = policy.decide(s, previous);
      // Reach A after the city placement, then let the general policy follow
      // actual bypass threats instead of remaining indefinitely at P_A.
      if (config.mapId === 'city' && game._waveTime < 22 &&
          (game.enemies.some(e => e.lane === 'A') || game._spawnQueue.some(e => e.lane === 'A'))) {
        const move = policy.decide(s, previous, {x:6,y:9.5});
        Object.assign(input, {x:move.x, y:move.y});
      }
    }
    protectAcquiredHulls(game, input, bKills);
    commands.push({tick, kind:'input', dt:STEP, ...input});
    game.update(STEP, input);
    previous = s;
    if (tick % 60 === 0) observations.push({tick, stage:control.stage, ...observation(game)});
  }

  const reachedPreparation8 = game.phase === 'prep' && game.waveNumber === 8;
  const pair = ['medium', 'heavy'].map(type => {
    const kill = bKills.find(k => k.type === type);
    return kill && game.wrecks.find(w => w.type === type && near(kill, w));
  });
  const areas = config.TACTICS.B.usefulAreas;
  assert(Array.isArray(areas) && [1, 2].includes(areas.length), 'Expected mapped B useful regions');
  const useful = pair.every((wreck, index) => wreck && inside(wreck, areas.length === 1 ? areas[0] : areas[index]));
  if (reachedPreparation8) {
    fs.writeFileSync(path.join(output, 'prep-8.json'), JSON.stringify(savePreparation(game, sha256, tick), null, 2));
    const ok = game.startWave();
    commands.push({tick, kind:'startWave', wave:8, ok});
    assert(ok);
  }
  fs.writeFileSync(path.join(output, 'commands.ndjson'), commands.map(command => JSON.stringify(command)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observations, null, 2));
  fs.writeFileSync(path.join(output, 'attempt.json'), game.exportAttemptLog());
  return {
    passed: reachedPreparation8 && game.phase === 'battle' && game.waveNumber === 8 &&
      game.stats.kills === 52 && pair.every(wreck => wreck?.hp > 0) && useful,
    mode: 'controlled-replay-from-recorded-ordinary-preparation', mapId:config.mapId,
    playerModule:game.player.module, costs, bKills, pair, useful, reachedPreparation8,
    actualWave8Start:game.phase === 'battle' && game.waveNumber === 8,
    phase:game.phase, wave:game.waveNumber, baseHp:game.base.hp, stats:game.stats, ticks:tick
  };
}

function pointSegmentDistanceSq(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}

function rectDistanceSq(p, r) {
  return (p.x - Math.max(r.x, Math.min(r.x + r.w, p.x))) ** 2 +
    (p.y - Math.max(r.y, Math.min(r.y + r.h, p.y))) ** 2;
}

function segmentHitsRect(a, b, r) {
  let near = 0, far = 1;
  for (const [axis, size] of [['x','w'], ['y','h']]) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < r[axis] || a[axis] > r[axis] + r[size]) return false;
    } else {
      const first = (r[axis] - a[axis]) / delta, last = (r[axis] + r[size] - a[axis]) / delta;
      near = Math.max(near, Math.min(first, last)); far = Math.min(far, Math.max(first, last));
      if (near > far) return false;
    }
  }
  return true;
}

function sweptClear(a, b, config, hulls) {
  if (hulls.some(h => pointSegmentDistanceSq(h, a, b) < (0.5 + h.r) ** 2 - 1e-7)) return false;
  return [...config.WALLS, config.BASE_RECT].every(r => {
    if (segmentHitsRect(a, b, r)) return false;
    const corners = [{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x,y:r.y+r.h},{x:r.x+r.w,y:r.y+r.h}];
    return Math.min(rectDistanceSq(a,r), rectDistanceSq(b,r), ...corners.map(p => pointSegmentDistanceSq(p,a,b))) >= 0.25 - 1e-7;
  });
}

function closure(config, pair) {
  const city = config.mapId === 'city';
  const bounds = city ? {x0:11.9,x1:24.5,y0:10.9,y1:14.5} : {x0:20.5,x1:22.7,y0:3.3,y1:9.7};
  const start = city ? {x:24.5,y:14.2} : {x:21.6,y:3.3};
  const end = city ? {x:11.9,y:11.2} : {x:21.6,y:9.7};
  const resolution = 0.1, columns = Math.round((bounds.x1 - bounds.x0) / resolution) + 1;
  const rows = Math.round((bounds.y1 - bounds.y0) / resolution) + 1;
  const key = p => Math.round((p.y - bounds.y0) / resolution) * columns + Math.round((p.x - bounds.x0) / resolution);
  const point = id => ({x:bounds.x0 + id % columns * resolution, y:bounds.y0 + Math.floor(id / columns) * resolution});
  function pathExists(hulls) {
    const queue = [key(start)], seen = new Set(queue), goal = key(end);
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      if (id === goal) return true;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const x = id % columns + dx, y = Math.floor(id / columns) + dy;
        if (x < 0 || x >= columns || y < 0 || y >= rows) continue;
        const next = y * columns + x;
        if (seen.has(next) || !sweptClear(point(id), point(next), config, hulls)) continue;
        seen.add(next); queue.push(next);
      }
    }
    return false;
  }
  const open = {empty:pathExists([]), medium:pathExists([pair[0]]), heavy:pathExists([pair[1]]), pair:pathExists(pair)};
  return {mode:'diagnostic-short-corridor-search', resolution, bounds, start, end, open,
    passed:open.empty && !open.pair && (city ? !open.medium && !open.heavy : open.medium && open.heavy)};
}

function payoff(core, config, pair) {
  const packet = config.WAVES[4].find(group => group.lane === 'B');
  assert(packet);
  const horizonTicks = 7200;
  function scene(blocked) {
    const game = new core.Game({...config, WAVES:[[{...packet,start:0}]]});
    let first = null;
    const shoot = game._shoot;
    game._shoot = function (actor, target, ...args) {
      const hit = this._firstCollision(actor.x, actor.y, target.x, target.y, actor.id);
      const result = shoot.call(this, actor, target, ...args);
      if (result && args[0] === 'enemy' && hit?.kind === 'base' && first === null) {
        first = {seconds:this._waveTime, actorId:actor.id, type:actor.type, x:actor.x, y:actor.y};
      }
      return result;
    };
    if (blocked) game.wrecks = pair.map((w, index) => ({...w,id:`matched-${index}`,expiresAfterWave:2}));
    game.startWave();
    for (let tick = 0; tick < horizonTicks && first === null; tick++) game.update(STEP, {});
    return first;
  }
  const empty = scene(false), blocked = scene(true);
  const delay = empty ? (blocked ? blocked.seconds : horizonTicks * STEP) - empty.seconds : null;
  return {mode:'diagnostic-matched-actual-hulls', packet, player:'alive at map return; identical idle input; normal respawn',
    hulls:pair, horizonSeconds:horizonTicks * STEP, empty, blocked, delaySeconds:delay,
    delayBasis:blocked ? 'two observed first-base-shot events' : 'lower bound to common horizon; blocked event absent',
    passed:delay !== null && delay >= 1.5};
}

function main() {
  const [htmlArgument, snapshotArgument, outputArgument, extra] = process.argv.slice(2);
  assert(htmlArgument && snapshotArgument && outputArgument && !extra,
    'Usage: node tools/verify-map-b-acquisition.cjs <index.html> <exact-prep7.json> <new-output-directory>');
  const html = path.resolve(htmlArgument), snapshotPath = path.resolve(snapshotArgument), output = path.resolve(outputArgument);
  const {core, htmlSha256} = loadCore(html);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.sha256, htmlSha256, 'Preparation snapshot must match these exact HTML bytes');
  const config = core.MAP_CONFIGS[snapshot.mapId];
  assert(config && ['engine','barrel'].includes(snapshot.state.player.module), 'Expected an ordinary campaign fixture');
  assert(!fs.existsSync(output), 'Choose a new output directory');
  fs.mkdirSync(output, {recursive:true});
  fs.copyFileSync(snapshotPath, path.join(output, 'starting-preparation.json'));
  const acquisition = replay(core, config, snapshot, htmlSha256, output);
  const completePair = acquisition.pair.every(Boolean);
  const geometry = completePair ? closure(config, acquisition.pair) : null;
  const benefit = completePair ? payoff(core, config, acquisition.pair) : null;
  const report = {schemaVersion:1, htmlSha256, sources:{html,snapshot:snapshotPath},
    label:'Controlled fixture replay, followed by separately labelled artificial matched-hull diagnostics; not a human playtest',
    acquisition, geometry, benefit, passed:acquisition.passed && geometry?.passed && benefit?.passed};
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({mapId:config.mapId, htmlSha256, passed:report.passed, output}));
  if (!report.passed) process.exitCode = 2;
}

if (require.main === module) main();
module.exports = {closure, payoff, replay};
