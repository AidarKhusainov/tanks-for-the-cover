'use strict';

const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function createScene({ Game, CONFIG }, scene) {
  const placement = scene === 'placement';
  const game = new Game({
    ...CONFIG,
    WAVES: [
      [
        { start: 0, lane: 'A', types: ['heavy'] },
        { start: placement ? 10 : 12, lane: 'A', types: ['medium'] },
        { start: placement ? 11 : 12, lane: 'B', types: ['light'] }
      ],
      [{ start: 0, lane: 'A', types: ['medium'] }]
    ]
  });
  Object.assign(game.player, placement ? { x: 7, y: 7.4 } : { x: 3, y: 6.5 });
  if (!placement) {
    // Use the real enemy target selection, firing and projectile integration.
    game.startWave();
    game.update(1 / 60);
    const heavy = game.enemies.find(enemy => enemy.type === 'heavy');
    const shot = game.bullets.find(bullet => bullet.ownerId === heavy?.id && bullet.damage === 20);
    if (!shot || game._firstCollision(shot.x, shot.y,
      shot.x + shot.dx * shot.remaining, shot.y + shot.dy * shot.remaining, shot.ownerId)?.kind !== 'player') {
      throw new Error('Expected the heavy tank to have fired a projectile at the player');
    }
    game.player.hp = 20;
    game.paused = true;
  }
  return game;
}

if (require.main === module) {
  const [, , scene, output] = process.argv;
  if (!['placement', 'death'].includes(scene) || !output) {
    process.stderr.write('Usage: node tools/playtest-scene.cjs placement|death /path/to/new-scene.html\n');
    process.exitCode = 1;
  } else {
    const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const entry = 'const game = new Game();';
    assert.equal(html.split(entry).length, 2, 'Expected a single UI game constructor');
    const boot = `const game = (${createScene})(globalThis.TankCore, ${JSON.stringify(scene)});`;
    const startPaused = scene === 'death' ? 'game.paused = false; pause();\n  ' : '';
    const sceneHtml = html.replace(entry, boot).replace('requestAnimationFrame(frame);\n})();',
      `${startPaused}requestAnimationFrame(frame);\n})();`);
    writeFileSync(output, sceneHtml, { flag: 'wx' });
  }
}

module.exports = createScene;
