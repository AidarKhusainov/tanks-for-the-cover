'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {loadCore} = require('./calibrate-maps.cjs');
const policy = require('./maps-campaign-policy.cjs');

const STEP = 1 / 60;
const WAVE_ONE_ROUTES = {
  magnetic: [[16.4,15.87],[13.65,15.87],[13.65,17.2],[11.75,17.2],[11.75,12.2],[7.6,12.2],[7.6,10.2]],
  city: [[6.85,14],[4.025,14],[4.025,15.2],[1.8,15.2],[1.8,9.2],[6,9.2],[6,8.6]]
};

function readState(game) {
  return {
    phase:game.phase, wave:game.waveNumber, player:{...game.player}, baseHp:game.base.hp,
    enemies:game.enemies.map(enemy => ({...enemy})), wrecks:game.wrecks.map(wreck => ({...wreck})),
    bullets:game.bullets.map(bullet => ({...bullet})), queue:game._spawnQueue.map(entry => ({...entry})),
    battleSeconds:game.stats.time
  };
}

function applyRecordedAction(game, command) {
  if (command.kind === 'startWave') assert(game.startWave());
  else if (command.kind === 'installModuleFromWreck') assert(game.installModuleFromWreck(command.id,command.module).ok);
  else if (command.kind === 'repairFromWreck') assert(game.repairFromWreck(command.id).ok);
  else assert.equal(command.kind, 'new-attempt');
}

function replayToWaveThree(game, commands, record) {
  let cursor = 0;
  let input = {};
  const lastTick = commands.at(-1).tick;
  for (let tick = 0; tick <= lastTick; tick++) {
    if (game.phase === 'prep' && game.waveNumber === 3) return tick;
    while (cursor < commands.length && commands[cursor].tick === tick) {
      const command = commands[cursor++];
      record.push(command);
      if (command.kind === 'input') {
        assert.equal(command.dt, STEP);
        const {x,y,fire,aimX,aimY} = command;
        input = {x,y,fire,aimX,aimY};
      } else applyRecordedAction(game,command);
    }
    game.update(STEP,input);
  }
  throw new Error('Ordinary command trace did not reach preparation for wave 3');
}

function followRoute(game, route, step) {
  for (const [x,y] of route) {
    for (const [axis,coordinate] of [['x',x],['y',y]]) {
      const offset = coordinate - game.player[axis];
      const count = Math.round(Math.abs(offset) / (game._playerStats.speed * STEP));
      const input = {[axis]:Math.sign(offset)};
      for (let tick = 0; tick < count; tick++) step(input);
    }
    assert(Math.hypot(game.player.x - x,game.player.y - y) < .1, `Blocked waypoint ${x},${y}`);
  }
}

function ordinaryAim(game, ready) {
  const player = game.player;
  const target = game.enemies.find(enemy => ready(enemy) &&
    Math.hypot(enemy.x-player.x,enemy.y-player.y) <= game.playerWeaponRange + .35 &&
    game._firstCollision(player.x,player.y,enemy.x,enemy.y,player.id)?.object === enemy
  );
  return target ? {fire:true,aimX:target.x,aimY:target.y} : {};
}

function preserveHull(game, input, id) {
  if (!input.fire) return input;
  const player = game.player;
  const dx = input.aimX - player.x;
  const dy = input.aimY - player.y;
  const length = Math.hypot(dx,dy);
  const range = game.playerWeaponRange;
  const hit = game._firstCollision(player.x,player.y,player.x+dx*range/length,player.y+dy*range/length,player.id);
  return hit?.object.id === id ? {...input,fire:false} : input;
}

function writePreparation(game, output, sha256, mapId, tick) {
  const excluded = new Set(['config','_grid','_openField','_breachSearch','_shotFields','_traffic']);
  const state = Object.fromEntries(Object.entries(game).filter(([key]) => !excluded.has(key)));
  const snapshot = {
    label:'Ordinary attempt reached preparation 2; restoration is a separately labeled fixture',
    sha256,mapId,mode:'useful-hull-w1',tick,state
  };
  fs.writeFileSync(path.join(output,'prep-2.json'),JSON.stringify(snapshot,null,2) + '\n');
}

function main() {
  const [html,mapId,waveText,output,trace] = process.argv.slice(2);
  const wave = Number(waveText);
  assert(html && output && ['magnetic','city'].includes(mapId) && [1,3].includes(wave) && (wave === 1 || trace),
    'Usage: node tools/verify-map-learning.cjs <index.html> <magnetic|city> <1|3> <new-output-dir> [ordinary-commands.ndjson]');
  const {core,htmlSha256} = loadCore(html);
  const game = new core.Game(core.MAP_CONFIGS[mapId]);
  const record = [];
  let tick = 0;
  let source = null;
  if (wave === 3) {
    const bytes = fs.readFileSync(trace);
    const commands = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(commands[0].sha256,htmlSha256,'Source trace must match the measured HTML');
    assert.equal(commands[0].mapId,mapId);
    tick = replayToWaveThree(game,commands,record);
    source = {sha256:createHash('sha256').update(bytes).digest('hex'),divergedAtTick:tick};
  } else record.push({kind:'new-attempt',tick,mapId,sha256:htmlSha256});
  const step = input => {
    record.push({tick:tick++,kind:'input',dt:STEP,repeat:1,...input});
    game.update(STEP,input);
  };

  const route = wave === 1 ? WAVE_ONE_ROUTES[mapId] : mapId === 'city'
    ? [[11.8,game.player.y],[11.8,5],[15.2,5]]
    : [[game.player.x,12.2],[14,12.2],[14,8.6]];
  const oldWrecks = new Set(game.wrecks.map(wreck => wreck.id));
  followRoute(game,route,step);
  record.push({tick,kind:'startWave',wave});
  assert(game.startWave());
  policy.setup(game.config);
  const lane = wave === 1 ? 'A' : 'C';
  const area = game.config.TACTICS[lane].usefulAreas[0];
  const threshold = wave === 1 ? {magnetic:5.3,city:5.05}[mapId] : {magnetic:2.7,city:19.65}[mapId];
  const advancesToUseful = enemy => wave === 3 && mapId === 'city' ? enemy.x <= threshold : enemy.y >= threshold;
  let creation = null;
  let previous = null;
  for (let left = 2400; left > 0 && ['battle','settling'].includes(game.phase); left--) {
    const state = readState(game);
    const input = creation
      ? preserveHull(game,policy.decide(state,previous,null),creation.wreck.id)
      : ordinaryAim(game,enemy => enemy.type === 'light' || advancesToUseful(enemy));
    step(input);
    previous = state;
    const created = !creation && game.wrecks.find(wreck => !oldWrecks.has(wreck.id));
    if (!created) continue;
    const useful = created.x >= area.x && created.x <= area.x + area.w && created.y >= area.y && created.y <= area.y + area.h;
    creation = {tick,battleTick:Math.round(game._waveTime / STEP),wreck:{...created},useful,area,
      pending:game._spawnQueue.map(entry => ({...entry}))};
    if (wave === 3) break;
  }

  const nextPreparation = wave === 1 && game.phase === 'prep' && game.waveNumber === 2;
  const retained = nextPreparation && game.wrecks.some(wreck => wreck.id === creation?.wreck.id);
  const ok = creation?.useful && creation.pending.length > 0 && (wave === 3 || retained);
  const report = {
    schemaVersion:1, mode:'ordinary-commands', wave,mapId,htmlSha256,source,route,threshold,creation,
    result:{phase:game.phase,wave:game.waveNumber,baseHp:game.base.hp,playerHp:game.player.hp,
      wrecks:game.wrecks,stats:game.stats},
    ok:Boolean(ok)
  };
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output,'commands.ndjson'),record.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  fs.writeFileSync(path.join(output,'attempt.json'),game.exportAttemptLog());
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2) + '\n');
  if (nextPreparation) writePreparation(game,output,htmlSha256,mapId,tick);
  console.log(JSON.stringify(report));
  if (!ok) process.exitCode = 2;
}

if (require.main === module) main();
