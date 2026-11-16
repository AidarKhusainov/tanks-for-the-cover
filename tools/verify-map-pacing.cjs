'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {boundsFor, loadCore, measureCombined, measureRoute, packetBudget, parsePace} =
  require('./calibrate-maps.cjs');

const TICKS_PER_SECOND = 60;

function verifyPacing(core, mapId) {
  const config = core.MAP_CONFIGS[mapId];
  assert.equal(config.WAVES.length, 8, `Expected eight waves on ${mapId}`);
  const positions = Object.fromEntries(Object.entries(config.TACTICS).map(([lane, tactic]) => [lane, tactic.position]));
  const routes = {};
  const waves = config.WAVES.map((groups, index) => {
    const starts = Object.fromEntries(groups.map(({lane, start}) => {
      const ticks = start * TICKS_PER_SECOND;
      const rounded = Math.round(ticks);
      assert(Number.isSafeInteger(rounded) && rounded >= 0 && Math.abs(ticks - rounded) < 1e-8,
        `Expected a nonnegative whole-tick start for ${mapId}, wave ${index + 1}, lane ${lane}`);
      return [lane, rounded];
    }));
    const observation = measureCombined(core, config, index, starts);
    const transitions = parsePace(mapId, index).map(({from, to, mode}) => {
      const key = `${from}>${to}`;
      const route = routes[key] ??= measureRoute(core, config, positions, config.TRAVEL_ROUTES, from, to);
      const {K} = packetBudget(groups.find(group => group.lane === from).types);
      const bounds = route.ok ? boundsFor(mode, K, route.ticks) : {G:null, L:null, U:null};
      const fromShot = observation.lane[from].firstShot;
      const toShot = observation.lane[to].firstShot;
      const gap = fromShot && toShot ? toShot.tick - fromShot.tick : null;
      const inWindow = route.ok && gap !== null && gap >= bounds.L && gap <= bounds.U;
      return {from, to, mode, routeOk:route.ok, Qticks:route.ticks, budgetTicks:K, ...bounds, gap, inWindow};
    });
    const passed = observation.complete && transitions.every(transition => transition.inWindow);
    return {wave:index + 1, starts, observation, transitions, passed};
  });
  return {mapVersion:config.mapVersion, routes, waves, passed:waves.every(wave => wave.passed)};
}

function main() {
  const [html, output, extra] = process.argv.slice(2);
  assert(html && output && extra === undefined, 'Usage: node tools/verify-map-pacing.cjs <index.html> <report.json>');
  assert.notEqual(path.resolve(html), path.resolve(output), 'The report path must differ from the HTML path');
  const {core, htmlSha256} = loadCore(html);
  const maps = Object.fromEntries(['magnetic', 'city'].map(mapId => [mapId, verifyPacing(core, mapId)]));
  const report = {
    schemaVersion:1,
    mode:'diagnostic-configured-pacing',
    source:{html:path.resolve(html), htmlSha256},
    ticksPerSecond:TICKS_PER_SECOND,
    rules:'Absent player, suppressed respawn, no wrecks, base HP held after observed contact.',
    maps,
    passed:Object.values(maps).every(map => map.passed)
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 2;
}

main();
