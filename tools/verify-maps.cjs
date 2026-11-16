'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {loadCore, resourceCalendar} = require('./calibrate-maps.cjs');

const STEP = 1 / 60;
const HORIZON = 7200;
const LESS_THAN_TIME = 90;
const CONTROL_WAVES = {A:2, C:4, B:5};

function virtualWreck(core, config, wave, lane, index, type, hp) {
  const center = config.TACTICS[lane].blockers[index];
  const spec = config.ENEMY_TYPES[type].wreck;
  return {...center,id:`fixture-${lane}-${index}`,type,hp:hp ?? spec.hp,maxHp:spec.hp,
    r:core.TANK_RADIUS,expiresAfterWave:wave,reinforced:false};
}

const fixtures = {
  empty: [],
  medium: [[0,'medium']],
  lowMedium: [[0,'medium',20]],
  heavy: [[0,'heavy']],
  secondHeavy: [[1,'heavy']],
  pair: [[0,'medium'],[1,'heavy']],
  salvaged: [[0,'medium']],
  destroyed: [[0,'medium',20]],
  expired: [[0,'medium']]
};

function observeScene(core, config, lane, scenario, horizon = HORIZON) {
  const wave = CONTROL_WAVES[lane];
  const group = config.WAVES[wave - 1].find(group => group.lane === lane);
  assert(group, `Missing control group ${wave}/${lane}`);
  const WAVES = config.WAVES.map((groups, index) => index === wave - 1 ? [{...group,start:0}] : groups);
  const cleanup = scenario === 'destroyed' || scenario === 'expired';
  if (cleanup) WAVES[wave - 2] = [];
  const game = new core.Game({...config,WAVES});
  game.waveIndex = wave - 1 - Number(cleanup);
  assert(game.player.alive);
  assert.equal(game.player.module,null);
  assert.equal(game.base.hp,240);
  game.wrecks = fixtures[scenario].map(([index,type,hp]) => virtualWreck(core,config,wave,lane,index,type,hp));
  const introduced = game.wrecks.map(wreck => ({...wreck}));
  let preparationAction = null;
  if (scenario === 'salvaged') {
    const wreckId = game.wrecks[0].id;
    const result = game.repairFromWreck(wreckId);
    assert.equal(result.ok,true);
    assert.equal(game.wrecks.length,0);
    assert.equal(game.base.hp,240);
    assert.equal(game.player.module,null);
    preparationAction = {action:'repairFromWreck',wreckId,result};
  }
  if (cleanup) {
    const wreck = game.wrecks[0];
    const ordinaryReturn = {x:game.player.x,y:game.player.y};
    let input = {};
    if (scenario === 'expired') wreck.expiresAfterWave = wave - 1;
    else {
      const tactics = config.TACTICS[lane];
      const position = [tactics.position, ...tactics.shortPath].find(point =>
        game._positionFree(point.x,point.y,game.player,true) &&
        Math.hypot(point.x-wreck.x,point.y-wreck.y) < core.PLAYER_WEAPON.range &&
        game._firstCollision(point.x,point.y,wreck.x,wreck.y,game.player.id)?.object === wreck
      );
      assert(position,`Fixture cannot shoot hull inside ${config.mapId}/${lane}`);
      Object.assign(game.player,position);
      input = {fire:true,aimX:wreck.x,aimY:wreck.y};
    }
    assert(game.startWave());
    for (let step = 0; step < 120 && game.phase !== 'prep'; step++) game.update(STEP,input);
    assert.equal(game.phase,'prep');
    assert.equal(game.waveNumber,wave);
    assert.equal(game.wrecks.length,0);
    const removal = JSON.parse(game.exportAttemptLog()).events.find(event => event.type === 'wreck_removed');
    assert.equal(removal.reason, scenario === 'expired' ? 'expired' : 'destroyed_by_player');
    preparationAction = {action:scenario,input,removal,cleanupWave:wave-1};
    // The next scene observes routing from the normal return after the fixture treatment.
    Object.assign(game.player,ordinaryReturn);
  }

  const start = {player:{x:game.player.x,y:game.player.y,hp:game.player.hp,module:game.player.module},
    baseHp:game.base.hp,wrecks:game.wrecks.map(wreck => ({...wreck}))};
  let tick = 0;
  let firstBaseShot = null;
  const firstWreckShots = {};
  const coreShoot = game._shoot;
  game._shoot = function (shooter, aim, team, speed, damage, range) {
    const relevant = shooter.lane === lane && team === 'enemy';
    const hit = relevant ? this._firstCollision(shooter.x,shooter.y,aim.x,aim.y,shooter.id) : null;
    const released = coreShoot.call(this,shooter,aim,team,speed,damage,range);
    if (!released || !hit || Math.hypot(aim.x-shooter.x,aim.y-shooter.y)*hit.t > range+1e-7) return released;
    const action = {tick,enemyId:shooter.id,type:shooter.type,position:{x:shooter.x,y:shooter.y},
      aim:{x:aim.x,y:aim.y},bulletId:this.bullets.at(-1).id};
    if (hit.kind === 'base') firstBaseShot ??= action;
    if (hit.kind === 'wreck') firstWreckShots[hit.object.id] ??= action;
    return released;
  };

  assert(game.startWave());
  while (tick < horizon && !firstBaseShot && game.phase !== 'lost') {
    tick++;
    game.update(STEP,{});
  }
  const events = JSON.parse(game.exportAttemptLog()).events;
  return {
    wave,lane,scenario,types:group.types,horizonTicks:horizon,observedTicks:tick,
    input:{stepSeconds:STEP,held:{},playerRespawn:'ordinary'},
    start,introduced,preparationAction,firstBaseShot,firstWreckShots,
    routeEvents:events.filter(event => event.type === 'ai_route'),
    wreckRemovals:events.filter(event => event.type === 'wreck_removed'),
    end:{phase:game.phase,baseHp:game.base.hp,wrecks:game.wrecks,
      player:{x:game.player.x,y:game.player.y,hp:game.player.hp,alive:game.player.alive}}
  };
}

function compare(empty, intact) {
  const baseline = empty.firstBaseShot?.tick ?? null;
  const blocked = intact.firstBaseShot?.tick ?? null;
  const exactTicks = baseline === null || blocked === null ? null : blocked - baseline;
  const lowerBoundTicks = baseline !== null && blocked === null && intact.observedTicks === intact.horizonTicks
    ? intact.horizonTicks - baseline : null;
  const passed = (exactTicks ?? lowerBoundTicks ?? 0) >= LESS_THAN_TIME;
  return {baseline,blocked,exactTicks,lowerBoundTicks,requiredTicks:LESS_THAN_TIME,passed};
}

function verifySerialCityB(config, scenes) {
  const clearingShot = scenes.medium.firstWreckShots['fixture-B-0'];
  const second = scenes.pair.introduced[1];
  if (!clearingShot || !second) return {passed:false,reason:'first-clearance-shot-missing'};
  const secondDistance = Math.hypot(second.x-clearingShot.position.x,second.y-clearingShot.position.y) - second.r;
  const range = config.ENEMY_TYPES[clearingShot.type].range;
  const firstArrival = scene => scene.routeEvents.find(event => event.enemyType === 'medium' && event.lane === 'B');
  const singleBreach = firstArrival(scenes.medium)?.breachSeconds ?? null;
  const pairBreach = firstArrival(scenes.pair)?.breachSeconds ?? null;
  return {clearingShot,secondDistance,range,singleBreach,pairBreach,
    passed:secondDistance > range && Number.isFinite(singleBreach) && Number.isFinite(pairBreach) && pairBreach > singleBreach};
}

function verifyMaps(core) {
  const maps = {};
  for (const [mapId,config] of Object.entries(core.MAP_CONFIGS)) {
    const lanes = {};
    for (const lane of Object.keys(CONTROL_WAVES)) {
      const variants = lane === 'B' ? Object.keys(fixtures) :
        Object.keys(fixtures).filter(name => name !== 'secondHeavy' && name !== 'pair');
      const scenes = Object.fromEntries(variants.map(scenario => [scenario,observeScene(core,config,lane,scenario)]));
      const benefit = compare(scenes.empty,scenes[lane === 'B' ? 'pair' : 'medium']);
      const removedMatchesEmpty = (scenes.salvaged.firstBaseShot?.tick ?? null) === (scenes.empty.firstBaseShot?.tick ?? null);
      const serialClearance = mapId === 'city' && lane === 'B' ? verifySerialCityB(config,scenes) : null;
      lanes[lane] = {benefit,removedMatchesEmpty,serialClearance,scenes};
      console.error(JSON.stringify({mapId,lane,benefit,removedMatchesEmpty}));
    }
    maps[mapId] = {mapId,mapVersion:config.mapVersion,lanes};
  }
  return maps;
}

function restorePreparation(core, snapshot, htmlSha256) {
  assert.equal(snapshot.sha256, htmlSha256, 'Preparation snapshot must match the shipped HTML bytes');
  const config = core.MAP_CONFIGS[snapshot.mapId];
  assert(config, 'Snapshot names an unknown map');
  const game = new core.Game(config);
  const caches = new Set(['config','_grid','_openField','_breachSearch','_shotFields','_traffic']);
  for (const key of Object.keys(game)) {
    if (caches.has(key) || !Object.hasOwn(snapshot.state,key)) continue;
    game[key] = structuredClone(snapshot.state[key]);
  }
  assert.equal(game.phase,'prep','Only a recorded preparation boundary can be replayed');
  assert.equal(game._attemptConfiguration.game.mapId,config.mapId);
  assert.equal(game._attemptConfiguration.game.mapVersion,config.mapVersion);
  assert.equal(JSON.stringify(game._attemptConfiguration.game),JSON.stringify(config));
  return game;
}

function inArea(wreck, area) {
  return wreck.x >= area.x && wreck.x <= area.x + area.w && wreck.y >= area.y && wreck.y <= area.y + area.h;
}

function replayPreparation(core, snapshot, htmlSha256) {
  const baseline = restorePreparation(core,snapshot,htmlSha256);
  const wave = baseline.waveNumber;
  assert([2,5,7,8].includes(wave), 'Use a snapshot before wave 2, 5, 7 or 8');
  const status = game => ({
    baseHp:game.base.hp,module:game.player.module,wrecks:game.wrecks.map(wreck => ({...wreck}))
  });
  const report = {mode:'recorded-preparation-replay',mapId:snapshot.mapId,wave,attemptMode:snapshot.mode,
    fromTick:snapshot.tick,initial:status(baseline),branches:{}};
  const areas = Object.values(baseline.config.TACTICS).flatMap(tactic => tactic.usefulAreas);
  const useful = wreck => areas.some(area => inArea(wreck,area));
  const createdInWave = (wreck,index) => baseline._attemptEvents.some(event =>
    event.type === 'wreck_created' && event.wreck.id === wreck.id && event.wave === index);
  const branch = (name, actions, expected = true) => {
    if (!expected) {
      report.branches[name] = {available:false,reason:'required-recorded-wreck-missing'};
      return;
    }
    const replay = restorePreparation(core,snapshot,htmlSha256);
    const results = actions.map(([method,...args]) => {
      const result = replay[method](...args);
      assert.equal(result.ok,true,`${method} failed for ${args.join(', ')}`);
      return {method,args,result};
    });
    const after = status(replay);
    report.branches[name] = {available:true,actions:results,after,battle:observeIdleBattle(replay)};
  };
  branch('keepRecorded',[]);
  if (wave === 2) {
    const wreck = baseline.wrecks.find(wreck => wreck.type === 'medium' && createdInWave(wreck,1));
    report.waveOneHull = wreck ? {id:wreck.id,useful:useful(wreck)} : null;
    branch('engine',[['installModuleFromWreck',wreck?.id,'engine']],Boolean(wreck));
    branch('barrel',[['installModuleFromWreck',wreck?.id,'barrel']],Boolean(wreck));
    branch('repair',[['repairFromWreck',wreck?.id]],Boolean(wreck));
  } else if (wave === 5) {
    // C is the only source of a heavy in wave 4.
    const heavy = baseline.wrecks.find(wreck => wreck.type === 'heavy' && createdInWave(wreck,4));
    const donor = baseline.wrecks.find(wreck => wreck.type === 'medium' && createdInWave(wreck,4));
    report.availableFromWaveFour = {
      heavy:heavy?.id ?? null, donor:donor?.id ?? null, heavyUseful:heavy ? useful(heavy) : null
    };
    branch('armor',[['installModuleFromWreck',heavy?.id,'armor']],Boolean(heavy));
    branch('reinforced',[['reinforceWreck',donor?.id,heavy?.id]],Boolean(donor && heavy));
  } else {
    const config = baseline.config;
    const expiry = Object.fromEntries(['medium','heavy'].map(type => [type,config.ENEMY_TYPES[type].wreck.waves]));
    report.resourceUpperBound = resourceCalendar(config.WAVES,expiry).beforeWaves[wave-1];
    report.recordedExpiry = baseline._attemptEvents.filter(event =>
      event.type === 'wreck_removed' && event.reason === 'expired' && event.wave === wave-1);
    const candidate = baseline.wrecks.find(useful);
    branch('spentOneUseful',[['repairFromWreck',candidate?.id]],Boolean(candidate));
    branch('noWrecks',baseline.wrecks.map(wreck => ['repairFromWreck',wreck.id]));
  }
  return report;
}

function calendarWrecks(core, game) {
  const config = game.config;
  const expiry = Object.fromEntries(['medium','heavy'].map(type => [type,config.ENEMY_TYPES[type].wreck.waves]));
  const bound = resourceCalendar(config.WAVES,expiry).beforeWaves[game.waveNumber-1];
  const entries = bound.available.slice().sort((a,b) => Number(a.type === 'heavy') - Number(b.type === 'heavy'));
  game.wrecks = [];
  for (const [index,entry] of entries.entries()) {
    const tactics = config.TACTICS[entry.lane];
    const slot = entry.lane === 'B' && entry.type === 'heavy' ? 1 : 0;
    const candidate = {id:`calendar-${index}`,type:entry.type,r:core.TANK_RADIUS};
    const positions = [tactics.blockers[slot], ...tactics.shortPath.slice(1), ...tactics.bypass.slice(1)];
    const point = positions.find(point => point && game._positionFree(point.x,point.y,candidate,true));
    assert(point,`No separate position for calendar fixture ${entry.lane}/${entry.type}`);
    const maxHp = config.ENEMY_TYPES[entry.type].wreck.hp;
    game.wrecks.push({...candidate,...point,hp:maxHp,maxHp,expiresAfterWave:entry.throughWave,reinforced:false,
      sourceWave:entry.sourceWave,sourceLane:entry.lane});
  }
  return bound;
}

function observeIdleBattle(game) {
  const damage = [];
  const beforeEvents = game._attemptEvents.length;
  const firstShots = {};
  let firstBaseShot = null;
  let tick = 0;
  const shoot = game._shoot;
  game._shoot = function (shooter, aim, team, speed, shotDamage, range) {
    const lane = shooter.lane;
    const line = team === 'enemy' && lane && !firstShots[lane]
      ? this._firstCollision(shooter.x,shooter.y,aim.x,aim.y,shooter.id)
      : null;
    const released = shoot.call(this,shooter,aim,team,speed,shotDamage,range);
    if (released && line?.kind === 'base' && Math.hypot(aim.x-shooter.x,aim.y-shooter.y)*line.t <= range+1e-7) {
      const result = {tick,lane,enemyId:shooter.id,type:shooter.type,position:{x:shooter.x,y:shooter.y},
        bulletId:this.bullets.at(-1).id};
      firstShots[lane] = result;
      firstBaseShot ??= result;
    }
    return released;
  };
  assert(game.startWave());
  while (tick < HORIZON && (game.phase === 'battle' || game.phase === 'settling')) {
    const before = game.base.hp;
    tick++;
    game.update(STEP,{});
    if (game.base.hp !== before) damage.push({tick,hpBefore:before,hpAfter:game.base.hp});
  }
  const events = game._attemptEvents.slice(beforeEvents);
  const decisions = events.filter(event => event.type === 'ai_route')
    .reduce((counts,event) => {
      counts[event.decision] = (counts[event.decision] ?? 0) + 1;
      return counts;
    },{});
  return {horizonTicks:HORIZON,observedTicks:tick,input:{stepSeconds:STEP,held:{}},
    firstBaseShot,firstShots,firstDamage:damage[0] ?? null,damage,decisions,
    phase:game.phase,baseHp:game.base.hp,playerHp:game.player.hp,playerAlive:game.player.alive,
    wrecksAfter:game.wrecks,removed:events.filter(event => event.type === 'wreck_removed'),pending:game._spawnQueue};
}

function replayCalendarVariants(core, snapshot, htmlSha256) {
  const baseline = restorePreparation(core,snapshot,htmlSha256);
  const wave = baseline.waveNumber;
  assert([7,8].includes(wave), 'Use recorded preparation before wave 7 or 8');
  const branches = {};
  for (const variant of ['maximum','oneUsefulSpent','oneOlderExpired','noWrecks']) {
    const game = restorePreparation(core,snapshot,htmlSha256);
    const maximum = calendarWrecks(core,game);
    let action = null;
    if (variant === 'oneUsefulSpent') {
      const wreck = game.wrecks.find(wreck => game.config.TACTICS[wreck.sourceLane].usefulAreas.some(area => inArea(wreck,area)));
      assert(wreck,'The maximum fixture has to include a useful hull');
      const result = game.repairFromWreck(wreck.id);
      assert.equal(result.ok,true);
      action = {method:'repairFromWreck',wreckId:wreck.id,result};
    }
    if (variant === 'oneOlderExpired') {
      const olderLane = wave === 7 ? 'C' : 'A';
      const wreck = game.wrecks.find(wreck => wreck.type === 'medium' && wreck.sourceLane === olderLane);
      const olderSource = wave - 2;
      assert(game.config.WAVES[olderSource-1].some(group => group.lane === olderLane && group.types.includes('medium')));
      wreck.sourceWave = olderSource;
      wreck.expiresAfterWave = wave - 1;
      const original = game.config;
      game.config = {...original,WAVES:original.WAVES.map((groups,index) => index === wave-2 ? [] : groups)};
      game.waveIndex--;
      assert(game.startWave());
      game.update(STEP,{});
      game.config = original;
      assert.equal(game.waveNumber,wave);
      assert.equal(game.phase,'prep');
      const removal = game._attemptEvents.find(event => event.type === 'wreck_removed' && event.wreck.id === wreck.id);
      assert.equal(removal.reason,'expired');
      action = {olderSource,removal};
    }
    if (variant === 'noWrecks') game.wrecks = [];
    const start = {baseHp:game.base.hp,player:{x:game.player.x,y:game.player.y,module:game.player.module},
      wrecks:game.wrecks.map(wreck => ({...wreck}))};
    branches[variant] = {maximum,action,start,battle:observeIdleBattle(game)};
  }
  return {mode:'artificial-calendar-controls',mapId:snapshot.mapId,wave,fromTick:snapshot.tick,
    actualRecordedWrecks:baseline.wrecks,combatInput:{stepSeconds:STEP,held:{}},branches};
}

function main() {
  const [html,output,...args] = process.argv.slice(2);
  assert(html && output,'Usage: node tools/verify-maps.cjs <index.html> <report.json> [prep-2.json prep-5.json ...] [--calendar prep-7.json prep-8.json ...]');
  const cut = args.indexOf('--calendar');
  const preparationFiles = cut === -1 ? args : args.slice(0,cut);
  const calendarFiles = cut === -1 ? [] : args.slice(cut+1);
  const {core,htmlSha256} = loadCore(html);
  const maps = verifyMaps(core);
  const preparationReplays = preparationFiles.map(file =>
    replayPreparation(core,JSON.parse(fs.readFileSync(file,'utf8')),htmlSha256));
  const calendarControls = calendarFiles.map(file =>
    replayCalendarVariants(core,JSON.parse(fs.readFileSync(file,'utf8')),htmlSha256));
  const report = {schemaVersion:1,mode:'diagnostic-hull-contrasts',htmlSha256,maps,preparationReplays,calendarControls};
  fs.writeFileSync(output,JSON.stringify(report,null,2) + '\n');
  process.exitCode = Object.values(maps).every(map => Object.values(map.lanes)
    .every(lane => lane.benefit.passed && lane.removedMatchesEmpty && (lane.serialClearance?.passed ?? true))) ? 0 : 2;
}

if (require.main === module) main();
module.exports = {compare,observeScene,replayCalendarVariants,replayPreparation,restorePreparation,verifyMaps};
