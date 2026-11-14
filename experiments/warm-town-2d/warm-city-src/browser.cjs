'use strict';

// Uses a real offline Chrome window and sends normal keyboard/mouse input.
// The two delivered Canvas captures are naturally occurring rendered frames;
// this verifier never creates actors, bullets, wrecks or health in the live game.
// Usage: node warm-city-src/browser.cjs <city.html> <new evidence directory>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setTimeout: wait } = require('node:timers/promises');
const [input, destination] = process.argv.slice(2);
assert.ok(input && destination && process.argv.length === 4, 'Usage: node warm-city-src/browser.cjs <city.html> <new evidence directory>');
const source = path.resolve(input), output = path.resolve(destination);
const width = Number(process.env.TANKS_CITY_WIDTH ?? 1366);
const height = Number(process.env.TANKS_CITY_HEIGHT ?? 900);
const layoutOnly = process.env.TANKS_CITY_LAYOUT_ONLY === '1';
const original = fs.readFileSync(source);
assert.ok(!fs.existsSync(output), 'Evidence directory must be new');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-warm-town-chrome-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--user-data-dir=' + profile, '--remote-debugging-pipe',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-component-update', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const pending = new Map(), alerts = [], checks = {};
let session, gameId, sequence = 0, received = '', transportError, exited = false, stderr = '';
chrome.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
function rejectPending(error) {
  transportError = error;
  for (const job of pending.values()) job.reject(error);
  pending.clear();
}
chrome.on('error', rejectPending);
chrome.on('exit', (code, signal) => { exited = true; rejectPending(Error(`Chrome exited ${signal ?? code}`)); });
chrome.stdio[3].on('error', rejectPending);
chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
  received += chunk;
  let boundary;
  while ((boundary = received.indexOf('\0')) >= 0) {
    const message = JSON.parse(received.slice(0, boundary));
    received = received.slice(boundary + 1);
    const job = pending.get(message.id);
    if (job) {
      pending.delete(message.id);
      if (message.error) job.reject(Error(JSON.stringify(message.error)));
      else job.resolve(message.result);
    }
    if (/^(Runtime.exceptionThrown|Log.entryAdded|Network.requestWillBeSent|Browser.download)/.test(message.method ?? '')) alerts.push(message);
  }
});
function cdp(method, params = {}, sessionId) {
  if (transportError) return Promise.reject(transportError);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
const page = (method, params = {}) => cdp(method, params, session);
function unwrap(value) { if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result; }
const evaluate = async (expression, awaitPromise = false) => unwrap(await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).value;
const gameCall = async (operation, args = []) => unwrap(await page('Runtime.callFunctionOn', { objectId: gameId, functionDeclaration: operation.toString(), arguments: args.map(value => ({ value })), returnByValue: true })).value;
async function eventually(check, description, milliseconds = 7000) {
  const limit = performance.now() + milliseconds;
  do {
    const result = await check();
    if (result) return result;
    await wait(25);
  } while (performance.now() < limit);
  throw Error(`Timed out: ${description}`);
}
const drawFrame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))', true);
const inputLog = fs.openSync(path.join(output, 'input.ndjson'), 'w');
const observations = fs.openSync(path.join(output, 'observations.ndjson'), 'w');
const began = performance.now();
function dispatch(method, params) {
  fs.writeSync(inputLog, JSON.stringify({ milliseconds: Math.round(performance.now() - began), method, params }) + '\n');
  return page(method, params);
}
const codes = { w: ['KeyW', 87], a: ['KeyA', 65], s: ['KeyS', 83], d: ['KeyD', 68] };
function key(name, type) {
  const [code, number] = codes[name];
  return dispatch('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number });
}
let held = [], heldFire = false, board, lastPoint;
async function move(next) {
  for (const name of held.filter(value => !next.includes(value))) await key(name, 'keyUp');
  for (const name of next.filter(value => !held.includes(value))) await key(name, 'rawKeyDown');
  held = next;
}
function mouse(type, point, buttons) {
  return dispatch('Input.dispatchMouseEvent', { type, ...point, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
const onBoard = ({ x, y }) => ({ x: board.left + x / 28 * board.width, y: board.top + y / 18 * board.height });
async function click(point) {
  await mouse('mouseMoved', point, 0);
  await mouse('mousePressed', point, 1);
  await mouse('mouseReleased', point, 0);
}
async function button(selector) {
  const location = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||!e.getClientRects().length||e.disabled)throw Error('Unavailable control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {point:{x:r.x+r.width/2,y:r.y+r.height/2},board:document.querySelector('#board').getBoundingClientRect().toJSON()}})()`);
  board = location.board;
  await click(location.point);
}
async function fire(aim) {
  if (!aim) {
    if (heldFire) await mouse('mouseReleased', lastPoint, 0);
    heldFire = false;
    return;
  }
  lastPoint = onBoard(aim);
  await mouse('mouseMoved', lastPoint, heldFire ? 1 : 0);
  if (!heldFire) await mouse('mousePressed', lastPoint, 1);
  heldFire = true;
}
async function state() {
  return gameCall(function () {
    return { phase: this.phase, wave: this.waveNumber, paused: this.paused,
      player: { ...this.player }, baseHp: this.base.hp, enemies: this.enemies.map(enemy => ({ ...enemy })),
      wrecks: this.wrecks, bullets: this.bullets, queue: this._spawnQueue,
      stats: { ...this.stats }, battleSeconds: this.stats.time, preparationSeconds: this._preparationSeconds };
  });
}
function saveCanvas(name, data) { fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data.split(',')[1], 'base64')); }
async function screenshot(name) {
  const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
}
async function locateGame() {
  const prototype = unwrap(await page('Runtime.evaluate', { expression: 'TankCore.Game.prototype' }));
  const { objects } = await page('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
  const properties = (await page('Runtime.getProperties', { objectId: objects.objectId, ownProperties: true })).result;
  return properties.find(property => property.name === '0')?.value.objectId;
}
function planner(config) {
  // Reuse the checked-in campaign bot, exactly as the existing map-lab runner.
  const verifier = fs.readFileSync(path.join(__dirname, '../../../tools/verify-campaign.cjs'), 'utf8');
  const start = verifier.indexOf('const dist = '), end = verifier.indexOf('async function prepare', start);
  assert.ok(start >= 0 && end > start);
  return new Function('config', verifier.slice(start, end) + `
    walls=[...config.WALLS,{x:13.1,y:12.6,w:1.8,h:1.8}];
    spawns=Object.values(config.SPAWNS).map(s=>({x:s.x-s.w/2,y:s.y-s.h/2,w:s.w,h:s.h}));
    specs=config.ENEMY_TYPES;return {target,direction,plan};
  `)(config);
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
async function driveTo(target, tolerance = .18) {
  const limit = performance.now() + 12000;
  let s = await state();
  while (dist(s.player, target) > tolerance && performance.now() < limit) {
    const next = [];
    if (Math.abs(target.x - s.player.x) > tolerance / 2) next.push(target.x > s.player.x ? 'd' : 'a');
    if (Math.abs(target.y - s.player.y) > tolerance / 2) next.push(target.y > s.player.y ? 's' : 'w');
    await move(next);
    await wait(20);
    s = await state();
  }
  await move([]);
  assert.ok(dist(s.player, target) <= tolerance + .05, `Could not drive to ${JSON.stringify(target)}: ${JSON.stringify(s.player)}`);
  return { x: s.player.x, y: s.player.y };
}
async function inputGeometry() {
  const starting = await state();
  const start = { x: starting.player.x, y: starting.player.y };
  checks.returnInput = [];
  for (const [keyName, target] of [['w', { x: start.x, y: start.y - 2.4 }], ['a', { x: start.x - 2.4, y: start.y }], ['d', { x: start.x + 2.4, y: start.y }]]) {
    const reached = await driveTo(target);
    checks.returnInput.push({ key: keyName, from: start, reached });
    await driveTo(start);
  }
  const left = await driveTo({ x: .65, y: start.y });
  const right = await driveTo({ x: 27.35, y: start.y });
  await driveTo(start);
  checks.bottomInput = { left, right, returned: (await state()).player };

  // All waypoints use the ordinary controls, starting from the return point.
  // First reach the alley and traverse it from west to east, north of the plaza.
  const points = [{ x: 16.4, y: 9.5 }, { x: 3, y: 9.5 }, { x: 18, y: 9.5 }];
  checks.alleyInput = [];
  for (const point of points) checks.alleyInput.push(await driveTo(point));

  // A genuine wall-contact check on the east wing, then use the open court.
  await move(['d']);
  await wait(550);
  await move([]);
  const contact = (await state()).player;
  assert.ok(Math.abs(contact.x - 18.4) <= .025, `Unexpected wall contact at ${contact.x}, ${contact.y}`);
  checks.eastWallContact = { x: contact.x, y: contact.y };

  const bypass = [{ x: 18.1, y: 12 }, { x: 26.4, y: 12 }, { x: 26.4, y: 11.4 }, { x: 26.4, y: 17.2 }, start];
  checks.courtAndSoutheastInput = [];
  for (const point of bypass) checks.courtAndSoutheastInput.push(await driveTo(point));
}
async function liveBattleCapture(bestScore) {
  const result = await gameCall(function (bestScore) {
    const plaza = this.config.CITY.plaza;
    const inside = item => item.x > plaza.x && item.x < plaza.x + plaza.w && item.y > plaza.y && item.y < plaza.y + plaza.h;
    const atSquare = item => item.x > plaza.x - 1.5 && item.x < plaza.x + plaza.w + 1.5 && item.y > plaza.y - 1.5 && item.y < plaza.y + plaza.h;
    const actors = [this.player, ...this.enemies, ...this.wrecks];
    const separation = bullet => Math.min(...actors.map(actor => Math.hypot(bullet.x - actor.x, bullet.y - actor.y)));
    const clearBullets = this.bullets.filter(bullet => separation(bullet) > 1 && bullet.x > .5 && bullet.x < 27.5 && bullet.y > .5 && bullet.y < 17.5);
    if (this.phase !== 'battle' || !this.player.alive || !this.wrecks.length || !this.enemies.length || !clearBullets.length) return null;
    const score = clearBullets.length * 100 + this.enemies.filter(atSquare).length * 20 + this.enemies.length * 5 +
      this.wrecks.filter(inside).length * 10 + (inside(this.player) ? 6 : 0) + Math.min(3, Math.max(...clearBullets.map(separation)));
    if (score <= bestScore) return null;
    return { canvas: document.querySelector('#board').toDataURL('image/png'), wave: this.waveNumber,
      battleSeconds: this.stats.time, player: { ...this.player }, enemies: this.enemies.map(e => ({ ...e })),
      wrecks: this.wrecks, bullets: this.bullets, clearProjectiles: clearBullets.length, score, stats: { ...this.stats } };
  }, [bestScore]);
  if (!result) return bestScore;
  saveCanvas('battle', result.canvas);
  delete result.canvas;
  checks.battleFrame = { provenance: 'Unmodified live game; ordinary keyboard and mouse input, same rendered frame as observed entities.', ...result };
  fs.writeFileSync(path.join(output, 'battle-frame.json'), JSON.stringify(checks.battleFrame, null, 2));
  return result.score;
}
async function approach(bot, initial, destination, tolerance = .4) {
  let s = initial;
  let currentPlan, nextPlan = 0;
  const limit = performance.now() + 16000;
  while (dist(s.player, destination) > tolerance && performance.now() < limit) {
    if (!currentPlan || performance.now() >= nextPlan || dist(s.player, currentPlan.point) < .25) {
      currentPlan = bot.plan(s, s.wrecks, destination);
      nextPlan = performance.now() + 200;
    }
    await move(bot.direction(s, currentPlan.point, null, s.wrecks));
    await wait(20);
    s = await state();
  }
  await move([]);
  assert.ok(dist(s.player, destination) <= tolerance, `Player did not reach ${JSON.stringify(destination)}`);
}
async function campaign(config) {
  const bot = planner(config), plaza = config.CITY.plaza;
  const defense = { x: 11, y: 10.95 };
  const nearSquare = enemy => enemy.x >= plaza.x - 2 && enemy.x <= plaza.x + plaza.w + 1.4 &&
    enemy.y >= plaza.y - 2 && enemy.y < plaza.y + plaza.h;
  checks.waves = [];
  let s = await state(), previous, combatPlan, nextPlan = 0, captureScore = 0;
  const startedWaves = new Set(), deadline = performance.now() + 180000;
  while (performance.now() < deadline) {
    if (s.phase === 'lost' || s.phase === 'won') break;
    if (s.phase === 'prep') {
      if (s.wave > 1 && !checks.waves.some(w => w.wave === s.wave - 1)) {
        checks.waves.push({ wave: s.wave - 1, outcome: 'cleared', baseHp: s.baseHp, stats: s.stats });
        process.stdout.write(JSON.stringify({ event: 'wave-cleared', ...checks.waves.at(-1) }) + '\n');
      }
      if ((captureScore > 0 && s.wave > 2) || s.wave > 3) break;
      if (!startedWaves.has(s.wave)) {
        await fire(null);
        await approach(bot, s, defense);
        startedWaves.add(s.wave);
        await button('#start');
        await eventually(async () => (await state()).phase === 'battle', 'start button begins wave');
        combatPlan = null;
      }
    } else if (s.phase === 'battle' && s.player.alive) {
      const actors = [...s.wrecks, ...s.enemies];
      // Let the first medium reach the streets bordering the square, so its
      // wreck and the next arriving enemies can appear together in a live frame.
      const eligible = s.wrecks.length ? s.enemies : s.enemies.filter(e => nearSquare(e) || (e.type === 'light' && dist(e, s.player) < 2.3));
      const aim = bot.target(s.player, { ...s, enemies: eligible }, actors, previous);
      let waypoint = s.player;
      if (!aim) {
        if (!combatPlan || performance.now() >= nextPlan || dist(s.player, combatPlan.point) < .24) {
          combatPlan = eligible.length ? bot.plan(s, actors) : bot.plan(s, actors, defense);
          nextPlan = performance.now() + 230;
        }
        waypoint = combatPlan.point;
      } else combatPlan = null;
      await move(bot.direction(s, waypoint, aim, actors));
      await fire(aim);
      for (const wreck of s.wrecks) {
        const earlier = previous?.wrecks.find(item => item.id === wreck.id);
        if (earlier && wreck.hp < earlier.hp && !checks.liveWreckDamage) {
          checks.liveWreckDamage = { id: wreck.id, wave: s.wave, before: earlier.hp, after: wreck.hp, battleSeconds: s.battleSeconds };
        }
      }
      captureScore = await liveBattleCapture(captureScore);
    } else {
      await move([]);
      await fire(null);
    }
    fs.writeSync(observations, JSON.stringify({ milliseconds: Math.round(performance.now() - began), ...s }) + '\n');
    previous = s;
    await wait(15);
    s = await state();
  }
  await move([]);
  await fire(null);
  checks.final = s;
  assert.ok(checks.waves.length >= 1, 'No complete combat wave observed');
  assert.ok(captureScore > 0, 'No natural frame containing tank, wreck and separated visible projectile was captured');
}

async function wreckControls() {
  const before = await state();
  const [wreck, target] = before.wrecks;
  assert.ok(wreck, 'No surviving combat wreck to select in preparation');
  const select = async position => {
    await evaluate('scrollTo(0, 0)');
    board = await evaluate('document.querySelector("#board").getBoundingClientRect().toJSON()');
    await click(onBoard(position));
  };
  const undo = async () => {
    await button('#undo');
    const restored = await state();
    assert.equal(restored.baseHp, before.baseHp);
    assert.equal(restored.player.module, before.player.module);
    assert.deepEqual(restored.wrecks, before.wrecks);
  };

  await select(wreck);
  await button('#repair');
  const repaired = await state();
  assert.equal(repaired.wrecks.length, before.wrecks.length - 1);
  assert.equal(repaired.baseHp, Math.min(240, before.baseHp + 30));
  await undo();

  await select(wreck);
  await button('#install-module');
  const equipped = await state();
  assert.equal(equipped.player.module, 'engine');
  assert.equal(equipped.wrecks.length, before.wrecks.length - 1);
  await undo();
  checks.wreckControls = { wreckId: wreck.id, repairedHp: repaired.baseHp - before.baseHp, module: equipped.player.module, repairAndModuleUndone: true };

  if (target) {
    await select(wreck);
    await button('#choose-reinforcement');
    await select(target);
    await button('#confirm-reinforcement');
    const reinforced = (await state()).wrecks;
    assert.equal(reinforced.length, before.wrecks.length - 1);
    const recipient = reinforced.find(item => item.id === target.id);
    assert.ok(recipient?.reinforced);
    assert.equal(recipient.expiresAfterWave, target.expiresAfterWave + 1);
    await undo();
    checks.wreckControls.reinforcement = { targetId: recipient.id, reinforcedUntilWave: recipient.expiresAfterWave, undone: true };
  }
}
async function main() {
  checks.source = { path: source, sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length };
  checks.browser = await cdp('Browser.getVersion');
  const { targetInfos } = await cdp('Target.getTargets');
  const targetId = targetInfos.find(value => value.type === 'page').targetId;
  ({ sessionId: session } = await cdp('Target.attachToTarget', { targetId, flatten: true }));
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await page(domain + '.enable');
  await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
  await page('Page.navigate', { url: pathToFileURL(source).href });
  await eventually(() => evaluate('!!globalThis.TankCore && document.readyState === "complete"'), 'standalone load');
  gameId = await locateGame();
  assert.ok(gameId, 'Running game not found');
  const config = await evaluate('TankCore.CONFIG');
  assert.equal(config.mapId, 'warm-town', 'Loaded the wrong map');
  assert.equal(await evaluate('location.protocol'), 'file:');
  if (original.includes('cityMaterials.decode()')) {
    await eventually(() => evaluate('document.querySelector("#board").dataset.artReady === "true"'), 'embedded city texture decoded');
    checks.embeddedArt = { decoded: true };
  }
  await drawFrame();
  board = await evaluate('document.querySelector("#board").getBoundingClientRect().toJSON()');
  assert.ok(board.top >= 0 && board.bottom <= height && board.left >= 0 && board.right <= width, `Board clipped: ${JSON.stringify(board)}`);
  assert.equal(await evaluate('navigator.onLine'), false);
  checks.layout = { viewport: { width, height }, board };
  const dashboard = await evaluate(`({module:document.querySelector('#player-module').getBoundingClientRect().toJSON(),shell:document.querySelector('.board-shell').getBoundingClientRect().toJSON()})`);
  assert.ok(dashboard.module.bottom <= dashboard.shell.top, `Player module clipped by board: ${JSON.stringify(dashboard)}`);
  checks.layout.dashboard = dashboard;
  assert.equal(await evaluate('document.querySelector("#routes").checked'), false, 'Forecast must start off');
  await drawFrame();
  assert.equal(await evaluate('document.querySelector("#routes").checked'), false);
  saveCanvas('city-routes-off', await evaluate('document.querySelector("#board").toDataURL("image/png")'));
  await screenshot('city-page');
  const off = await evaluate('document.querySelector("#board").toDataURL()');
  await button('#routes');
  await drawFrame();
  assert.equal(await evaluate('document.querySelector("#routes").checked'), true);
  const on = await evaluate('document.querySelector("#board").toDataURL()');
  assert.notEqual(on, off, 'Forecast toggle did not change rendered board');
  await button('#routes');
  assert.equal(await evaluate('document.querySelector("#routes").checked'), false);
  await evaluate('scrollTo(0, 0)');
  board = await evaluate('document.querySelector("#board").getBoundingClientRect().toJSON()');
  checks.forecastDisabled = true;
  if (!layoutOnly) {
    await inputGeometry();
    await campaign(config);
    await wreckControls();
    await button('#export-attempt');
    await eventually(() => fs.existsSync(path.join(output, 'tanks-attempt.json')), 'attempt export');
    const journal = JSON.parse(fs.readFileSync(path.join(output, 'tanks-attempt.json'), 'utf8'));
    checks.journal = { buildId: journal.buildId, events: journal.events.length, waves: journal.events.filter(event => event.type === 'wave_end'),
      wrecksCreated: journal.events.filter(event => event.type === 'wreck_created').length,
      preparationActions: journal.events.filter(event => ['repair', 'module_change', 'reinforce', 'undo'].includes(event.type)).map(event => event.type) };
    assert.ok(checks.journal.waves.some(event => event.outcome === 'cleared'), 'Export does not contain cleared wave');
    assert.ok(checks.journal.wrecksCreated > 0, 'Export does not record a wreck from live combat');
    const expectedActions = ['repair', 'undo', 'module_change', 'undo'];
    if (checks.wreckControls.reinforcement) expectedActions.push('reinforce', 'undo');
    assert.deepEqual(checks.journal.preparationActions, expectedActions, 'Preparation actions missing from export');
  }
  assert.ok(original.equals(fs.readFileSync(source)), 'Source changed during browser test');
  const errors = alerts.filter(event => event.method === 'Runtime.exceptionThrown' || event.params.entry?.level === 'error');
  const network = alerts.filter(event => event.method === 'Network.requestWillBeSent' && /^https?:/.test(event.params.request.url));
  const localDependencies = alerts.filter(event => event.method === 'Network.requestWillBeSent' &&
    event.params.request.url.startsWith('file:') && event.params.request.url !== pathToFileURL(source).href);
  assert.deepEqual(errors, [], 'Page errors');
  assert.deepEqual(network, [], 'External network requests');
  assert.deepEqual(localDependencies, [], 'Additional local file dependencies');
  checks.pageErrors = 0;
  checks.externalRequests = 0;
  checks.localDependencies = 0;
  process.stdout.write(JSON.stringify({ event: 'passed', source: checks.source, waves: checks.waves, captureWave: checks.battleFrame?.wave, layoutOnly }) + '\n');
}
main().catch(error => {
  checks.failure = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(checks, null, 2));
  fs.writeFileSync(path.join(output, 'chrome-events.json'), JSON.stringify(alerts, null, 2));
  if (stderr) fs.writeFileSync(path.join(output, 'chrome-stderr.txt'), stderr);
  fs.closeSync(inputLog);
  fs.closeSync(observations);
  if (!exited && chrome.pid) {
    const stopped = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await stopped;
  }
  fs.rmSync(profile, { recursive: true, force: true });
});
