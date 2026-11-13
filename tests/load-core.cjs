'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 3, 'Expected scenario data, game simulation and browser UI scripts');

function createCore() {
  const sandbox = vm.createContext({});
  vm.runInContext(scripts[0], sandbox, { filename: 'scenarios.js' });
  vm.runInContext(scripts[1], sandbox, { filename: 'core.js' });
  return sandbox.TankCore;
}

module.exports = createCore();
