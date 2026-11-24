'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, MAP_CONFIGS, createEditorMap } = require('./load-core.cjs');

const draft = () => ({
  format: 'tanks-map-editor', version: 1, width: 28, height: 18,
  objects: [
    { id: 's', type: 'spawn', name: 'Спавн', x: 1.5, y: 2, w: 1.5, h: 1.5 },
    { id: 'b', type: 'base', name: 'База', x: 23, y: 13, w: 2, h: 2 },
    { id: 'p', type: 'player', name: 'Игрок', x: 20, y: 10, w: 1, h: 1 },
    { id: 'w', type: 'wall', name: 'Стена', x: 10, y: 5, w: 2, h: 4 }
  ]
});
const plain = value => JSON.parse(JSON.stringify(value));

test('editor rectangles become the actual game geometry, with centered player and spawn', () => {
  const selectableMaps = Object.keys(MAP_CONFIGS);
  const input = draft();
  const config = createEditorMap(input);
  const game = new Game(config);
  assert.deepEqual([game.player.x, game.player.y], [20.5, 10.5]);
  assert.deepEqual([game.base.x, game.base.y, game.base.w, game.base.h], [24, 14, 2, 2]);
  assert.deepEqual(plain(config.SPAWNS.A), { x: 2.25, y: 2.75, w: 1.5, h: 1.5, direction: 'right' });
  assert.equal(game._positionFree(11, 6, game.player, true), false);
  assert.equal(game._firstCollision(8, 6, 14, 6, 'player').kind, 'wall');
  assert.equal(game.getPreviewPaths({ type: 'medium' })[0].decision, 'detour');
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.WALLS[0]));
  input.objects[0].x = 15;
  input.objects[3].x = 1;
  assert.equal(config.SPAWNS.A.x, 2.25);
  assert.equal(config.WALLS[0].x, 10);
  assert.equal(config.editorDraft.objects[0].x, 1.5);
  assert.deepEqual(Object.keys(MAP_CONFIGS), selectableMaps, 'import leaves the built-in list intact');
});

test('a custom map runs the existing eight-wave campaign through its one spawn', () => {
  const game = new Game(createEditorMap(draft()));
  assert.equal(game.config.WAVES.length, 8);
  assert.equal(game.config.WAVES.flat().reduce((count, group) => count + group.types.length, 0), 66);
  assert.ok(game.config.WAVES.flat().every(group => group.lane === 'A'));
  assert.equal(game.config.SPAWN_INTERVAL, 2.5);
  assert.equal(game.startWave(), true);
  game.update(1 / 60);
  assert.equal(game.enemies.length, 1);
  assert.equal(game.enemies[0].lane, 'A');
  assert.ok(Math.hypot(game.enemies[0].x - 2.25, game.enemies[0].y - 2.75) < .1);
  assert.equal(JSON.parse(game.exportAttemptLog()).configuration.game.mapId, 'editor');
});

test('a custom player returns near its start when a tank occupies the preferred position', () => {
  const game = new Game(createEditorMap(draft()));
  game.enemies.push({ id: 'blocker', x: 20.5, y: 10.5, r: .5, hp: 60 });
  Object.assign(game.player, { alive: false, respawn: 0 });
  game._updateRespawn(0);
  assert.equal(game.player.alive, true);
  assert.ok(Math.hypot(game.player.x - 20.5, game.player.y - 10.5) >= 1);
  assert.ok(Math.hypot(game.player.x - 20.5, game.player.y - 10.5) < 3);
  assert.equal(game._positionFree(game.player.x, game.player.y, game.player, true), true);
});

for (const [name, mutate] of [
  ['unknown format', m => { m.format = 'other'; }],
  ['unknown version', m => { m.version = 2; }],
  ['wrong dimensions', m => { m.width = 30; }],
  ['missing objects', m => { delete m.objects; }],
  ['too many objects', m => { m.objects = Array(301).fill(m.objects[3]); }],
  ['unknown object', m => { m.objects[3].type = 'script'; }],
  ['duplicate ID', m => { m.objects[3].id = 'p'; }],
  ['missing base', m => { m.objects.splice(1, 1); }],
  ['multiple spawns', m => { m.objects.push({ ...m.objects[0], id: 's2', x: 4 }); }],
  ['non-finite coordinate', m => { m.objects[0].x = Infinity; }],
  ['numeric string', m => { m.objects[0].x = '2'; }],
  ['zero width', m => { m.objects[3].w = 0; }],
  ['outside board', m => { m.objects[3].x = 27; }],
  ['resized player', m => { m.objects[2].w = 2; }],
  ['small spawn', m => { m.objects[0].w = .25; }],
  ['overlapping player', m => { m.objects[2].x = 10; m.objects[2].y = 5; }],
  ['overlapping base', m => { m.objects[1].x = 10; m.objects[1].y = 5; }],
  ['null object', m => { m.objects[3] = null; }]
]) {
  test(`invalid editor map is rejected: ${name}`, () => {
    assert.equal(typeof createEditorMap, 'function', 'map adapter is available');
    const input = draft();
    mutate(input);
    assert.throws(() => createEditorMap(input), /./);
  });
}

test('a sealed spawn is rejected instead of starting an unwinnable test', () => {
  const input = draft();
  input.objects.push(
    { id: 'top', type: 'wall', name: 'Верх', x: 0, y: .5, w: 4.5, h: .5 },
    { id: 'bottom', type: 'wall', name: 'Низ', x: 0, y: 4.5, w: 4.5, h: .5 },
    { id: 'right', type: 'wall', name: 'Справа', x: 4.5, y: .5, w: .5, h: 4.5 }
  );
  assert.equal(typeof createEditorMap, 'function', 'map adapter is available');
  assert.throws(() => createEditorMap(input), /пут|баз|недостиж/i);
});
