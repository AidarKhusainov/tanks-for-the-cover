'use strict';
// Deterministic ordinary-input acceptance driver. Never assigns simulation state.
// Engine mode proves the campaign without the barrel; it is not a human playtest.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const policy=require('./maps-campaign-policy.cjs');
const [html,mapId,mode,output]=process.argv.slice(2);
if(!html||!mapId||!['barrel','engine'].includes(mode)||!output)throw Error('Usage: node tools/verify-maps-campaign.cjs <html> <magnetic|city> <barrel|engine> <new-output-directory>');
if(fs.existsSync(output))throw Error('Choose new output directory');
const bytes=fs.readFileSync(html),scripts=[...bytes.toString().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
const ctx=vm.createContext({});vm.runInContext(scripts[0],ctx);vm.runInContext(scripts[1],ctx);
const config=ctx.TankCore.MAP_CONFIGS?.[mapId];if(!config)throw Error('Map not implemented');
const game=new ctx.TankCore.Game(config);policy.setup(config);fs.mkdirSync(output,{recursive:true});
const commandFile=fs.openSync(path.join(output,'commands.ndjson'),'w');
const observationFile=fs.openSync(path.join(output,'observations.ndjson'),'w');
const note=x=>process.stdout.write(JSON.stringify(x)+'\n');
const record=x=>fs.writeSync(commandFile,JSON.stringify({tick:ticks,...x})+'\n');
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const step=1/60;let ticks=0,previous=null,prepared=0,preparationTicks=0,preparedGoal=null,input={},nextDecision=0,maxStep=0,totalMs=0;
const cityExit=[{x:0,y:-1,ticks:60},{x:-1,y:0,ticks:60},{x:0,y:1,ticks:60},{x:-1,y:0,ticks:36},{x:0,y:-1,ticks:54}];
let escapeStage=config.mapId==='city'&&config.PLAYER_START.x>6?0:cityExit.length,escapeTicks=0;
const state=()=>({phase:game.phase,wave:game.waveNumber,player:{...game.player},baseHp:game.base.hp,enemies:game.enemies.map(e=>({...e})),wrecks:game.wrecks.map(w=>({...w})),bullets:game.bullets.map(b=>({...b})),queue:game._spawnQueue.map(q=>({...q})),battleSeconds:game.stats.time});
const orders=mapId==='magnetic'?['A','A','C','C','B','A','B','A']:['A','A','C','C','C','C','B','C'];
note({kind:'input-build',sha256,mapId,mode,diagnostic:false,source:'ordinary Game input and public preparation methods; no state assignment'});
record({kind:'new-attempt',mapId,sha256});
while(!['won','lost'].includes(game.phase)&&ticks<36000){
 let s=state();
 if(s.player.alive&&previous?.player.alive===false&&config.mapId==='city'&&config.PLAYER_START.x>6){escapeStage=0;escapeTicks=0;nextDecision=0;}
 if(s.phase==='prep'&&prepared!==s.wave){
  prepared=s.wave;preparationTicks=0;
  const snapshot={};for(const key of Object.keys(game)){if(['config','_grid','_openField','_breachSearch','_shotFields','_traffic'].includes(key))continue;snapshot[key]=game[key];}
  fs.writeFileSync(path.join(output,`prep-${s.wave}.json`),JSON.stringify({label:'ordinary attempt snapshot before preparation spending; replay fixture only when restored',sha256,mapId,mode,tick:ticks,state:snapshot},null,2));
  for(const w of [...game.wrecks].sort((a,b)=>a.expiresAfterWave-b.expiresAfterWave)){
   if(w.type==='medium'&&!game.player.module){const ok=game.installModuleFromWreck(w.id,mode);record({kind:'installModuleFromWreck',wave:s.wave,id:w.id,module:mode,ok});}
   else if(game.base.maxHp-game.base.hp>=10){const ok=game.repairFromWreck(w.id);record({kind:'repairFromWreck',wave:s.wave,id:w.id,ok});}
  }
  preparedGoal=config.TACTICS?.[orders[s.wave-1]]?.position??config.TACTICAL?.positions?.[orders[s.wave-1]]??{x:game.base.x,y:game.base.y-3};
  nextDecision=0;
 }
 if(s.phase==='prep'){
  preparationTicks++;
  if(policy.dist(game.player,preparedGoal)<.45||preparationTicks>=1800){
   note({kind:'preparation',wave:s.wave,baseHp:game.base.hp,module:game.player.module,player:{x:game.player.x,y:game.player.y},goal:preparedGoal,ticks:preparationTicks});
   const ok=game.startWave();record({kind:'startWave',tick:ticks,wave:s.wave,ok});nextDecision=0;continue;
  }
 }
 if(ticks>=nextDecision){
  input=game.player.alive?(escapeStage<cityExit.length?{x:cityExit[escapeStage].x,y:cityExit[escapeStage].y}:policy.decide(s,previous,s.phase==='prep'?preparedGoal:null)):{};
  nextDecision=ticks+3;
  record({kind:'input',tick:ticks,dt:step,repeat:3,...input});
 }
 if(ticks%30===0)fs.writeSync(observationFile,JSON.stringify({tick:ticks,phase:s.phase,wave:s.wave,player:s.player,baseHp:s.baseHp,enemies:s.enemies.map(({id,x,y,type,hp})=>({id,x,y,type,hp})),wrecks:s.wrecks})+'\n');
 const before=performance.now();game.update(step,input);const duration=performance.now()-before;maxStep=Math.max(maxStep,duration);totalMs+=duration;
 previous=s;ticks++;
 if(game.player.alive&&escapeStage<cityExit.length&&++escapeTicks>=cityExit[escapeStage].ticks){escapeStage++;escapeTicks=0;nextDecision=0;}
 if(game._waveTime>150)break;
 if(ticks%1800===0)note({kind:'progress',tick:ticks,phase:game.phase,wave:game.waveNumber,kills:game.stats.kills,baseHp:game.base.hp});
}
fs.writeFileSync(path.join(output,'terminal-state.json'),JSON.stringify({player:game.player,base:game.base,enemies:game.enemies,wrecks:game.wrecks,bullets:game.bullets,queue:game._spawnQueue,phase:game.phase,wave:game.waveNumber},null,2));
const journal=game.exportAttemptLog();fs.writeFileSync(path.join(output,'attempt.json'),journal);
const result={kind:'terminal',mapId,mode,phase:game.phase,wave:game.waveNumber,baseHp:game.base.hp,player:game.player,stats:game.stats,ticks,maxStepMs:maxStep,meanStepMs:totalMs/ticks,sha256};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));fs.closeSync(commandFile);fs.closeSync(observationFile);note(result);
if(game.phase!=='won'||game.stats.kills!==66)process.exitCode=2;
