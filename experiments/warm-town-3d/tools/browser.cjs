'use strict';

// Requires Chrome and Node 20+. The delivered HTML is opened unchanged via file://.
// CDP reads live state for verification. Only regular mouse/keyboard input drives the live game.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const makeCombatDriver = require('./combat-driver.cjs');

const flags = process.argv.slice(2);
const layoutOnly = flags.includes('--layout-only');
const battleOnly = flags.includes('--battle-only');
const drivesOnly = flags.includes('--drives-only');
const recoveryOnly = flags.includes('--recovery-only');
const noFloatCache = flags.includes('--no-float-cache');
const blockout = flags.includes('--blockout');
const [filename = '../tanks-warm-town-3d.html', destination = '../evidence'] = flags.filter(arg => !arg.startsWith('--'));
const source = path.resolve(__dirname, filename);
const output = path.resolve(__dirname, destination);
const report = {};
const events = [];
const pending = new Map();
let chrome, profile, session, gameId, viewId, protocolError, exited;
let nextRequest = 0;
let received = '';
let stderr = '';

function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-town-chrome-'));
  chrome = spawn(process.env.TOWN_CHROME || 'google-chrome', [
    '--headless=new', '--user-data-dir=' + profile, '--remote-debugging-pipe',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--enable-unsafe-swiftshader', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const interrupted = error => {
    protocolError = error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  chrome.on('error', interrupted);
  chrome.on('exit', (code, signal) => {
    exited = true;
    interrupted(Error(`Chrome exited ${signal ?? code}`));
  });
  chrome.stdio[3].on('error', interrupted);
  chrome.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  chrome.stdio[4].setEncoding('utf8').on('data', data => {
    received += data;
    let boundary;
    while ((boundary = received.indexOf('\0')) >= 0) {
      const message = JSON.parse(received.slice(0, boundary));
      received = received.slice(boundary + 1);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      }
      if (/^(Runtime.exceptionThrown|Runtime.consoleAPICalled|Log.entryAdded|Network.requestWillBeSent|Browser.download)/.test(message.method ?? '')) {
        events.push(message);
      }
    }
  });
}

function cdp(method, params = {}, sessionId) {
  if (protocolError) return Promise.reject(protocolError);
  return new Promise((resolve, reject) => {
    const id = ++nextRequest;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timed out: ${method}`)); }, 20000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
const page = (method, params = {}) => cdp(method, params, session);
function unwrap(response) {
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails));
  return response.result;
}
async function evaluate(expression, awaitPromise = false) {
  return unwrap(await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).value;
}
async function call(objectId, operation, ...args) {
  const result = await page('Runtime.callFunctionOn', {
    objectId, functionDeclaration: operation.toString(), arguments: args.map(value => ({ value })),
    returnByValue: true, awaitPromise: true
  });
  return unwrap(result).value;
}
async function instanceFor(name) {
  try {
    const prototype = unwrap(await page('Runtime.evaluate', { expression: name + '.prototype' }));
    const { objects } = await page('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
    const { result: properties } = await page('Runtime.getProperties', { objectId: objects.objectId, ownProperties: true });
    return properties.find(property => property.name === '0')?.value.objectId;
  } catch {
    return null;
  }
}
async function eventually(check, description, timeout = 8000) {
  const deadline = performance.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await wait(25);
  } while (performance.now() < deadline);
  throw Error(`Timed out: ${description}`);
}
const nextFrame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))', true);

const keyCodes = { w: ['KeyW', 87], a: ['KeyA', 65], s: ['KeyS', 83], d: ['KeyD', 68], z: ['KeyZ', 90] };
let held = [];
let lastPoint;
let heldFire = false;
let inputEvents = 0;
let trace;
function input(method, params) {
  inputEvents++;
  if (trace !== undefined) fs.writeSync(trace, JSON.stringify({ timestamp: Math.round(performance.now()), method, params }) + '\n');
  return page(method, params);
}
function key(name, type, modifiers = 0) {
  const [code, number] = keyCodes[name];
  return input('Input.dispatchKeyEvent', {
    type, key: name, code, modifiers, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number
  });
}
async function move(next) {
  for (const name of held.filter(value => !next.includes(value))) await key(name, 'keyUp');
  for (const name of next.filter(value => !held.includes(value))) await key(name, 'rawKeyDown');
  held = next;
}
function mouse(type, { x, y }, buttons) {
  return input('Input.dispatchMouseEvent', {
    type, x, y, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 })
  });
}
const project = ({ x, y }, elevation) => call(viewId, function (x, y, elevation) {
  return this.worldToScreen(x, y, elevation ?? undefined);
}, x, y, elevation ?? null);

async function click(point) {
  await mouse('mouseMoved', point, 0);
  await mouse('mousePressed', point, 1);
  await mouse('mouseReleased', point, 0);
}
async function button(selector) {
  const target = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || !node.getClientRects().length || node.disabled) throw Error('Unavailable control: ' + ${JSON.stringify(selector)});
    const bounds = node.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) node.scrollIntoView({ block: 'nearest' });
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await click(target);
}
async function fire(aim) {
  if (!aim) {
    if (heldFire) await mouse('mouseReleased', lastPoint, 0);
    heldFire = false;
    return;
  }
  lastPoint = await project(aim);
  await mouse('mouseMoved', lastPoint, heldFire ? 1 : 0);
  if (!heldFire) await mouse('mousePressed', lastPoint, 1);
  heldFire = true;
}

function state() {
  return call(gameId, function () {
    return {
      phase: this.phase, wave: this.waveNumber, paused: this.paused,
      player: this.player, base: this.base, enemies: this.enemies, wrecks: this.wrecks,
      bullets: this.bullets, queue: this._spawnQueue, stats: this.stats,
      battleSeconds: this.stats.time, preparationSeconds: this._preparationSeconds
    };
  });
}
async function viewportShot(name) {
  const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
}
async function boardImage() {
  return evaluate('new Promise(done=>requestAnimationFrame(()=>done(document.querySelector("#board").toDataURL())))', true);
}
function writePng(name, url) {
  assert.match(url, /^data:image\/png;base64,/);
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const coord = ({ x, y }) => ({ x, y });
const rect = () => evaluate('document.querySelector("#board").getBoundingClientRect().toJSON()');

async function setup(width, height) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const url = pathToFileURL(source);
  if (blockout) url.searchParams.set('blockout', '1');
  const navigation = await page('Page.navigate', { url: url.href });
  assert.equal(navigation.errorText, undefined, `File navigation failed: ${navigation.errorText}`);
  await eventually(() => evaluate('!!globalThis.TankCore && !!globalThis.Town3D && document.readyState === "complete"'), 'standalone HTML load');
  gameId = await eventually(() => instanceFor('TankCore.Game'), 'running Game instance');
  viewId = await eventually(() => instanceFor('Town3D.View'), 'running Three.js View instance');
  await nextFrame();
}
function performanceSample() {
  // Frame cadence with an unthrottled virtual display. Includes compositing and
  // driver delivery, rather than interpreting JS scheduling as GPU speed.
  return evaluate(`new Promise(done => {
    const deltas = [];
    let previous;
    function onFrame(now) {
      if (previous !== undefined) deltas.push(now - previous);
      previous = now;
      if (deltas.length === 55) {
        const sorted = deltas.slice().sort((a,b) => a-b);
        done({
          intervals: sorted.length,
          averageFps: sorted.length * 1000 / sorted.reduce((a,b) => a+b, 0),
          medianMs: sorted[Math.floor(sorted.length * .5)],
          p95Ms: sorted[Math.floor(sorted.length * .95)],
          worstMs: sorted.at(-1)
        });
      } else requestAnimationFrame(onFrame);
    }
    requestAnimationFrame(onFrame);
  })`, true);
}
async function checkViewport(width, height, forecast = false) {
  const board = await rect();
  assert.ok(board.top >= 0 && board.bottom <= height + .5 && board.left >= 0 && board.right <= width + .5,
    `Board clipped at ${width}×${height}: ${JSON.stringify(board)}`);
  const projectedCorners = [];
  for (const point of [{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 0, y: 18 }, { x: 28, y: 18 }]) {
    const onScreen = await project(point, 0);
    assert.ok(onScreen.visible &&
      onScreen.x >= board.left && onScreen.x <= board.right &&
      onScreen.y >= board.top && onScreen.y <= board.bottom,
    `City corner clipped: ${JSON.stringify({ point, onScreen, board })}`);
    projectedCorners.push(onScreen);
  }
  assert.equal(await evaluate('navigator.onLine'), false, 'Chrome was not offline');
  assert.equal(await evaluate('location.protocol'), 'file:');
  assert.equal(await evaluate('document.querySelector("#routes").checked'), false, 'Route forecast not disabled at launch');
  const frame = { width, height, board, projectedCorners, predictionOffAtStart: true };
  frame.diagnostics = await call(viewId, function () { return this.diagnostics(); });
  await viewportShot((blockout ? 'blockout-' : 'city-') + width + 'x' + height);
  if (!blockout) frame.performance = await performanceSample();
  if (forecast) {
    const off = await boardImage();
    await button('#routes');
    await nextFrame();
    assert.equal(await evaluate('document.querySelector("#routes").checked'), true);
    assert.notEqual(await boardImage(), off, 'Route overlay did not change the rendered board');
    await button('#routes');
    await nextFrame();
    assert.equal(await evaluate('document.querySelector("#routes").checked'), false);
    frame.predictionToggle = true;
  }
  return frame;
}
async function verifyAim() {
  const targets = [{ x: 13.2, y: 10.8 }, { x: 26.3, y: 12.5 }, { x: 1.9, y: 16.55 }];
  const observed = [];
  for (const target of targets) {
    const pixel = await project(target);
    const world = await call(viewId, function (x, y) { return this.screenToWorld(x, y); }, pixel.x, pixel.y);
    const conversionError = dist(target, world);
    assert.ok(conversionError < 1e-4, 'Camera projection round-trip drifted');
    await mouse('mouseMoved', pixel, 0);
    const player = (await state()).player;
    const expected = Math.atan2(target.y - player.y, target.x - player.x);
    const angleError = angle => Math.abs(Math.atan2(Math.sin(angle - expected), Math.cos(angle - expected)));
    const actual = await eventually(async () => {
      const current = (await state()).player;
      return angleError(current.angle) < .025 ? { angle: current.angle } : null;
    }, 'mouse aim rotates real turret to projected world target');
    observed.push({ target, pixel, conversionError, angleErrorRadians: angleError(actual.angle) });
  }
  return observed;
}
async function driveTo(target, margin = .23) {
  const deadline = performance.now() + 8500 + 2850 * dist((await state()).player, target);
  let s = await state();
  while (performance.now() < deadline) {
    if (dist(s.player, target) <= margin) {
      await move([]);
      s = await state();
      if (dist(s.player, target) <= margin + .12) return coord(s.player);
    }
    const next = [];
    if (Math.abs(target.x - s.player.x) > margin * .65) next.push(target.x > s.player.x ? 'd' : 'a');
    if (Math.abs(target.y - s.player.y) > margin * .65) next.push(target.y > s.player.y ? 's' : 'w');
    await move(next);
    await wait(20);
    s = await state();
  }
  await move([]);
  throw Error(`Could not drive to ${JSON.stringify(target)} from ${JSON.stringify(coord(s.player))}`);
}
async function ordinaryDrives() {
  const start = coord((await state()).player);
  assert.deepEqual(start, { x: 16.4, y: 17.2 });
  const exits = [];
  for (const [key, target] of [['W', { x: start.x, y: start.y - 2.35 }], ['A', { x: start.x - 2.35, y: start.y }], ['D', { x: start.x + 2.35, y: start.y }]]) {
    exits.push({ key, start, reached: await driveTo(target) });
    await driveTo(start);
  }
  const leftEnd = await driveTo({ x: .7, y: 17.15 });
  const rightEnd = await driveTo({ x: 27.3, y: 17.15 });
  await driveTo({ x: 26.4, y: 17.15 });
  const rightBypass = [];
  for (const point of [{ x: 26.4, y: 11.18 }, { x: 25.8, y: 12.03 }, { x: 17, y: 12.03 }]) {
    rightBypass.push(await driveTo(point));
  }
  const alley = [];
  for (const point of [{ x: 18.05, y: 9.55 }, { x: 3.1, y: 9.55 }, { x: 3.1, y: 10.45 }, { x: 12.6, y: 10.45 }]) {
    alley.push(await driveTo(point));
  }
  return { start, exits, bottomStreet: { leftEnd, rightEnd }, eastCourtAndBypass: rightBypass, northAlley: alley };
}
async function collideTownHall() {
  await driveTo({ x: 12.85, y: 17.1 });
  await driveTo({ x: 12.85, y: 14.92 });
  await move(['a']);
  await wait(650);
  await move([]);
  const reached = coord((await state()).player);
  assert.ok(Math.abs(reached.x - 12.3) < .025, `Tank did not stop at town hall east face + tank radius: ${JSON.stringify(reached)}`);
  return { targetWall: 'townhall-1', wallX: 11.8, tankRadius: .5, reached };
}

async function liveFrame(plaza, bestScore) {
  return call(gameId, function (plaza, bestScore) {
    return new Promise(done => requestAnimationFrame(() => {
      const inside = ({ x, y }, margin = 0) =>
        x >= plaza.x - margin && x <= plaza.x + plaza.w + margin && y >= plaza.y - margin && y <= plaza.y + plaza.h + margin;
      const separation = bullet => Math.min(...[this.player, ...this.enemies, ...this.wrecks]
        .map(actor => Math.hypot(actor.x - bullet.x, actor.y - bullet.y)));
      const clearBullets = this.bullets.filter(bullet => inside(bullet, .7) && separation(bullet) > .85);
      if (this.phase !== 'battle' || !this.player.alive || !this.enemies.length || !this.wrecks.length || !clearBullets.length) {
        done(null);
        return;
      }
      const score = clearBullets.length * 30 + this.wrecks.filter(wreck => inside(wreck, 1.0)).length * 80 +
        this.enemies.filter(enemy => inside(enemy, 2.0)).length * 15 + (inside(this.player, .7) ? 30 : 0);
      if (score <= bestScore) {
        done(null);
        return;
      }
      done({
        image: document.querySelector('#board').toDataURL('image/png'),
        score, wave: this.waveNumber, battleSeconds: this.stats.time,
        player: this.player, enemies: this.enemies, wrecks: this.wrecks, bullets: this.bullets, clearBullets
      });
    }));
  }, plaza, bestScore);
}

async function runBattle(config, plaza) {
  const defense = { x: 12.3, y: 11.2 };
  await driveTo(defense);
  const bot = makeCombatDriver(config, (await state()).base);
  let s = await state();
  let previous;
  let plan;
  let nextPlanAt = 0;
  let capture;
  const wave = s.wave;
  await button('#start');
  await eventually(async () => (await state()).phase === 'battle', 'start button begins combat');
  const deadline = performance.now() + 110000;
  let firstBullet;
  let activeBattleSample;
  let visibleLabels;

  while (performance.now() < deadline) {
    s = await state();
    if (s.phase === 'prep' || s.phase === 'won' || s.phase === 'lost') break;
    if (!s.player.alive || s.phase === 'settling') {
      await move([]);
      await fire(null);
      await wait(20);
      continue;
    }
    const actors = [...s.wrecks, ...s.enemies];
    if (s.enemies.length >= 2 && !activeBattleSample) activeBattleSample = performanceSample();
    if (s.enemies.length && !visibleLabels?.length) {
      visibleLabels = await evaluate(`Array.from(document.querySelectorAll('#board-unit-labels span:not([hidden])'), node => node.textContent)`);
    }
    // The medium advances to the square before the bot engages. This makes its
    // natural wreck and subsequent projectile interactions clear in the capture.
    const targets = s.enemies.filter(enemy => enemy.type === 'light' ||
      s.wrecks.length || enemy.y > 9.5 && enemy.x > 7.25 || s.battleSeconds > 16);
    const aim = bot.target(s.player, { ...s, enemies: targets }, actors, previous);
    let waypoint = s.player;
    if (!aim) {
      if (!plan || performance.now() >= nextPlanAt || dist(s.player, plan.point) < .16) {
        plan = targets.length ? bot.plan(s, actors) : bot.plan(s, actors, defense);
        nextPlanAt = performance.now() + 210;
      }
      waypoint = plan.point;
    } else plan = null;
    await move(bot.direction(s, waypoint, aim, actors));
    await fire(aim);
    firstBullet ??= s.bullets.find(bullet => bullet.team === 'player');
    if (s.wrecks.length && s.enemies.length) {
      const frame = await liveFrame(plaza, capture?.score ?? 0);
      if (frame) {
        writePng('battle-wave-' + frame.wave, frame.image);
        delete frame.image;
        capture = frame;
      }
    }
    previous = s;
    await wait(17);
  }
  await move([]);
  await fire(null);
  report.combat = { wave, final: s, firstBullet, capture, visibleLabels };
  if (activeBattleSample) report.combat.performance = await activeBattleSample;

  assert.ok(s.phase === 'prep' && s.wave === wave + 1, `Wave ${wave} was not cleared: ${JSON.stringify({ phase: s.phase, base: s.base, enemies: s.enemies, stats: s.stats })}`);
  assert.ok(firstBullet && s.stats.kills >= 4 && s.stats.wrecksCreated > 0, 'Live shots, kills, and natural wreck expected');
  assert.ok(capture, 'No rendered frame containing a live tank, natural wreck and separated flying projectile');
}

async function undo() {
  await key('z', 'rawKeyDown', 2);
  await key('z', 'keyUp', 2);
}
async function verifyWreck() {
  const before = await state();
  const wreck = before.wrecks.find(item => item.type === 'medium');
  assert.ok(wreck, 'No medium wreck survived for the preparation-action checks');

  // Read the actual sweep against the naturally-created obstacle. These segments
  // don't spawn actors or consume a shot in the ongoing attempt.
  const collision = await call(gameId, function (id) {
    const w = this.wrecks.find(item => item.id === id);
    const cast = (dx, dy) => {
      const hit = this._firstCollision(w.x + dx, w.y + dy, w.x, w.y, this.player.id);
      return { kind: hit?.kind, id: hit?.object.id };
    };
    const projectile = [[0,1.2], [0,-1.2], [1.2,0], [-1.2,0]]
      .map(([x,y]) => cast(x,y)).find(hit => hit.kind === 'wreck');
    return { canOccupyCenterWithTank: this._positionFree(w.x, w.y, this.player, true), projectile };
  }, wreck.id);
  assert.equal(collision.canOccupyCenterWithTank, false);
  assert.deepEqual(collision.projectile, { kind: 'wreck', id: wreck.id });

  const select = async () => {
    await click(await project(wreck));
    await eventually(() => evaluate('!document.querySelector("#salvage-actions").hidden'), 'projected click selects natural wreck');
  };
  const restored = () => eventually(async () => {
    const current = await state();
    return current.player.module === before.player.module && current.base.hp === before.base.hp &&
      current.wrecks.some(item => item.id === wreck.id) ? current : null;
  }, 'Ctrl+Z restores the wreck, module and base HP');
  await select();
  await button('#repair');
  const repaired = await eventually(async () => {
    const current = await state();
    return !current.wrecks.some(item => item.id === wreck.id) ? current : null;
  }, 'repair dismantles selected wreck');
  await undo();
  await restored();
  await select();
  await button('#install-module');
  await eventually(async () => (await state()).player.module === 'engine', 'medium wreck installs engine');
  await undo();
  const final = await restored();
  report.wreck = {
    id: wreck.id, collision, projectedSelection: true,
    baseHpBefore: before.base.hp, baseHpAfterRepair: repaired.base.hp,
    dismantled: true, engineInstalled: true, undoRestoredWreckAndState: true,
    finalWrecks: final.wrecks
  };
}
async function verifyJournal() {
  await button('#export-attempt');
  const downloaded = path.join(output, 'tanks-attempt.json');
  await eventually(() => fs.existsSync(downloaded), 'JSON attempt journal downloaded');
  const journal = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
  assert.ok(journal.events.some(event => event.type === 'wave_end' && event.wave === 1 && event.outcome === 'cleared'));
  report.journal = {
    filename: path.basename(downloaded), buildId: journal.buildId, events: journal.events.length,
    waveEnds: journal.events.filter(event => event.type === 'wave_end'),
    preparationActions: journal.events.filter(event => ['repair', 'module_change', 'reinforce', 'undo'].includes(event.type))
  };
}
async function verifyRecovery() {
  const before = await boardImage();
  const projectorProbe = { x: 13.2, y: 10.8 };
  const screenBefore = await project(projectorProbe);
  const restoreResult = await call(viewId, function () {
    return new Promise((resolve, reject) => {
      const canvas = this.canvas;
      const gl = this.renderer.getContext();
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) { reject(Error('WEBGL_lose_context unavailable')); return; }
      const timeout = setTimeout(() => reject(Error('WebGL context restore timeout')), 5000);
      canvas.addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 150), { once: true });
      canvas.addEventListener('webglcontextrestored', () => {
        clearTimeout(timeout);
        resolve(!gl.isContextLost());
      }, { once: true });
      extension.loseContext();
    });
  });
  assert.equal(restoreResult, true);
  await nextFrame();
  assert.equal(await boardImage(), before, 'Recovered frame differs from still city before WebGL loss');
  const oldGame = await state();
  await page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await nextFrame();
  assert.deepEqual((await state()).player, oldGame.player, 'Resize changed ongoing game state');
  const screenAfter = await project(projectorProbe);
  assert.notDeepEqual(screenAfter, screenBefore, 'Camera did not refit to resized board');
  const roundTrip = await call(viewId, function (point) { return this.screenToWorld(point.x, point.y); }, screenAfter);
  assert.ok(dist(projectorProbe, roundTrip) < 1e-4);
  return { contextRestored: true, unchangedStillPixelsAfterRestore: true, responsiveProjection: { screenBefore, screenAfter, roundTrip } };
}

async function run() {
  const bytes = fs.readFileSync(source);
  fs.mkdirSync(output, { recursive: true });
  report.source = { filename: path.basename(source), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  report.run = { headless: true, cpu: os.cpus()[0]?.model, scaleFactor: 1, softwareRenderingPermitted: true };
  launch();
  report.browser = await cdp('Browser.getVersion');
  const { targetInfos } = await cdp('Target.getTargets');
  const targetId = targetInfos.find(value => value.type === 'page').targetId;
  ({ sessionId: session } = await cdp('Target.attachToTarget', { targetId, flatten: true }));
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await page(domain + '.enable');
  if (noFloatCache) {
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalGetExtension = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        return /EXT_color_buffer_(float|half_float)/.test(name)
          ? null : originalGetExtension.call(this, name);
      };
    ` });
  }
  await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
  const download = path.join(output, 'tanks-attempt.json');
  if (fs.existsSync(download)) fs.unlinkSync(download);
  report.viewports = [];
  await setup(1366, 900);
  if (noFloatCache) {
    report.byteCache = await call(viewId, function () {
      const rect = this.canvas.getBoundingClientRect();
      const samples = [[3,10],[13,3],[16,13.2]].map(([x,z]) => {
        const screen = this.worldToScreen(x,z,0);
        const pixel = new Uint8Array(4);
        this.renderer.readRenderTargetPixels(this.gradedTown,
          Math.floor((screen.x-rect.left)/rect.width*this.canvas.width),
          Math.floor((rect.bottom-screen.y)/rect.height*this.canvas.height),1,1,pixel);
        return Array.from(pixel);
      });
      return { byteTarget: this.townCache.texture.type === this.gradedTown.texture.type, samples };
    });
    assert.equal(report.byteCache.byteTarget, true, 'Optional float extensions require a byte cache fallback');
    for (const pixel of report.byteCache.samples) {
      assert.ok(pixel[0]+pixel[1]+pixel[2] > 100, 'Town disappeared without float color support');
    }
  }
  report.viewports.push(await checkViewport(1366, 900, !battleOnly && !blockout));
  if (recoveryOnly) report.recovery = await verifyRecovery();
  else if (!battleOnly) {
    await setup(1280, 720);
    report.viewports.push(await checkViewport(1280, 720));
    await setup(1366, 900);
  }
  if (!layoutOnly && !recoveryOnly) {
    trace = fs.openSync(path.join(output, 'browser-input.ndjson'), 'w');
    report.aim = await verifyAim();
    if (!battleOnly) {
      report.drives = await ordinaryDrives();
      await setup(1366, 900);
    }
    report.wallCollision = await collideTownHall();
    if (!drivesOnly) {
      await setup(1366, 900);
      await driveTo({ x: 16.4, y: 11.2 });
      await driveTo({ x: 13, y: 11.2 });
      const config = await evaluate('TankCore.CONFIG');
      const plaza = await evaluate('TownLayout.plaza');
      await runBattle(config, plaza);
      await verifyWreck();
      await verifyJournal();
    }
  }
  const errors = events.filter(event => event.method === 'Runtime.exceptionThrown' ||
    event.params.entry?.level === 'error' ||
    event.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params.type));
  const urls = events.filter(event => event.method === 'Network.requestWillBeSent').map(event => event.params.request.url);
  const external = urls.filter(url => /^https?:/i.test(url));
  report.offline = { browserOffline: true, loadedResourceUrls: [...new Set(urls)], externalRequests: external.length, pageErrors: errors.length };
  assert.deepEqual(external, [], 'HTML made external requests');
  assert.deepEqual(errors, [], 'Browser errors');
  assert.ok(bytes.equals(fs.readFileSync(source)), 'HTML changed during browser verification');
  report.inputEvents = inputEvents;
  console.log(JSON.stringify({
    result: 'passed', viewports: report.viewports.map(({ width, height, performance }) => ({ width, height, performance })),
    combat: report.combat && { kills: report.combat.final.stats.kills, wave: report.combat.wave, baseHp: report.combat.final.base.hp, frame: report.combat.capture.battleSeconds },
    sha256: report.source.sha256
  }));
}
run().catch(error => {
  report.failure = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (trace !== undefined) fs.closeSync(trace);
  const prefix = blockout ? 'blockout-' : '';
  if (fs.existsSync(output)) {
    fs.writeFileSync(path.join(output, prefix + 'browser.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, prefix + 'browser-events.json'), JSON.stringify(events, null, 2) + '\n');
    if (stderr) fs.writeFileSync(path.join(output, prefix + 'browser-stderr.txt'), stderr);
  }
  if (chrome?.pid && !exited) {
    const stopped = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await stopped;
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
