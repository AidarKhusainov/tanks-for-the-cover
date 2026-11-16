'use strict';

const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function createScene({ Game, MAP_CONFIGS }, scene, mapId = 'magnetic') {
  if (!['placement', 'death'].includes(scene)) throw new Error('Unknown control scene');
  const config = MAP_CONFIGS[mapId];
  if (!config) throw new Error('Unknown map');
  const placement = scene === 'placement';
  const game = new Game({
    ...config,
    controlScene: { kind: scene, diagnostic: true, version: 2 },
    mapName: `${config.mapName} · ${placement ? 'размещение корпуса' : 'цена гибели'}`,
    WAVES: [
      [
        { start: 0, lane: 'A', types: ['heavy'] },
        { start: placement ? 10 : 12, lane: 'A', types: ['medium'] },
        { start: placement ? 11 : 12, lane: 'C', types: ['light'] }
      ],
      [{ start: 0, lane: 'A', types: ['medium'] }]
    ]
  });
  // A labelled diagnostic start; the ordinary return configuration stays intact.
  Object.assign(game.player, config.TACTICS.A.position);
  if (!placement) {
    // Use the real enemy target selection, firing and projectile integration.
    game.startWave();
    let shot;
    for (let tick = 0; tick < 600 && !shot; tick++) {
      game.update(1 / 60, {});
      const heavy = game.enemies.find(enemy => enemy.type === 'heavy');
      shot = game.bullets.find(bullet => bullet.ownerId === heavy?.id && bullet.damage === 20 &&
        game._firstCollision(bullet.x, bullet.y, bullet.x + bullet.dx * bullet.remaining,
          bullet.y + bullet.dy * bullet.remaining, bullet.ownerId)?.kind === 'player');
    }
    if (!shot || game.base.hp !== 240 || !game.player.alive) {
      throw new Error('Expected the heavy tank to have fired a projectile at the player');
    }
    game.player.hp = 20;
    game.paused = true;
  }
  game._recordAttempt('control_scene', {
    diagnostic: true, kind: scene, mapId,
    player: { ...game.player }, baseHp: game.base.hp,
    note: 'Synthetic comparison start; this is not an ordinary campaign.'
  });
  return game;
}

function renderSceneHtml(html, scene, mapId = 'magnetic') {
  assert.ok(['placement', 'death'].includes(scene), 'Unknown control scene');
  assert.ok(['magnetic', 'city'].includes(mapId), 'Unknown map');
  const entry = 'let game = new Game(MAP_CONFIGS.magnetic);';
  const startup = 'configureMapView();\n  showMapPicker();\n  requestAnimationFrame(frame);';
  assert.equal(html.split(entry).length, 2, 'Expected a single UI game constructor');
  assert.equal(html.split(startup).length, 2, 'Expected the map-selection startup');
  const boot = `let game = (${createScene})(globalThis.TankCore, ${JSON.stringify(scene)}, ${JSON.stringify(mapId)});`;
  const startPaused = scene === 'death' ? 'game.paused = false; pause();\n  ' : '';
  return html.replace(entry, boot).replace(startup,
    `configureMapView();\n  ${startPaused}requestAnimationFrame(frame);`);
}

if (require.main === module) {
  const [, , scene, output, mapId = 'magnetic', extra] = process.argv;
  if (!['placement', 'death'].includes(scene) || !['magnetic', 'city'].includes(mapId) || !output || extra) {
    process.stderr.write('Usage: node tools/playtest-scene.cjs placement|death /path/to/new-scene.html [magnetic|city]\n');
    process.exitCode = 1;
  } else {
    const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const sceneHtml = renderSceneHtml(html, scene, mapId);
    writeFileSync(output, sceneHtml, { flag: 'wx' });
  }
}

module.exports = createScene;
module.exports.renderSceneHtml = renderSceneHtml;
