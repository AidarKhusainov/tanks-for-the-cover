'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const context = vm.createContext({});
vm.runInContext(scripts[0], context);
vm.runInContext(scripts[1], context);
const output = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'docs', 'maps'));
fs.mkdirSync(output, { recursive: true });

for (const config of Object.values(context.TankCore.MAP_CONFIGS)) {
  const colors = { A: '#a75124', B: '#146f67', C: '#7542a3' };
  const parts = [];
  const rectangle = (rect, attributes) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" ${attributes}/>`;
  const line = (points, attributes) => `<polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" ${attributes}/>`;
  const label = (x, y, text, attributes = '') => `<text x="${x}" y="${y}" ${attributes}>${text}</text>`;
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 896 684" role="img" aria-labelledby="title description"><title id="title">${config.mapName}: пути и позиции</title><desc id="description">Координатная схема ${config.mapId} версии ${config.mapVersion}. Сплошные линии — короткие пути, пунктир — обходы, круги — опорные корпуса, P — позиции измерения, R — возвращение. Это схема возможных путей, не обещание маршрута ИИ.</desc><style>text{font-family:DejaVu Sans,sans-serif;fill:#163438} .map-label{font-size:.42px;font-weight:bold;paint-order:stroke;stroke:#fffaf1;stroke-width:.08px;stroke-linejoin:round}</style><rect width="896" height="684" fill="#faf7ed"/>`);
  parts.push(label(28, 32, config.mapName, 'font-size="22" font-weight="bold"'));
  parts.push(label(28, 55, `${config.mapId} · версия ${config.mapVersion} · координаты игрового поля`, 'font-size="13"'));
  parts.push('<g transform="translate(28 75) scale(30)">');
  parts.push(`<rect width="${config.W}" height="${config.H}" fill="${config.mapId === 'magnetic' ? '#e1eeea' : '#eee5d5'}" stroke="#73918a" stroke-width=".03"/>`);
  for (let x = 1; x < config.W; x++) parts.push(`<path d="M${x},0V${config.H}" stroke="#adc1b9" stroke-width=".015"/>`);
  for (let y = 1; y < config.H; y++) parts.push(`<path d="M0,${y}H${config.W}" stroke="#adc1b9" stroke-width=".015"/>`);
  for (const wall of config.WALLS) parts.push(rectangle(wall, `fill="${wall.kind === 'bunker' ? '#45656b' : config.mapId === 'magnetic' ? '#699d9a' : '#bc836b'}" stroke="#45656b" stroke-width=".04"`));
  for (const [lane, tactical] of Object.entries(config.TACTICS)) {
    const color = colors[lane];
    parts.push(line(tactical.bypass, `stroke="${color}" stroke-width=".075" stroke-dasharray=".23 .16"`));
    if (tactical.outerBypass) parts.push(line(tactical.outerBypass, `stroke="${color}" stroke-width=".075" stroke-dasharray=".23 .16"`));
    parts.push(line(tactical.shortPath, `stroke="${color}" stroke-width=".10"`));
    for (const area of tactical.usefulAreas) parts.push(rectangle(area, `fill="${color}" fill-opacity=".17" stroke="${color}" stroke-width=".05"`));
    for (const blocker of tactical.blockers) parts.push(`<circle cx="${blocker.x}" cy="${blocker.y}" r=".5" fill="#707b7d" fill-opacity=".8" stroke="#fffaf1" stroke-width=".05"/>`);
    const p = tactical.position;
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r=".18" fill="${color}"/>`);
    parts.push(label(p.x + .25, p.y - .25, `P_${lane}`, 'class="map-label"'));
  }
  for (const [lane, spawn] of Object.entries(config.SPAWNS)) {
    parts.push(rectangle({ x: spawn.x - spawn.w / 2, y: spawn.y - spawn.h / 2, w: spawn.w, h: spawn.h }, `fill="${colors[lane]}" fill-opacity=".18" stroke="${colors[lane]}" stroke-dasharray=".15 .10" stroke-width=".05"`));
    parts.push(label(spawn.x, spawn.y + .16, lane, 'class="map-label" text-anchor="middle"'));
  }
  parts.push(rectangle(config.BASE_RECT, 'fill="#e8bf4e" stroke="#725b27" stroke-width=".07"'));
  parts.push(label(config.BASE_RECT.x + config.BASE_RECT.w / 2, config.BASE_RECT.y + 1.05, 'БАЗА', 'class="map-label" text-anchor="middle"'));
  parts.push(`<circle cx="${config.PLAYER_START.x}" cy="${config.PLAYER_START.y}" r=".25" fill="#fffaf1"/>`);
  parts.push(label(config.PLAYER_START.x, config.PLAYER_START.y + .13, 'R', 'class="map-label" text-anchor="middle"'));
  parts.push('</g>');
  parts.push(label(28, 636, 'Сплошная линия: короткий путь · Пунктир: обход · Серый круг: корпус', 'font-size="13"'));
  parts.push(label(28, 660, 'P: позиция измерения · R: возвращение · Противник выбирает обход или пролом по ситуации', 'font-size="13"'));
  parts.push('</svg>');
  fs.writeFileSync(path.join(output, `${config.mapId}.svg`), parts.join('\n') + '\n');
}
