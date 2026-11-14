'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const blockout = process.argv.includes('--blockout');
const target = blockout ? 'evidence/blockout.html' : 'tanks-warm-town-3d.html';
const layout = JSON.parse(read('src/layout.json'));
const template = read('src/game.html');
const anchor = '<!-- THREE_RENDERER -->';
assert.equal(template.split(anchor).length, 2, 'Missing or duplicate renderer anchor');

function script(source) {
  return '<script>\n' + source.replace(/<\/script/gi, '<\\/script') + '\n</script>';
}

function factory(file, name) {
  const pattern = new RegExp('^export function ' + name + '\\(', 'm');
  const source = read(file);
  assert.match(source, pattern);
  return source.replace(pattern, 'function ' + name + '(');
}

const renderer = [
  'window.TownLayout = ' + JSON.stringify(layout) + ';',
  'window.Town3D = (() => {',
  'const THREE = window.THREE;',
  factory('src/town.mjs', 'buildTown'),
  read('src/units.js'),
  read('src/view.js'),
  'return Object.freeze({ View, create: options => new View(options, ' + blockout + ') });',
  '})();',
  'delete window.THREE;'
].join('\n');
const css = '<style>\n' + read('src/ui.css') + '\n</style>';
const license = '<!-- Three.js r187\n' + read('vendor/LICENSE') + '-->';
const html = template.replace('</head>', () => css + '\n</head>')
  .replace(anchor, () => [license, script(read('vendor/three-r187.js')), script(renderer)].join('\n'));
const output = path.join(__dirname, target);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(target);
