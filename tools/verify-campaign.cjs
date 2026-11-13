'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: wait} = require('node:timers/promises');

// Usage: node tools/verify-campaign.cjs index.html /tmp/tanks-campaign-run [east|west5]
const [htmlArgument, outputArgument, tactic = 'east', extra] = process.argv.slice(2);
if (!htmlArgument || !outputArgument || extra !== undefined || !['east', 'west5'].includes(tactic)) {
  console.error('Usage: node tools/verify-campaign.cjs <index.html> <new output directory> [east|west5]');
  process.exit(1);
}
const html = path.resolve(htmlArgument);
const output = path.resolve(outputArgument);
const buildBytes = fs.readFileSync(html);
if (fs.existsSync(output)) throw new Error('Choose a new output directory');
fs.mkdirSync(output, {recursive: true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-13-campaign-'));
const chromeArgs = [
  '--user-data-dir=' + profile, '--remote-debugging-pipe', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
  '--disable-component-update', '--disable-domain-reliability', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--headless=new', '--window-size=1366,900', 'about:blank'
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
async function eventually(check, timeout = 5000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await wait(20);
  } while (performance.now() < deadline);
  throw new Error('Condition timed out: ' + String(check).slice(0, 180));
}
function note(name, data) { process.stdout.write(JSON.stringify({name, ...data}) + '\n'); }
let gameObjectId;
let board;
let lastPoint;
let lastState;
const startedAt = performance.now();
// Trace every dispatched key and pointer event, including the final download click.
const recordInput = fs.openSync(path.join(output, 'input.ndjson'), 'w');
const recordState = fs.openSync(path.join(output, 'observations.ndjson'), 'w');
function traceInput(method, params) {
  fs.writeSync(recordInput, JSON.stringify({ms: performance.now() - startedAt, wave: lastState?.wave,
    battleSeconds: lastState?.battleSeconds, method, params}) + '\n');
  return page(method, params);
}
const mapPoint = (x, y) => ({x: board.x + x * board.width / 28, y: board.y + y * board.height / 18});
const mouse = (type, point, buttons) => traceInput('Input.dispatchMouseEvent', {
  type, ...point, buttons, ...(type === 'mouseMoved' ? {} : {button: 'left', clickCount: 1})
});
async function click(point) {
  await mouse('mouseMoved', point, 0);
  await mouse('mousePressed', point, 1);
  await wait(38);
  await mouse('mouseReleased', point, 0);
}
async function button(selector) {
  const center = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.getClientRects().length) throw Error('Button unavailable');
    const {x, y, width, height} = el.getBoundingClientRect();
    return {x: x + width / 2, y: y + height / 2};
  })()`);
  await click(center);
}
const keys = {a: ['a','KeyA',65], d: ['d','KeyD',68], w: ['w','KeyW',87], s: ['s','KeyS',83], Enter: ['Enter','Enter',13]};
function key(type, name) {
  const [label, code, virtual] = keys[name];
  return traceInput('Input.dispatchKeyEvent', {type, key: label, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual});
}
let held = [];
async function move(next) {
  for (const name of held.filter(name => !next.includes(name))) await key('keyUp', name);
  for (const name of next.filter(name => !held.includes(name))) await key('rawKeyDown', name);
  held = next;
}
async function screenshot(name) {
  const {data} = await page('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
}
let heldFire = false;
async function fire(aim) {
  if (!aim) {
    if (heldFire) await mouse('mouseReleased', lastPoint, 0);
    heldFire = false;
    return;
  }
  const point = mapPoint(aim.x, aim.y);
  await mouse('mouseMoved', point, heldFire ? 1 : 0);
  if (!heldFire) await mouse('mousePressed', point, 1);
  heldFire = true;
  lastPoint = point;
}

// Resolve the existing instance in the browser heap. No application code is injected.
async function locateGame() {
  const objectGroup = 'campaign-observe';
  const prototype = unwrap(await page('Runtime.evaluate', {expression: 'globalThis.TankCore.Game.prototype', objectGroup}));
  const {objects} = await page('Runtime.queryObjects', {prototypeObjectId: prototype.objectId, objectGroup});
  const [entry] = (await page('Runtime.getProperties', {objectId: objects.objectId, ownProperties: true})).result;
  assert.equal(entry.name, '0');
  return entry.value.objectId;
}
// Copy observations from the page. Movement, aim, and preparation actions are sent as normal input.
async function readState() {
  const functionDeclaration = function () {
    const {phase, player, base, enemies, wrecks, bullets, stats, _spawnQueue, config} = this;
    return {
      phase, wave: this.waveNumber, paused: this.paused, player: {...player}, baseHp: base.hp,
      enemies: enemies.map(({id, x, y, type, lane, hp, r, cooldown, stationaryTarget, route, routeIndex}) =>
        ({id, x, y, type, lane, hp, r, cooldown, stationaryTarget, next: route[routeIndex]})),
      wrecks, bullets, stats, queue: _spawnQueue, waveTime: this._waveTime,
      battleSeconds: stats.time, preparationSeconds: this._preparationSeconds,
      schedule: config.WAVES[this.waveIndex]
    };
  }.toString();
  return unwrap(await page('Runtime.callFunctionOn', {objectId: gameObjectId, functionDeclaration,
    returnByValue: true})).value;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
let walls, spawns, specs;
function closestRect(p, rect) {
  return {x: clamp(p.x, rect.x, rect.x + rect.w), y: clamp(p.y, rect.y, rect.y + rect.h)};
}
function circleIntersection(a, b, p, r) {
  const x = a.x - p.x, y = a.y - p.y, dx = b.x - a.x, dy = b.y - a.y;
  const c = x*x + y*y - r*r;
  if (c <= 0) return 0;
  const aa = dx*dx + dy*dy;
  if (aa < 1e-10) return Infinity;
  const bb = x*dx + y*dy;
  const delta = bb*bb - aa*c;
  if (delta < 0) return Infinity;
  const t = (-bb - Math.sqrt(delta)) / aa;
  return t >= 0 && t <= 1 ? t : Infinity;
}
function rectIntersection(a, b, rect) {
  let lo = 0, hi = 1;
  for (const [axis, size] of [['x','w'],['y','h']]) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < rect[axis] || a[axis] > rect[axis]+rect[size]) return Infinity;
      continue;
    }
    const enter = (rect[axis] - a[axis]) / delta;
    const exit = (rect[axis]+rect[size] - a[axis]) / delta;
    lo = Math.max(lo, Math.min(enter, exit));
    hi = Math.min(hi, Math.max(enter, exit));
    if (hi < lo) return Infinity;
  }
  return lo;
}
function firstBlock(a, b, actors, skip) {
  let first = Infinity;
  for (const wall of walls) first = Math.min(first, rectIntersection(a, b, wall));
  for (const actor of actors) {
    if (actor.id === skip) continue;
    first = Math.min(first, circleIntersection(a, b, actor, actor.r));
  }
  return first;
}
function positionFree(p, actors, radius = .5) {
  if (p.x < radius || p.y < radius || p.x > 28-radius || p.y > 18-radius) return false;
  for (const rect of [...walls, ...spawns]) {
    const q = closestRect(p, rect);
    if ((p.x-q.x)**2+(p.y-q.y)**2 < radius*radius-1e-7) return false;
  }
  for (const a of actors) if ((p.x-a.x)**2+(p.y-a.y)**2 < (radius+a.r)**2-1e-7) return false;
  return true;
}
function predict(p, vx, vy, seconds, actors) {
  const out = {x: p.x, y: p.y};
  const steps = Math.ceil(seconds/.05);
  for (let i=0; i<steps; i++) {
    const x = out.x + vx*seconds/steps;
    if (positionFree({x, y: out.y}, actors)) out.x = x;
    const y = out.y + vy*seconds/steps;
    if (positionFree({x: out.x, y}, actors)) out.y = y;
  }
  return out;
}
function shotAt(p, e, actors, maxDistance = 6.38, margin = .018) {
  const distance = dist(p, e);
  if (distance > maxDistance || distance < .1) return null;
  const angle = Math.atan2(e.y-p.y, e.x-p.x);
  for (const offset of [0, -.23, .23, -.36, .36]) {
    const adjust = Math.atan2(offset,distance);
    const end = {x:p.x+Math.cos(angle+adjust)*6,y:p.y+Math.sin(angle+adjust)*6};
    const impact = circleIntersection(p,end,e,e.r-margin);
    if (impact === Infinity) continue;
    if (firstBlock(p, end, actors, e.id) > impact + margin/6) {
      return {x:p.x+Math.cos(angle+adjust)*distance,y:p.y+Math.sin(angle+adjust)*distance};
    }
  }
  return null;
}
const validTarget = (p, e, actors, maxDistance) => !!shotAt(p,e,actors,maxDistance);

const base = {x:14, y:13.5};
function targetValue(p, e) {
  const vulnerability = Math.max(0, 8 - dist(e, base));
  const threatensBase = e.stationaryTarget === 'base';
  const heavy = e.type === 'heavy';
  const urgency = (threatensBase ? 7 : 0) + vulnerability * .75 + (heavy ? 1.25 : 0);
  const quick = e.hp <= 20 ? 2.2 : e.hp <= 40 ? 1.2 : 0;
  return urgency + quick - dist(p, e) * .17;
}
function target(p, s, actors, previous) {
  let best = null;
  let value = -Infinity;
  for (const e of s.enemies) {
    const old = previous?.enemies.find(item => item.id === e.id);
    const elapsed = s.battleSeconds - (previous?.battleSeconds ?? s.battleSeconds);
    const aim = {...e};
    if (old && elapsed > .002 && elapsed < .1) {
      const lead = dist(p, e) / 40 + .018;
      aim.x += clamp((e.x-old.x)/elapsed, -specs[e.type].speed, specs[e.type].speed) * lead;
      aim.y += clamp((e.y-old.y)/elapsed, -specs[e.type].speed, specs[e.type].speed) * lead;
      if (!validTarget(p, aim, actors, 6.38)) Object.assign(aim, e);
    }
    const shot = shotAt(p,aim,actors);
    if (!shot) continue;
    const score = targetValue(p,e);
    if (score > value) { best = {...aim,...shot}; value = score; }
  }
  return best;
}

const spacing = .35;
const grid = [];
const columns = 79;
const rows = 50;
for (let j=0; j<rows; j++) {
  for (let i=0; i<columns; i++) grid.push({x: .55+i*spacing, y: .55+j*spacing});
}
const steps = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
// Search the reachable grid for a firing position or preparation waypoint.
function plan(s, actors, destination) {
  const p = s.player;
  const accessible = grid.map(point => positionFree(point, actors, .53));
  const cost = new Float64Array(grid.length).fill(Infinity);
  const paths = new Int32Array(grid.length).fill(-1);
  const queue = [];
  const push = (id, length, parent) => {
    if (length + .001 >= cost[id]) return;
    cost[id] = length;
    paths[id] = parent;
    let index = queue.length;
    queue.push({id, length});
    while (index > 0) {
      const up = (index-1)>>1;
      if (queue[up].length <= length) break;
      [queue[up], queue[index]] = [queue[index], queue[up]];
      index = up;
    }
  };
  const pop = () => {
    const first = queue[0], end = queue.pop();
    if (!queue.length) return first;
    queue[0] = end;
    let i=0;
    while (i*2+1 < queue.length) {
      let low = i*2+1;
      if (low+1 < queue.length && queue[low+1].length < queue[low].length) low++;
      if (queue[low].length >= queue[i].length) break;
      [queue[i], queue[low]] = [queue[low], queue[i]];
      i = low;
    }
    return first;
  };
  function clearLine(a, b) {
    const length = dist(a,b);
    const checks = Math.ceil(length/.19);
    for (let i = 1; i <= checks; i++) {
      const t = i / checks;
      if (!positionFree({x: a.x+(b.x-a.x)*t, y: a.y+(b.y-a.y)*t}, actors, .5)) return false;
    }
    return true;
  }
  const closestX = clamp(Math.round((p.x-.55)/spacing),0,columns-1);
  const closestY = clamp(Math.round((p.y-.55)/spacing),0,rows-1);
  for(let j = Math.max(0, closestY-2); j<=Math.min(rows-1,closestY+2); j++) {
    for(let i = Math.max(0, closestX-2); i<=Math.min(columns-1,closestX+2); i++) {
      const id = j*columns+i;
      if(accessible[id] && clearLine(p,grid[id])) push(id, dist(p,grid[id]), -1);
    }
  }

  const opponents = s.enemies;
  const goalLane = s.queue[0]?.lane;
  const queuePost = goalLane ? { A:{x:9.8,y:8.7}, B:{x:18.9,y:6.7}, C:{x:21,y:9.7} }[goalLane] : base;
  let best = -1, bestValue = Infinity, bestEnemy;
  function evaluateGoal(point, length) {
    if (destination || !opponents.length) return [length + dist(point,destination ?? queuePost)*4, null];
    let value = Infinity, enemy;
    for (const e of opponents) {
      const distance = dist(e,point);
      if (!shotAt(point,e,actors,6.20,.065)) continue;
      let incoming = 0;
      for (const other of opponents) {
        if (other.id !== e.id && validTarget(point,other,actors,specs[other.type].range+.5)) incoming += .6;
      }
      const distanceCost = distance < 3.8 ? (3.8-distance)*.40 : (distance-3.8)*.07;
      const closeness = dist(p,point);
      const doorstep = closeness < .19 ? (.19-closeness)*15 : 0;
      const score = length + distanceCost + incoming + doorstep - targetValue(point,e)*.40;
      if (score < value) { value = score; enemy = e; }
    }
    return [value, enemy];
  }
  let fallback = -1, fallbackValue = Infinity;
  while (queue.length) {
    const {id, length} = pop();
    if (length > cost[id]+.001) continue;
    const point = grid[id];
    const [value, enemy] = evaluateGoal(point,length);
    if (value < bestValue) { best = id; bestValue = value; bestEnemy = enemy; }
    if (opponents.length) {
      const fallbackScore = Math.min(...opponents.map(e => dist(point,e))) + .3*length;
      if (fallbackScore < fallbackValue) { fallback = id; fallbackValue = fallbackScore; }
    }
    if (length > bestValue + (destination ? .3 : 5.5)) break;
    const i = id % columns, j = Math.floor(id/columns);
    for (const [dx,dy] of steps) {
      const x = i+dx, y = j+dy;
      if (x<0 || y<0 || x>=columns || y>=rows) continue;
      const next = y*columns+x;
      if (!accessible[next]) continue;
      if (dx && dy && (!accessible[j*columns+x] || !accessible[y*columns+i])) continue;
      const mid = {x:(point.x+grid[next].x)/2, y:(point.y+grid[next].y)/2};
      if (!positionFree(mid,actors,.51)) continue;
      push(next,length+spacing*Math.hypot(dx,dy),id);
    }
  }
  if (best < 0) best = fallback;
  if (best < 0) return {point: p, goal: p};
  const goal = grid[best];
  const route = [];
  for(let current=best; current>=0; current=paths[current]) route.push(grid[current]);
  const point = route.find(node => clearLine(p,node)) ?? route.at(-1);
  return {point, goal, enemy: bestEnemy?.id};
}

function direction(s, waypoint, aim, actors) {
  const p = s.player;
  const speed = p.module === 'engine' ? 5 : 4;
  const risky = s.bullets.filter(b => b.team === 'enemy' && dist(b,p) < b.remaining + 2.5);
  const bullets = risky.map(b => {
    const endpoint = {x:b.x+b.dx*b.remaining, y:b.y+b.dy*b.remaining};
    const collide = firstBlock(b,endpoint,actors,b.ownerId);
    return {...b, time: Math.min(collide,1)*b.remaining/b.speed};
  });
  let bestMove = [];
  let bestScore = Infinity;
  const options = [[0,0],...steps];
  for (let i=0; i<options.length; i++) {
    const [x,y] = options[i];
    const length = Math.max(1, Math.hypot(x,y));
    const vx = x*speed/length, vy = y*speed/length;
    const horizon = clamp(dist(p,waypoint)/speed,.018,.14);
    const end = predict(p,vx,vy,horizon,actors);
    const avx = (end.x-p.x)/horizon, avy = (end.y-p.y)/horizon;
    let score = dist(end,waypoint) + i*.0005 + (i ? .005 : 0);
    if (aim) {
      const effective = dist(end,aim);
      if (effective > 6.4) score += 1.0;
      if (!validTarget(end,aim,actors,6.42)) score += .45;
    }
    for (const b of bullets) {
      const rx = b.x-p.x, ry = b.y-p.y;
      const dx = b.dx*b.speed-avx, dy = b.dy*b.speed-avy;
      const time = clamp(-(rx*dx+ry*dy)/(dx*dx+dy*dy), 0, Math.min(b.time,.49));
      if (time <= 0) continue;
      const gap = Math.hypot(rx+dx*time, ry+dy*time);
      if (gap < .63) score += (b.damage/6)*(1.3-time)*(1.05-gap);
    }
    if (score < bestScore) {
      bestScore = score;
      bestMove = [x===1?'d':x===-1?'a':null,y===1?'s':y===-1?'w':null].filter(Boolean);
    }
  }
  return bestMove;
}

async function prepare(s) {
  await fire(null);
  await move([]);
  const sorted = s.wrecks.slice().sort((a,b)=>a.expiresAfterWave-b.expiresAfterWave);
  let actions = 0;
  for (const w of sorted) {
    const needEngine = !s.player.module && w.type === 'medium';
    const deficit = 240 - s.baseHp;
    if (!needEngine && deficit < 10) continue;
    const before = s;
    await click(mapPoint(w.x,w.y));
    await button(needEngine ? '#install-module' : '#repair');
    s = await readState();
    assert.ok(s.wrecks.length < before.wrecks.length, 'preparation choice did not consume a wreck');
    note('preparation-action', {wave: s.wave, wreck: w.id, type:w.type, action:needEngine?'install engine':'repair',
      baseHp: s.baseHp, module: s.player.module, preparationSeconds: s.preparationSeconds});
    actions++;
  }
  const east = {x:19.6,y:10.2};
  const central = {x:14.4,y:9.75};
  const west = {x:10.1,y:9.95};
  const goals = tactic === 'west5'
    ? [west,east,east,east,west,central,east,central]
    : [west,east,east,east,east,central,east,east];
  const goal = goals[s.wave-1];
  const limit = performance.now()+11000;
  let preparedPlan;
  let nextPlan = 0;
  while (dist(s.player,goal) > .5 && performance.now() < limit) {
    const actors = s.wrecks;
    if (performance.now() >= nextPlan || !preparedPlan || dist(s.player,preparedPlan.point)<.3) {
      preparedPlan = plan(s,actors,goal);
      nextPlan = performance.now()+230;
    }
    if (dist(s.player,preparedPlan.point)<.1) break;
    await move(direction(s,preparedPlan.point,null,actors));
    await wait(24);
    s = await readState();
    lastState = s;
  }
  await move([]);
  await click(mapPoint(14,10));
  note('preparation-position', {wave:s.wave, goal, x:s.player.x, y:s.player.y, baseHp:s.baseHp, actions,
    preparationSeconds:s.preparationSeconds});
  await key('rawKeyDown','Enter');
  await wait(35);
  await key('keyUp','Enter');
  return s;
}

async function campaign() {
  const sha256 = createHash('sha256').update(buildBytes).digest('hex');
  note('input-build', {path: html, bytes: buildBytes.length, sha256, tactic, browser: await cdp('Browser.getVersion')});
  const {targetInfos} = await cdp('Target.getTargets');
  const targetId = targetInfos.find(t => t.type === 'page').targetId;
  ({sessionId} = await cdp('Target.attachToTarget', {targetId, flatten:true}));
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Network.enable');
  await page('Log.enable');
  await page('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await page('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output,eventsEnabled:true});
  await page('Page.navigate',{url:pathToFileURL(html).href});
  await eventually(() => evaluate('globalThis.TankCore && document.readyState === "complete"'));
  gameObjectId = await locateGame();
  const config = await evaluate('TankCore.CONFIG');
  walls = [...config.WALLS,{x:13.1,y:12.6,w:1.8,h:1.8}];
  spawns = Object.values(config.SPAWNS).map(s => ({x:s.x-s.w/2,y:s.y-s.h/2,w:s.w,h:s.h}));
  specs = config.ENEMY_TYPES;
  board = await evaluate('document.querySelector("#board").getBoundingClientRect().toJSON()');
  assert.ok(board.bottom < 900, JSON.stringify(board));
  let s = await readState();
  assert.equal(s.phase, 'prep');
  assert.equal(s.wave, 1);
  const prepared = new Set();
  let lastLogged = -Infinity, previous, combatPlan, nextPlan = 0, stateKey;
  const deadline = performance.now() + 600000;
  while (performance.now() < deadline) {
    lastState = s;
    const key = [s.phase,s.wave,s.player.alive,s.baseHp,s.stats.kills].join('/');
    if (s.battleSeconds-lastLogged >= .5 || key !== stateKey) {
      fs.writeSync(recordState, JSON.stringify({ms:performance.now()-startedAt,...s})+'\n');
      lastLogged = s.battleSeconds;
      stateKey = key;
    }
    if (s.phase === 'won' || s.phase === 'lost') break;
    assert.equal(s.paused,false);
    if (s.phase === 'prep') {
      if (!prepared.has(s.wave)) {
        if (s.wave > 1) note('wave-end', {wave:s.wave-1, stats:s.stats, baseHp:s.baseHp, playerHp:s.player.hp});
        prepared.add(s.wave);
        await prepare(s);
        combatPlan = null;
      }
    } else if (s.phase === 'battle' && s.player.alive) {
      const actors = [...s.wrecks,...s.enemies];
      const aim = target(s.player,s,actors,previous);
      let waypoint = s.player;
      if (!aim) {
        if (performance.now() >= nextPlan || !combatPlan || dist(s.player,combatPlan.point)<.24) {
          combatPlan = plan(s,actors);
          nextPlan = performance.now()+260;
        }
        waypoint = combatPlan.point;
      } else {
        combatPlan = null;
      }
      await move(direction(s,waypoint,aim,actors));
      await fire(aim);
    } else {
      await move([]);
      await fire(null);
    }
    previous = s;
    await wait(14);
    s = await readState();
  }
  await move([]);
  await fire(null);
  note('terminal', {phase:s.phase,wave:s.wave,baseHp:s.baseHp,player:s.player,stats:s.stats,
    wallSeconds:(performance.now()-startedAt)/1000,
    preparationSeconds:s.preparationSeconds,battleSeconds:s.battleSeconds});
  if (s.phase !== 'won' && s.phase !== 'lost') {
    await screenshot('timeout');
    throw new Error('Campaign did not finish by deadline');
  }
  await eventually(() => evaluate('!document.querySelector("#overlay").hidden'));
  await screenshot(s.phase);
  await button('#modal-actions button:nth-child(2)');
  const downloaded = path.join(output,'tanks-attempt.json');
  await eventually(() => fs.existsSync(downloaded) && alerts.find(event => event.method === 'Browser.downloadProgress' && event.state === 'completed'));
  const journal = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
  assert.equal(journal.current.phase,s.phase);
  const waves = journal.events.filter(e=>e.type === 'wave_end').map(e => {
    const start = journal.events.find(start=>start.type==='wave_start' && start.wave===e.wave);
    return {wave:e.wave,battleSeconds:e.battleSeconds-start.battleSeconds,preparationSeconds:start.preparationSeconds-
      (journal.events.find(prev=>prev.type==='wave_end' && prev.wave===e.wave-1)?.preparationSeconds ?? 0),baseHp:e.baseHp,
      playerHp:e.player.hp,outcome:e.outcome};
  });
  note('journal', {buildId:journal.buildId,current:journal.current,waves,actions:journal.events.filter(e=>/repair|module|reinforce|undo|death|return/.test(e.type)),
    sha256, bytes:buildBytes.length, pageRequests:alerts.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.request.url)});
  assert.equal(alerts.filter(e=>e.method==='Runtime.exceptionThrown' || e.entry?.level==='error').length,0);
  assert.ok(buildBytes.equals(fs.readFileSync(html)), 'tested file bytes changed during campaign');
  assert.equal(alerts.filter(e => e.method === 'Network.requestWillBeSent' && /^https?:/.test(e.request.url)).length, 0);
  if (s.phase === 'won') {
    assert.deepEqual(waves.map(wave => wave.wave), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(journal.current.stats.kills,66);
    assert.ok(waves.every(w => w.outcome === 'cleared'));
  } else process.exitCode = 2;
}

campaign().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output,'chrome-alerts.json'),JSON.stringify(alerts,null,2));
  fs.closeSync(recordInput);
  fs.closeSync(recordState);
  if (!chromeExited && chrome.pid) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  fs.rmSync(profile, {recursive: true, force: true});
});
