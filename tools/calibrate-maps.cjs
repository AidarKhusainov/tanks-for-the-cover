'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TICKS_PER_SECOND = 60;
const STEP = 1 / TICKS_PER_SECOND;
const SPAWN_INTERVAL = 150;
const PLAYER_COOLDOWN = 18;
const REACTION = 90;
const CORRECTION_QUANTUM = 15;
const MAX_PASSES = 8;
const MAX_START = 2700;
const HORIZON = 7200;
const PATH_TOLERANCE = 0.10;
const COMBAT_PARENT = '16358105cdaf3a94b64122dc87769a451ef3b0d9'; // #33 changes merged through PR #35.
const EXPECTED_PACKETS = [
  {A:'LMLL'}, {A:'MLMLL'}, {C:'LMLMLL'}, {C:'MHLL', B:'LMLM'},
  {B:'MHLL', C:'LMLL'}, {A:'LML',C:'MLLL',B:'MLL'},
  {B:'LHML',C:'MLL',A:'MHLL'}, {A:'HLMLL',B:'MLLL',C:'HLMLL'}
];
const PACE = {
  magnetic: ['A','A','C','CUB','BUC','ADCUB','BDCDA','AFBFC'],
  city: ['A','A','C','CUB','CDB','CDAUB','BDADC','CFAFB']
};
const LETTER = {light:'L',medium:'M',heavy:'H'};
const HITS = {light:1,medium:3,heavy:6};

function loadCore(html) {
  const text = fs.readFileSync(html, 'utf8');
  const scripts = [...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 3, 'Expected bundled scenario, core, and UI scripts');
  const sandbox = vm.createContext({});
  vm.runInContext(scripts[0], sandbox, {filename:'scenarios.js'});
  vm.runInContext(scripts[1], sandbox, {filename:'core.js'});
  return {core:sandbox.TankCore, htmlSha256:createHash('sha256').update(text).digest('hex')};
}

function validateWaves(config) {
  assert.equal(config.WAVES.length, EXPECTED_PACKETS.length);
  assert.equal(config.SPAWN_INTERVAL, SPAWN_INTERVAL / TICKS_PER_SECOND);
  for (const [index, wave] of config.WAVES.entries()) {
    const actual = Object.fromEntries(wave.map(({lane, types}) => [lane, types.map(type => LETTER[type]).join('')]));
    assert.equal(Object.keys(actual).length, wave.length, 'One group per lane per wave');
    assert.deepEqual(actual, EXPECTED_PACKETS[index], `Wave ${index + 1} packet order/group differs from §3.2`);
    for (const group of wave) assert(config.SPAWNS[group.lane], `Unknown spawn ${group.lane}`);
  }
  for (const [type, count] of Object.entries(HITS)) assert.equal(config.ENEMY_TYPES[type].hp, count * 20);
}

function parsePace(map, waveIndex) {
  const sequence = PACE[map][waveIndex];
  const result = [];
  for (let index = 0; index < sequence.length - 1; index += 2) {
    result.push({from:sequence[index], to:sequence[index + 2], mode:sequence[index + 1]});
  }
  return result;
}

function packetBudget(types) {
  const N = types.length;
  const J = types.reduce((sum, type) => sum + HITS[type], 0);
  return {N, J, K:(N - 1) * SPAWN_INTERVAL + (J - 1) * PLAYER_COOLDOWN};
}

function resourceCalendar(waves, expiry = {medium:1, heavy:2}) {
  const totalEnemies = {light:0, medium:0, heavy:0};
  const corpses = [];
  const beforeWaves = [];
  for (const [waveIndex, groups] of waves.entries()) {
    const wave = waveIndex + 1;
    const available = corpses.filter(({throughWave}) => throughWave >= wave);
    beforeWaves.push({
      wave, medium:available.filter(({type}) => type === 'medium').length,
      heavy:available.filter(({type}) => type === 'heavy').length, available
    });
    for (const {lane, types} of groups) {
      for (const type of types) {
        totalEnemies[type]++;
        if (expiry[type]) corpses.push({type, lane, sourceWave:wave, throughWave:wave + expiry[type]});
      }
    }
  }
  const potentialBeforeFinal = Object.fromEntries(Object.keys(expiry).map(type => [
    type, corpses.filter(corpse => corpse.type === type && corpse.sourceWave < waves.length).length
  ]));
  return {totalEnemies, beforeWaves, potentialBeforeFinal};
}

function boundsFor(mode, K, Q) {
  assert(Number.isSafeInteger(Q) && Q >= 0);
  let G;
  if (mode === 'U') G = K + Q + REACTION;
  else if (mode === 'D') G = Q + REACTION;
  else if (mode === 'F') G = Math.max(REACTION, Q / 2);
  else throw new Error(`Unknown mode: ${mode}`);
  const L = Math.ceil(G);
  const U = mode === 'F' ? Math.min(L + TICKS_PER_SECOND, Q - 1) : L + TICKS_PER_SECOND;
  return {G,L,U};
}

function normalizeStarts(starts) {
  const offset = Math.min(...Object.values(starts));
  return Object.fromEntries(Object.entries(starts).map(([lane, start]) => [lane, start - offset]));
}

function solveWave(waveNumber, groups, pace, Q, T, run) {
  const lanes = groups.map(({lane}) => lane);
  const budgets = Object.fromEntries(groups.map(({lane,types}) => [lane, packetBudget(types)]));
  const report = {wave:waveNumber, budgets, T, arrows:[], initialS:null, S:null, F:null, FMeasuredAtS:null,
    corrections:[], replays:[]};
  const fail = (reason, detail = {}) => ({...report, ok:false, reason, detail});
  for (const arrow of pace) {
    const {from,to,mode} = arrow;
    const route = Q[`${from}>${to}`];
    const bounds = route?.ticks != null ? boundsFor(mode, budgets[from].K, route.ticks) : {G:null,L:null,U:null};
    report.arrows.push({...arrow, Qticks:route?.ticks ?? null, ...bounds, routeOk:route?.ok ?? false});
  }
  const absentSolo = lanes.filter(lane => !Number.isSafeInteger(T[lane]));
  if (absentSolo.length) return fail('solo-shot-undefined', {lanes:absentSolo});
  const impossible = report.arrows.filter(({L,U}) => L !== null && L > U);
  if (impossible.length) return fail('empty-gap-window', {arrows:impossible});
  const invalidRoutes = report.arrows.filter(({routeOk}) => !routeOk);
  if (invalidRoutes.length) return fail('invalid-transition-route', {arrows:invalidRoutes});
  const H = {[pace[0]?.from ?? lanes[0]]:0};
  for (const {from,to,G} of report.arrows) H[to] = H[from] + G;
  report.H = H;
  report.d = Object.fromEntries(lanes.map(lane => [lane,H[lane] - T[lane]]));
  report.initialS = Object.fromEntries(Object.entries(normalizeStarts(report.d))
    .map(([lane, ticks]) => [lane,Math.ceil(ticks)]));
  report.S = {...report.initialS};

  const seen = new Set();
  function measure() {
    const {S} = report;
    if (waveNumber === 4 && (S.C !== 0 || S.B < 180)) return fail('wave-four-start-constraint', {S});
    const key = lanes.map(lane => S[lane]).join(',');
    if (seen.has(key)) return fail('correction-cycle', {S});
    seen.add(key);
    const combined = run(S);
    report.F = Object.fromEntries(lanes.map(lane => [lane, combined.lane[lane]?.firstShot?.tick ?? null]));
    report.FMeasuredAtS = S;
    const error = Object.fromEntries(lanes.map(lane => [
      lane, report.F[lane] === null ? null : report.F[lane] - S[lane] - T[lane]
    ]));
    for (const arrow of report.arrows) {
      const {from,to,L,U,G} = arrow;
      arrow.actual = report.F[from] === null || report.F[to] === null ? null : report.F[to] - report.F[from];
      arrow.offsetFromG = arrow.actual === null ? null : arrow.actual - G;
      arrow.inWindow = arrow.actual !== null && arrow.actual >= L && arrow.actual <= U;
    }
    report.replays.push({S, F:report.F, errorFromSoloPrediction:error,
      arrows:report.arrows.map(arrow => ({...arrow})), ...combined});
    const absentCombined = lanes.filter(lane => !Number.isSafeInteger(report.F[lane]));
    if (absentCombined.length) return fail('combined-shot-undefined', {lanes:absentCombined});
    return null;
  }

  function success() {
    const exceeds = Object.entries(report.S).filter(([,ticks]) => ticks > MAX_START);
    if (exceeds.length) return fail('maximum-start-exceeded', {starts:Object.fromEntries(exceeds), max:MAX_START});
    return {...report, ok:true};
  }

  const failedInitial = measure();
  if (failedInitial) return failedInitial;
  if (report.arrows.every(({inWindow}) => inWindow)) return success();
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    for (const {from,to,L,U,actual,inWindow} of report.arrows) {
      if (inWindow) continue;
      const midpoint = Math.floor((L + U) / 2);
      const shift = midpoint - actual;
      const delta = Math.sign(shift) * Math.ceil(Math.abs(shift) / CORRECTION_QUANTUM) * CORRECTION_QUANTUM;
      const before = report.S;
      report.S = normalizeStarts({...before, [to]:before[to] + delta});
      report.corrections.push({pass, from, to, L, U, actual, midpoint, delta, before, after:report.S});
      const failed = measure();
      if (failed) return failed;
      if (report.arrows.every(({inWindow:inside}) => inside)) return success();
    }
  }
  return fail('correction-pass-limit', {max:MAX_PASSES});
}

function positionOf(player) {
  return {x:player.x,y:player.y};
}

function distance(a,b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const norm = dx * dx + dy * dy;
  const fraction = norm ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / norm)) : 0;
  return distance(point, {x:start.x + fraction * dx, y:start.y + fraction * dy});
}

function positionIsValid(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function recordCommand(commands, input) {
  const previous = commands.at(-1);
  if (previous?.x === input.x && previous.y === input.y) previous.ticks++;
  else commands.push({...input,ticks:1});
}

function plannedDigitalCommands(start, target, speed) {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const step = speed * STEP;
  const signs = {x:Math.sign(dx),y:Math.sign(dy)};
  const major = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  const axis = major === 'x' ? {x:signs.x,y:0} : {x:0,y:signs.y};
  const diagonalCount = Math.round(Math.min(Math.abs(dx), Math.abs(dy)) * Math.SQRT2 / step);
  const axisCount = Math.max(0, Math.round((Math.max(Math.abs(dx),Math.abs(dy)) - diagonalCount * step / Math.SQRT2) / step));
  const total = axisCount + diagonalCount;
  const result = [];
  for (let index = 0; index < total; index++) {
    const isDiagonal = Math.round((index + 1) * diagonalCount / total) > Math.round(index * diagonalCount / total);
    result.push(isDiagonal ? signs : axis);
  }
  return result;
}

function verifyCommand({x,y,ticks}) {
  return [x,y].every(axis => [-1,0,1].includes(axis)) && x*x + y*y > 0 &&
    Number.isSafeInteger(ticks) && ticks > 0 && ticks <= HORIZON;
}

function measureRoute(core, config, positions, routes, from, to) {
  const entry = routes[`${from}>${to}`];
  const start = positions[from];
  const end = positions[to];
  const report = {from,to,start,end,ticks:null,commands:[],ok:false};
  const fail = (reason, detail = {}) => ({...report, reason, detail});
  if (entry === undefined) return fail('route-undefined');
  if (!positionIsValid(start) || !positionIsValid(end)) return fail('position-undefined');
  const Game = core.Game;
  const game = new Game(config);
  assert.equal(game._playerStats.speed, 4, 'Q requires default speed 4');
  assert.equal(game.playerWeaponRange, 6, 'Q requires stock range');
  assert.equal(game.player.module, null, 'Q requires no module');
  if (!game._positionFree(start.x,start.y,game.player,true)) return fail('blocked-start-position');
  if (!game._positionFree(end.x,end.y,game.player,true)) return fail('blocked-end-position');
  Object.assign(game.player, start); // Diagnostic setup starts each run at the same declared interception point.
  let ticks = 0;
  const step = input => {
    const before = positionOf(game.player);
    game.update(STEP,input);
    recordCommand(report.commands,input);
    ticks++;
    return distance(before,game.player);
  };
  if (entry?.commands) {
    if (!entry.commands.every(verifyCommand)) return fail('invalid-digital-input-sequence');
    for (const {x,y,ticks:duration} of entry.commands) {
      for (let index = 0; index < duration; index++) {
        if (step({x,y}) < 1e-7) return fail('route-command-blocked', {tick:ticks, at:positionOf(game.player)});
      }
    }
    report.waypoints = entry.waypoints ?? null;
  } else {
    const waypoints = Array.isArray(entry) ? entry : entry?.waypoints;
    if (!Array.isArray(waypoints) || !waypoints.every(positionIsValid)) return fail('invalid-waypoints');
    const declared = [start, ...waypoints, end].filter((point, index, all) => !index || distance(point, all[index-1]) > 1e-8);
    report.waypoints = declared;
    for (let index = 1; index < declared.length; index++) {
      const target = declared[index];
      const inputs = plannedDigitalCommands(positionOf(game.player), target, game._playerStats.speed);
      for (const input of inputs) {
        step(input);
        const drift = segmentDistance(game.player,declared[index-1],target);
        if (drift > PATH_TOLERANCE) return fail('left-declared-route', {tick:ticks, segment:index, at:positionOf(game.player), drift});
      }
      if (distance(game.player, target) > PATH_TOLERANCE) return fail('route-waypoint-unreached', {
        tick:ticks, segment:index, target, at:positionOf(game.player)
      });
    }
  }
  report.arrival = positionOf(game.player);
  if (distance(report.arrival,end) > PATH_TOLERANCE) return fail('route-destination-unreached', {tick:ticks});
  report.ticks = ticks;
  report.seconds = ticks * STEP;
  if (ticks < 120 || ticks > 300) return fail('route-time-outside-2-to-5-seconds', {requiredTicks:[120,300]});
  report.ok = true;
  return report;
}

function runCombat(core, config, waveIndex, groups, S, horizon = HORIZON) {
  const waves = config.WAVES.map((wave,index) => index === waveIndex
    ? groups.map(group => ({...group,start:S[group.lane] / TICKS_PER_SECOND})) : wave);
  const game = new core.Game({...config,WAVES:waves});
  game.waveIndex = waveIndex;
  game.player.alive = false;
  game._updateRespawn = () => {};
  assert.equal(game.base.hp, 240);
  assert.equal(game.wrecks.length, 0);
  assert.equal(game.enemies.length, 0);
  const lane = Object.fromEntries(groups.map(group => [group.lane,{
    startTick:S[group.lane], plannedTypes:group.types, spawns:[], firstShot:null, firstHit:null
  }]));
  const spawnCount = groups.reduce((sum, group) => sum + group.types.length, 0);
  const ownerLane = new Map();
  let tick = 0;
  const spawnDue = game._spawnDue;
  game._spawnDue = function () {
    const before = this.enemies.length;
    spawnDue.call(this);
    for (const enemy of this.enemies.slice(before)) {
      ownerLane.set(enemy.id, enemy.lane);
      const observation = lane[enemy.lane];
      const last = observation.spawns.at(-1);
      const plannedTick = observation.startTick + observation.spawns.length * SPAWN_INTERVAL;
      assert(tick >= plannedTick);
      assert(!last || tick - last.tick >= SPAWN_INTERVAL);
      assert.equal(enemy.type, observation.plannedTypes[observation.spawns.length]);
      observation.spawns.push({
        tick, plannedTick, queueDelayTicks:tick - plannedTick,
        enemyId:enemy.id, type:enemy.type, position:positionOf(enemy)
      });
    }
  };
  const shoot = game._shoot;
  game._shoot = function (shooter,target,team,speed,damage,range) {
    const observation = team === 'enemy' ? lane[shooter.lane] : null;
    let hit;
    let distanceToBase;
    if (observation && observation.firstShot === null) {
      hit = this._firstCollision(shooter.x,shooter.y,target.x,target.y,shooter.id);
      if (hit?.kind === 'base') distanceToBase = hit.t * distance(shooter,target);
    }
    const released = shoot.call(this,shooter,target,team,speed,damage,range);
    if (released && hit?.kind === 'base' && distanceToBase <= range + 1e-7) {
      observation.firstShot = {
        tick, seconds:tick * STEP, enemyId:shooter.id, type:shooter.type, position:positionOf(shooter),
        aim:positionOf(target), distanceToBase, range, bulletId:this.bullets.at(-1).id
      };
    }
    return released;
  };
  const applyHit = game._applyHit;
  game._applyHit = function (hit,bullet) {
    if (hit.kind !== 'base') return applyHit.call(this,hit,bullet);
    if (bullet.team === 'enemy') {
      const observation = lane[ownerLane.get(bullet.ownerId)];
      assert(observation, `Untracked owner ${bullet.ownerId}`);
      if (observation.firstHit === null) {
        const travel = Math.min(bullet.speed * STEP,bullet.remaining) * hit.t;
        observation.firstHit = {tick, seconds:tick * STEP, bulletId:bullet.id, enemyId:bullet.ownerId,
          position:{x:bullet.x + bullet.dx * travel,y:bullet.y + bullet.dy * travel}};
      }
    }
    // Core already consumed the projectile and emitted contact. Keep ordinary base HP for target selection.
  };
  const measured = () => Object.values(lane).every(entry => entry.firstShot !== null && entry.firstHit !== null) &&
    Object.values(lane).reduce((sum, entry) => sum + entry.spawns.length, 0) === spawnCount;
  assert(game.startWave());
  while (tick < horizon && !measured()) {
    tick++;
    game.update(STEP);
  }
  assert.equal(game.base.hp, 240, 'Measurement does not change base HP');
  assert.equal(game.player.alive,false, 'Measurement player remains absent');
  assert.equal(Math.round(game._waveTime * TICKS_PER_SECOND),tick);
  const complete = measured();
  return {lane, observedTicks:tick, horizon:complete ? null : horizon,
    pendingQueue:game._spawnQueue, complete,
    finalActors:complete ? undefined : game.enemies.map(enemy => ({
      id:enemy.id, lane:enemy.lane, type:enemy.type, position:positionOf(enemy),
      hp:enemy.hp, intent:enemy.intent, stationaryTarget:enemy.stationaryTarget, routeDecision:enemy.routeDecision?.decision ?? null
    }))
  };
}

function measureSolo(core, config, waveIndex, group, horizon = HORIZON) {
  const {lane} = group;
  const run = runCombat(core,config,waveIndex,[group],{[lane]:0},horizon);
  const observed = run.lane[lane];
  observed.T = observed.firstShot === null || !observed.spawns.length
    ? null : observed.firstShot.tick - observed.spawns[0].tick;
  return run;
}

function measureCombined(core, config, waveIndex, S, horizon = HORIZON) {
  return runCombat(core,config,waveIndex,config.WAVES[waveIndex],S,horizon);
}

function calibrateMap(core, map, config, progress = () => {}) {
  validateWaves(config);
  const tactical = {
    positions:Object.fromEntries(Object.entries(config.TACTICS).map(([lane,data]) => [lane,data.position])),
    routes:config.TRAVEL_ROUTES
  };
  const Q = {};
  for (const index of config.WAVES.keys()) {
    for (const {from,to} of parsePace(map,index)) {
      const key = `${from}>${to}`;
      if (Q[key]) continue;
      Q[key] = measureRoute(core,config,tactical.positions,tactical.routes,from,to);
      progress({map,route:key,ticks:Q[key].ticks,ok:Q[key].ok,reason:Q[key].reason});
    }
  }
  const waves = [];
  for (const [waveIndex, groups] of config.WAVES.entries()) {
    const solo = Object.fromEntries(groups.map(group => [group.lane,measureSolo(core,config,waveIndex,group)]));
    const T = Object.fromEntries(groups.map(({lane}) => [lane,solo[lane].lane[lane].T]));
    const result = solveWave(waveIndex + 1, groups, parsePace(map,waveIndex), Q, T,
      S => measureCombined(core,config,waveIndex,S));
    const configuredS = Object.fromEntries(groups.map(({lane,start}) => [lane,start * TICKS_PER_SECOND]));
    const startsMatchShipped = result.ok && groups.every(({lane}) => Math.abs(configuredS[lane] - result.S[lane]) < 1e-8);
    waves.push({groups:groups.map(({lane,types}) => ({lane,types})), solo, ...result, configuredS, startsMatchShipped});
    progress({map,wave:waveIndex+1,T,S:result.S,F:result.F,FMeasuredAtS:result.FMeasuredAtS,ok:result.ok,reason:result.reason});
  }
  const expiry = Object.fromEntries(['medium','heavy'].map(type => [type,config.ENEMY_TYPES[type].wreck.waves]));
  assert.deepEqual(expiry,{medium:1,heavy:2},'Expected #33 wreck life in waves');
  const resources = resourceCalendar(config.WAVES,expiry);
  return {
    mapId:config.mapId, mapVersion:config.mapVersion,
    configurationSha256:createHash('sha256').update(JSON.stringify({config,tactical})).digest('hex'),
    baseRect:config.BASE_RECT, playerStart:config.PLAYER_START, spawns:config.SPAWNS, tactics:tactical, resources, Q, waves,
    calibrationOk:waves.every(({ok}) => ok),
    successfulCompleteObservations:waves.every(wave =>
      Object.values(wave.solo).every(({complete}) => complete) && Boolean(wave.replays.at(-1)?.complete)),
    startsMatchShipped:waves.every(({startsMatchShipped}) => startsMatchShipped)
  };
}

function gitRevision(html, revision) {
  try {
    return execFileSync('git',['-C',path.dirname(html),'rev-parse',revision],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  } catch {
    return null;
  }
}

function main() {
  const [html,output,maybeMap] = process.argv.slice(2);
  if (!html || !output || (maybeMap && !Object.hasOwn(PACE,maybeMap))) {
    throw new Error('Usage: node tools/calibrate-maps.cjs <index.html> <report.json> [magnetic|city]');
  }
  const {core,htmlSha256} = loadCore(html);
  assert.equal(core.PLAYER_WEAPON.range, 6);
  assert.equal(core.PLAYER_WEAPON.damage, 20);
  assert.equal(core.PLAYER_WEAPON.cooldown, 0.30);
  const report = {
    schemaVersion:1, mode:'diagnostic-campaign-calibration',
    units:'integer ticks at 60 Hz; G/H/d can include a half tick before rounding',
    rules:'Absent measurement player, suppressed automatic respawn, base HP held at 240 after real contact; no wrecks.',
    source:{html:path.resolve(html),htmlSha256,worktreeHead:gitRevision(html,'HEAD'),issue33CombatCommit:COMBAT_PARENT},
    horizonTicks:HORIZON, maps:{}
  };
  for (const map of maybeMap ? [maybeMap] : Object.keys(PACE)) {
    const config = core.MAP_CONFIGS?.[map];
    if (!config) { report.maps[map] = {calibrationOk:false, reason:'shipped-map-undefined'}; continue; }
    report.maps[map] = calibrateMap(core,map,config,message => console.error(JSON.stringify(message)));
  }
  fs.writeFileSync(output,JSON.stringify(report,null,2) + '\n');
  process.exitCode = Object.values(report.maps).every(map => map.calibrationOk && map.successfulCompleteObservations &&
    map.startsMatchShipped) ? 0 : 2;
}

if (require.main === module) main();
module.exports = {
  boundsFor, calibrateMap, loadCore, measureCombined, measureRoute, measureSolo, normalizeStarts, packetBudget,
  parsePace, resourceCalendar, runCombat, solveWave
};
