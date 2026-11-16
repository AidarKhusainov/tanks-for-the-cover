'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./load-core.cjs');
const createScene = require('../tools/playtest-scene.cjs');

for (const mapId of ['magnetic', 'city']) {
  test(`${mapId}: placement comparison has a labelled two-wave start and real map return`, () => {
    const game = createScene(core, 'placement', mapId);
    assert.equal(game.config.mapId, mapId);
    assert.equal(game.config.controlScene.kind, 'placement');
    assert.equal(game.config.controlScene.diagnostic, true);
    assert.equal(game.config.WAVES.length, 2);
    assert.equal(game.base.hp, 240);
    assert.equal(game.player.hp, 60);
    assert.equal(game.player.module, null);
    assert.equal(game.wrecks.length, 0);
    assert.equal(game.phase, 'prep');
    assert.deepEqual(game.config.PLAYER_START, core.MAP_CONFIGS[mapId].PLAYER_START);
    const record = JSON.parse(game.exportAttemptLog());
    assert.equal(record.configuration.game.controlScene.kind, 'placement');
    assert.ok(record.events.some(event => event.type === 'control_scene'));
  });

  test(`${mapId}: death comparison pauses a real aimed shot and returns through the normal rule`, () => {
    const game = createScene(core, 'death', mapId);
    assert.equal(game.config.mapId, mapId);
    assert.equal(game.player.hp, 20);
    assert.equal(game.player.alive, true);
    assert.equal(game.base.hp, 240);
    assert.equal(game.paused, true);
    const heavy = game.enemies.find(enemy => enemy.type === 'heavy');
    const shot = game.bullets.find(bullet => bullet.ownerId === heavy?.id);
    assert.ok(shot, 'The heavy must actually fire');
    assert.equal(game._firstCollision(shot.x, shot.y,
      shot.x + shot.dx * shot.remaining, shot.y + shot.dy * shot.remaining, shot.ownerId)?.kind, 'player');
    game.paused = false;
    let diedAt = null, returnedAt = null;
    for (let tick = 1; tick <= 360; tick++) {
      game.update(1 / 60, {});
      if (!game.player.alive && diedAt === null) diedAt = tick;
      if (diedAt !== null && game.player.alive) { returnedAt = tick; break; }
    }
    assert.ok(diedAt !== null && returnedAt !== null);
    assert.ok(Math.abs(returnedAt - diedAt - 240) <= 1);
    assert.equal(game.player.hp, 60);
    assert.equal(game.player.module, null);
    assert.equal(game.player.x, game.config.PLAYER_START.x);
    assert.equal(game.player.y, game.config.PLAYER_START.y);
    assert.equal(game.phase, 'battle', 'Delayed threats keep the whole return observable');
  });
}

test('scene builder patches the current UI and rejects unknown scenario/map', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const rendered = createScene.renderSceneHtml(html, 'death', 'city');
  assert.match(rendered, /game\.paused = false; pause\(\);/);
  assert.doesNotMatch(rendered, /configureMapView\(\);\s+showMapPicker\(\);\s+requestAnimationFrame/);
  assert.throws(() => createScene(core, 'unknown', 'city'));
  assert.throws(() => createScene(core, 'placement', 'unknown'));
});
