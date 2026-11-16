'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  boundsFor, normalizeStarts, packetBudget, solveWave, resourceCalendar
} = require('../tools/calibrate-maps.cjs');
const {compare} = require('../tools/verify-maps.cjs');

const group = (lane, codes) => ({
  lane, types: codes.split('').map(code => ({L:'light', M:'medium', H:'heavy'})[code])
});
const q = ticks => ({ok:true, ticks});
const fakeRun = (S, solo, extra = {}) => ({
  lane: Object.fromEntries(Object.entries(S).map(([lane, start]) => [
    lane, {firstShot: solo[lane] === null ? null : {tick: start + solo[lane] + (extra[lane] ?? 0)}}
  ]))
});
const threatPaths = [{from:'C',to:'B',mode:'U'}];

test('worked example applies the exact spec in ticks', () => {
  const groups = [group('C','MHLL'), group('B','LMLM')];
  assert.deepEqual(packetBudget(groups[0].types), {N:4, J:11, K:630});
  const T = {C:480, B:300};
  const result = solveWave(4, groups, threatPaths, {'C>B':q(180)}, T, S => fakeRun(S,T));
  assert.deepEqual(result.S, {C:0, B:1080});
  assert.deepEqual(result.F, {C:480, B:1380});
  assert.deepEqual(result.arrows.map(({L,U,G}) => [L,U,G]), [[900,960,900]]);
});

test('half-tick gaps survive cumulative H/T normalization but windows round upwards', () => {
  const groups = ['A','B','C'].map(lane => group(lane,'L'));
  const arrows = [{from:'A',to:'B',mode:'F'}, {from:'B',to:'C',mode:'F'}];
  const T = {A:50,B:50,C:50};
  const result = solveWave(8, groups, arrows, {'A>B':q(183),'B>C':q(183)}, T, S => fakeRun(S,T));
  assert.equal(result.ok, true);
  assert.deepEqual(result.initialS, {A:0, B:92, C:183});
  assert.deepEqual(result.arrows.map(({L,U,G}) => [L,U,G]), [[92,152,91.5],[92,152,91.5]]);
  assert.deepEqual(boundsFor('F', 0, 120), {G:90,L:90,U:119});
  assert.deepEqual(normalizeStarts({A:35,B:10,C:25}), {A:25,B:0,C:15});
});

test('per-arrow corrections round magnitude up to 15 and renormalize after each replay', () => {
  const groups = [group('A','L'), group('B','L')];
  const arrows = [{from:'A',to:'B',mode:'D'}];
  const T = {A:1,B:358};
  const late = solveWave(5, groups, arrows, {'A>B':q(150)}, T, S => fakeRun(S,T,{B:132}));
  assert.equal(late.ok, true);
  assert.deepEqual(late.initialS, {A:117,B:0});
  assert.deepEqual(late.S, {A:222,B:0});
  assert.equal(late.corrections[0].delta, -105);
  const early = solveWave(5, groups, arrows, {'A>B':q(150)}, T, S => fakeRun(S,T,{B:-60}));
  assert.equal(early.ok, true);
  assert.deepEqual(early.S, {A:27,B:0});
  assert.equal(early.corrections[0].delta, 90);
});

test('returns explicit missing-T and missing-F failures and rejects the W4 exception', () => {
  const groups = [group('C','MHLL'), group('B','LMLM')];
  const Q = {'C>B':q(180)};
  const noT = solveWave(4, groups, threatPaths,Q,{C:480,B:null}, () => assert.fail('must not run'));
  assert.equal(noT.reason, 'solo-shot-undefined');
  const noF = solveWave(4, groups, threatPaths,Q,{C:480,B:300}, S => fakeRun(S,{C:null,B:300}));
  assert.equal(noF.reason, 'combined-shot-undefined');
  const start = solveWave(4, groups, threatPaths,Q,{C:480,B:1400}, () => assert.fail('must not run'));
  assert.equal(start.reason,'wave-four-start-constraint');
});

test('resource calendar and totals match the all-surviving upper bound', () => {
  const waves = [
    [group('A','LMLL')], [group('A','MLMLL')], [group('C','LMLMLL')],
    [group('C','MHLL'),group('B','LMLM')], [group('B','MHLL'),group('C','LMLL')],
    [group('A','LML'),group('C','MLLL'),group('B','MLL')],
    [group('B','LHML'),group('C','MLL'),group('A','MHLL')],
    [group('A','HLMLL'),group('B','MLLL'),group('C','HLMLL')]
  ];
  const report = resourceCalendar(waves);
  assert.deepEqual(report.totalEnemies,{light:41,medium:19,heavy:6});
  assert.deepEqual(report.beforeWaves.map(({medium,heavy}) => [medium,heavy]),
    [[0,0],[1,0],[2,0],[2,0],[3,1],[2,2],[3,1],[3,2]]);
});

test('rejects the final upper cap and an empty final gap window', () => {
  const groups = [group('A','L'), group('B','L')];
  const Q = {'A>B':q(150)};
  const T = {A:5000,B:100};
  const capped = solveWave(5, groups, [{from:'A',to:'B',mode:'D'}], Q, T, S => fakeRun(S,T));
  assert.equal(capped.reason,'maximum-start-exceeded');
  assert.deepEqual(capped.S,{A:0,B:5140});
  const impossible = solveWave(8, groups, [{from:'A',to:'B',mode:'F'}], {'A>B':q(90)}, T, () => assert.fail());
  assert.equal(impossible.reason,'empty-gap-window');
});

test('stops when a normalized schedule repeats and labels the last measured F', () => {
  const groups = [group('A','L'), group('B','L')];
  const arrows = [{from:'A',to:'B',mode:'D'}];
  const T = {A:10,B:10};
  const loop = solveWave(5, groups, arrows, {'A>B':q(150)}, T, S =>
    fakeRun(S,T,{B:S.B === 240 ? -20 : 30}));
  assert.equal(loop.reason,'correction-cycle');
  assert.equal(loop.replays.length,2);
  assert.deepEqual(loop.S,{A:0,B:240});
  assert.deepEqual(loop.FMeasuredAtS,{A:0,B:300});
  assert.deepEqual(loop.F,{A:10,B:340});

  const capped = solveWave(5, groups, arrows, {'A>B':q(150)}, T, S => fakeRun(S,T,{B:220 - S.B}));
  assert.equal(capped.reason, 'correction-pass-limit');
  assert.equal(capped.corrections.length,8);
  assert.equal(capped.replays.length,9);
});

test('paired control uses only observed shots or a sufficient horizon bound', () => {
  const scene = (tick, observedTicks = 7200) => ({
    firstBaseShot:tick === null ? null : {tick}, horizonTicks:7200, observedTicks
  });
  assert.equal(compare(scene(100),scene(189)).passed,false);
  assert.equal(compare(scene(100),scene(190)).exactTicks,90);
  assert.equal(compare(scene(7100),scene(null)).lowerBoundTicks,100);
  assert.equal(compare(scene(7111),scene(null)).passed,false);
  assert.equal(compare(scene(7100),scene(null,7150)).passed,false);
  assert.equal(compare(scene(null),scene(null)).passed,false);
});
