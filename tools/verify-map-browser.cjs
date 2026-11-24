'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: wait} = require('node:timers/promises');

// Real Chrome input, HTTP download and isolated offline verification of both maps.
const [htmlArgument, outputArgument, preparationRoot, extra] = process.argv.slice(2);
if (!htmlArgument || !outputArgument || extra !== undefined) {
  console.error('Usage: node tools/verify-map-browser.cjs <index.html> <new output directory> [campaigns-root]');
  process.exit(1);
}
const html = path.resolve(htmlArgument);
const output = path.resolve(outputArgument);
const buildBytes = fs.readFileSync(html);
if (fs.existsSync(output)) throw new Error('Choose a new output directory');
fs.mkdirSync(output, {recursive: true});
const server = require('node:http').createServer((request, response) => {
  if(request.url !== '/index.html') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(buildBytes);
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-two-maps-browser-'));
const chromeArgs = [
  '--user-data-dir=' + profile, '--remote-debugging-pipe', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
  '--disable-component-update', '--disable-domain-reliability', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--headless=new', '--window-size=1366,900', 'about:blank'
];
const chrome = spawn('google-chrome', chromeArgs, {stdio: ['ignore','ignore','inherit','pipe','pipe']});
let buffer = '';
let requestId = 0;
let sessionId;
const pending = new Map();
const alerts = [];
let chromeError;
let chromeExited = false;
chrome.stdio[4].setEncoding('utf8');
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  let separator;
  while ((separator = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, separator));
    buffer = buffer.slice(separator + 1);
    const job = pending.get(message.id);
    if (job) {
      pending.delete(message.id);
      if (message.error) job.reject(new Error(JSON.stringify(message.error)));
      else job.resolve(message.result);
    }
    if (/^(Runtime.exceptionThrown|Log.entryAdded|Network.requestWillBeSent|Browser.download)/.test(message.method ?? '')) {
      alerts.push({method: message.method, ...message.params});
    }
  }
});
function rejectPending(error) { for (const job of pending.values()) job.reject(error); }
chrome.on('error', error => {
  chromeError = error;
  rejectPending(error);
});
chrome.on('exit', (code, signal) => {
  chromeExited = true;
  chromeError = new Error(`Chrome exited (${signal ?? code})`);
  rejectPending(chromeError);
});
chrome.stdio[3].on('error', rejectPending);
function cdp(method, params = {}, session) {
  if (chromeError) return Promise.reject(chromeError);
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, {resolve, reject});
    chrome.stdio[3].write(JSON.stringify({id, method, params, sessionId: session}) + '\0');
  });
}
const page = (method, params) => cdp(method, params, sessionId);
function unwrap(response) {
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result;
}
const evaluate = async expression => unwrap(await page('Runtime.evaluate', {expression, returnByValue: true})).value;
async function eventually(check, timeout = 15000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await wait(20);
  } while (performance.now() < deadline);
  throw new Error('Condition timed out: ' + String(check).slice(0, 180));
}
async function click(selector){
  const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const [type, buttons] of [['mousePressed',1],['mouseReleased',0]]) await page('Input.dispatchMouseEvent',{ ...rect,type,button:'left',buttons,clickCount:1 });
}
const read = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
async function screenshot(name){
  const result=await page('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,name+'.png'), Buffer.from(result.data,'base64'));
}
async function exportLog(label, mapId, selector = '#export-attempt') {
  await click(selector);
  const version=await evaluate(`TankCore.MAP_CONFIGS[${JSON.stringify(mapId)}].mapVersion`);
  const filename=path.join(output,`tanks-${mapId}-v${version}-attempt.json`);
  await eventually(()=>fs.existsSync(filename));
  const log=JSON.parse(fs.readFileSync(filename,'utf8'));
  fs.renameSync(filename,path.join(output,label+'.json'));
  return log;
}
async function key(code, key, frames) {
  await page('Input.dispatchKeyEvent',{type:'keyDown',code,key,windowsVirtualKeyCode:code==='KeyW'?87:13});
  // Hold the key across game frames even when Chrome is busy drawing the board.
  await page('Runtime.evaluate', {
    expression:`new Promise(resolve => {
      let remaining = ${frames};
      function next() {
        if (--remaining === 0) resolve();
        else requestAnimationFrame(next);
      }
      requestAnimationFrame(next);
    })`,
    awaitPromise:true
  });
  await page('Input.dispatchKeyEvent',{type:'keyUp',code,key,windowsVirtualKeyCode:code==='KeyW'?87:13});
}
function fixtureHtml(factory, argument) {
  const entry='let game = new Game(MAP_CONFIGS.magnetic);';
  const startup='configureMapView();\n  initializeMap();\n  requestAnimationFrame(frame);';
  assert.equal(buildBytes.toString().split(entry).length,2);
  assert.equal(buildBytes.toString().split(startup).length,2);
  return buildBytes.toString().replace(entry,`let game = (${factory})(globalThis.TankCore,${JSON.stringify(argument)});`)
    .replace(startup,'configureMapView();\n  requestAnimationFrame(frame);');
}
function warningFixture(core, mapId) {
  const config=core.MAP_CONFIGS[mapId], spawn=config.SPAWNS.B;
  const game=new core.Game({...config,controlScene:{diagnostic:true,kind:'blocked-spawn-ui'},
    WALLS:[...config.WALLS,{x:spawn.x-.75,y:spawn.y-.75,w:1.5,h:1.5}],
    WAVES:[[{start:0,lane:'C',types:['medium']},{start:4,lane:'B',types:['light']}]]});
  const update=game.update; let removed=false;
  game.update=function(dt,input) {
    if(!removed&&this._waveTime>=7){this.config.WALLS.pop();removed=true;}
    return update.call(this,dt,input);
  };
  return game;
}
function preparationFixture(core, snapshot) {
  const game=new core.Game(core.MAP_CONFIGS[snapshot.mapId]);
  Object.assign(game,snapshot.state);game._invalidateNavigation();
  game._attemptConfiguration.game.controlScene={diagnostic:true,kind:'ordinary-preparation-replay'};
  game._recordAttempt('control_scene',{diagnostic:true,kind:'ordinary-preparation-replay'});
  return game;
}
async function navigateFixture(name, text) {
  const filename=path.join(output,name+'.html');fs.writeFileSync(filename,text);
  await page('Page.navigate',{url:pathToFileURL(filename).href});
  await eventually(()=>evaluate('!!document.querySelector("#map-name")?.textContent && !document.querySelector("#map-dialog").open'));
}
async function checkFixtures() {
  const createScene=require('./playtest-scene.cjs');
  for(const mapId of ['magnetic','city']) {
    for(const kind of ['placement','death']) {
      const name=`diagnostic-${mapId}-${kind}`;
      await navigateFixture(name,createScene.renderSceneHtml(buildBytes.toString(),kind,mapId));
      const selector=kind==='death'?'#modal-actions button:nth-child(2)':'#export-attempt';
      const log=await exportLog(name,mapId,selector);
      assert.equal(log.configuration.game.controlScene.kind,kind);
      assert.equal(log.current.player.hp,kind==='death'?20:60);
      assert.match(await read('#wave-max'),/02/);
      if(kind==='death')assert.equal(await read('#modal-title'),'Пауза');
      await screenshot(name);
    }
    const warningName=`diagnostic-${mapId}-warning`;
    await navigateFixture(warningName,fixtureHtml(warningFixture,mapId));
    const plan = await eventually(() => read('#wave-plan'));
    assert.match(plan,/C/);assert.match(plan,/B/);
    await click('#start');
    await eventually(async()=>/Вход B/.test(await read('#entry-status')));
    const countdown=await read('#entry-status');assert.doesNotMatch(countdown,/ожидает/);
    await screenshot(warningName+'-countdown');
    await eventually(async()=>/ожидает/.test(await read('#entry-status')));
    const waiting=await read('#entry-status');assert.doesNotMatch(waiting,/-\d/);
    await screenshot(warningName+'-waiting');
    await eventually(async()=>(await read('#entry-status'))==='');
    fs.writeFileSync(path.join(output,warningName+'.json'),JSON.stringify({diagnostic:true,countdown,waiting,afterActualRelease:''},null,2));
    if(!preparationRoot)continue;
    const snapshot=JSON.parse(fs.readFileSync(path.join(preparationRoot,`${mapId}-engine`,'prep-2.json'),'utf8'));
    assert.equal(snapshot.sha256,createHash('sha256').update(buildBytes).digest('hex'));
    const name=`diagnostic-${mapId}-preparation`;
    await navigateFixture(name,fixtureHtml(preparationFixture,snapshot));
    const wreck=snapshot.state.wrecks.find(item=>item.type==='medium');assert.ok(wreck);
    await evaluate('document.querySelector("#board").scrollIntoView({block:"center"})');
    const rect=await evaluate('(()=>{const r=document.querySelector("#board").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()');
    const config=snapshot.state._attemptConfiguration.game;
    const point={x:rect.x+wreck.x/config.W*rect.w,y:rect.y+wreck.y/config.H*rect.h};
    for(const [type,buttons] of [['mousePressed',1],['mouseReleased',0]])await page('Input.dispatchMouseEvent',{...point,type,button:'left',buttons,clickCount:1});
    await eventually(()=>evaluate('!document.querySelector("#install-barrel").disabled'));
    await click('#install-barrel');
    const installed=await exportLog(name+'-barrel',mapId);assert.equal(installed.current.player.module,'barrel');
    assert.equal(installed.current.wrecks.length,snapshot.state.wrecks.length-1);
    await click('#undo');
    const undone=await exportLog(name+'-undo',mapId);assert.equal(undone.current.player.module,snapshot.state.player.module);
    assert.equal(undone.current.wrecks.length,snapshot.state.wrecks.length);
    await screenshot(name+'-undo');
  }
}
(async()=>{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const {targetInfos}=await cdp('Target.getTargets');
  const pageTarget=targetInfos.find(target=>target.type==='page');
  ({sessionId}=await cdp('Target.attachToTarget',{targetId:pageTarget.targetId,flatten:true}));
  for(const domain of ['Page','Runtime','Network','Log'])await page(domain+'.enable');
  await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output,eventsEnabled:true});
  await page('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
  await eventually(()=>evaluate(`document.querySelector('#map-dialog')?.open &&
    ['magnetic','city'].every(id => document.querySelector('button[data-map-id="'+id+'"] canvas'))`));
  await screenshot('picker');
  for (const mapId of ['magnetic','city']) {
    if(mapId==='city')await click('#maps');
    await click(`button[data-map-id="${mapId}"]`);
    await eventually(()=>evaluate('!document.querySelector("#map-dialog").open'));
    assert.equal(await read('#phase-badge'),'ПОДГОТОВКА');
    assert.match(await read('#base-value'),/240/);
    assert.match(await read('#player-module'),/нет/);
    assert.equal(await read('#wave-value'),'01');
    assert.match(await read('#wave-plan'),/A/);
    await screenshot(mapId);
    const before=await exportLog(mapId+'-fresh',mapId);
    assert.equal(before.configuration.game.mapId,mapId);
    assert.equal(before.current.stats.kills,0);
    assert.equal(before.current.wrecks.length,0);
    assert.deepEqual(before.events.map(event=>event.type),['attempt_start']);
    await click('#campaign');
    assert.equal(await evaluate('document.querySelectorAll(".campaign-wave").length'),8);
    await screenshot(mapId+'-campaign');
    await click('#campaign-dialog button');
    await eventually(()=>evaluate('!document.querySelector("#campaign-dialog").open'));
    await key('KeyW','w',12);
    const moved=await exportLog(mapId+'-movement',mapId);
    assert.ok(moved.current.player.y < before.current.player.y-.1,'Real keyboard input moves the tank');
    await click('#board'); // Enter on the focused export button activates that button instead.
    await key('Enter','Enter',2);
    await eventually(()=>evaluate('document.querySelector("#phase-badge").textContent==="БОЙ"'));
    const point=await evaluate('(()=>{const r=document.querySelector("#board").getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.5};})()');
    await page('Input.dispatchMouseEvent',{...point,type:'mousePressed',button:'left',buttons:1,clickCount:1});
    await wait(400);
    await page('Input.dispatchMouseEvent',{...point,type:'mouseReleased',button:'left',buttons:0,clickCount:1});
    const fired=await exportLog(mapId+'-combat',mapId);
    assert.ok(fired.current.stats.shots>0,'Real mouse input fires');
    await click('#help'); assert.equal(await read('#modal-title'),'Как играть');
    await click('#modal-actions button');
  }
  await click('#download');
  const downloaded=path.join(output,'tank-prototype.html');
  await eventually(()=>fs.existsSync(downloaded));
  assert.deepEqual(fs.readFileSync(downloaded),buildBytes,'HTTP download preserves exact source bytes');
  await new Promise(resolve=>server.close(resolve));
  const offlineStart=alerts.length;
  await page('Page.navigate',{url:pathToFileURL(downloaded).href});
  await eventually(()=>evaluate('!!document.querySelector("#map-dialog")?.open'));
  for(const mapId of ['magnetic','city']) {
    if(mapId==='city')await click('#maps');
    await click(`button[data-map-id="${mapId}"]`);
    await eventually(()=>evaluate('!document.querySelector("#map-dialog").open'));
    await click('#start');
    await eventually(()=>evaluate('document.querySelector("#phase-badge").textContent==="БОЙ"'));
    assert.equal((await exportLog('offline-'+mapId,mapId)).configuration.game.mapId,mapId);
  }
  const remote=alerts.slice(offlineStart).filter(event=>event.method==='Network.requestWillBeSent'&&/^https?:/.test(event.request.url));
  assert.deepEqual(remote,[],'Downloaded file must need no server or external assets');
  await checkFixtures();
  assert.deepEqual(alerts.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify({
    htmlSha256:createHash('sha256').update(buildBytes).digest('hex'),
    checks:['two selectors and miniatures','eight-wave overview','real keyboard movement and Enter','real mouse fire','map-reset resources and log','help','exact HTTP download','both maps offline with stopped server','labelled placement and death comparison scenes','labelled countdown, blocked spawn, actual release',...(preparationRoot?['ordinary preparation replay: barrel selection and undo']:[])],
    javascriptExceptions:0,offlineHttpRequests:0
  },null,2));
  console.log('Chrome: both maps, real input, fresh attempts, exact download and offline launch passed');
})().catch(async error=>{
  console.error(error);process.exitCode=1;
  try {
    await screenshot('failure');
    const state=await evaluate('({url:location.href,title:document.title,text:document.body?.innerText})');
    fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({state,alerts},null,2));
  } catch(diagnosticError) { console.error(diagnosticError); }
}).finally(()=>{server.close();chrome.kill();});
