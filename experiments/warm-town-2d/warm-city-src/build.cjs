'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { walls, spawns, city } = require('./map.cjs');

const lab = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const blockout = process.argv.includes('--blockout');
let html = read('../tanks-twin-gates.html');
function replaceOnce(pattern, replacement) {
  assert.equal([...html.matchAll(new RegExp(pattern.source, 'g'))].length, 1, String(pattern));
  html = html.replace(pattern, () => replacement);
}

replaceOnce(/mapId:'twin-gates-open',[\s\S]*?(?=    WAVES:\[)/, `mapId:'warm-town', AI_MODE:'roles', SPAWN_INTERVAL:2.5,\n    WALLS:${JSON.stringify(walls, null, 2)},\n    SPAWNS:${JSON.stringify(spawns)},\n`);
replaceOnce(/    ROADS:\[\{"width":1\.4,[\s\S]*?\n    AREAS:[^\n]+/, `    ROADS:[], AREAS:[], CITY:${JSON.stringify(city)}`);
replaceOnce(/<title>[^<]*<\/title>/, '<title>Танчики — Тёплый обжитой город</title>');
replaceOnce(/<h1>Двойные ворота<\/h1>/, '<h1>Тёплый обжитой город</h1>');
replaceOnce(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Тёплый обжитой город. Отдельная офлайн-карта Танчиков на восемь волн.">');
replaceOnce(/prototype-06-map-lab-twin-gates-open-1/, `prototype-06-map-lab-warm-town-${blockout ? 1 : 3}`);
replaceOnce(/download="tanks-twin-gates.html"/, 'download="tanks-warm-town.html"');
replaceOnce(/id="routes" type="checkbox" aria-describedby="route-note" checked/, 'id="routes" type="checkbox" aria-describedby="route-note"');
replaceOnce(/  let terrainSeed = 404;[\s\S]*?(?=  function toast\()/, '');
html = html.replaceAll('Используй руины, чтобы разделить угрозы.', 'Используй кварталы, чтобы разделить угрозы.')
  .replaceAll('Разорви видимость у руин', 'Скройся за кварталом');

replaceOnce(/  function paintGround\(c\)\s*\{[\s\S]*?(?=  function drawGround\(\))/, read(blockout ? 'blockout.js' : 'renderer.js'));
replaceOnce(/  function paintCover\(c,w\)\{[\s\S]*?(?=  function drawReturnPoint\(\))/, '');
replaceOnce(/mapLayer\(c=>\{for\(const w of CONFIG.WALLS\)paintCover\(c,w\);\}\)/, 'mapLayer(paintCityCover)');
replaceOnce(/<\/style>/, `${read('theme.css')}\n</style>`);

if (!blockout) {
  replaceOnce(/<\/style>/, `.wave-card .result-grid{gap:6px;padding:5px 0 0;border:0}
.wave-card .result-grid span{display:block;font-size:8px;line-height:1.3}
</style>`);
  replaceOnce(/<div class="tactical-note">/, '<div class="tactical-note" id="tactical-note">');
  replaceOnce(/el\('player-value'\)\.innerHTML=game\.player\.alive\?[^\n]+/, `if (game.player.alive) el('player-value').innerHTML = \`\${playerHp} <small>/ \${game.player.maxHp}</small>\`;
    else if (finished) el('player-value').textContent = 'Уничтожен';
    else el('player-value').innerHTML = \`<small>Возврат</small> \${Math.ceil(game.player.respawn)}с\`;`);
  replaceOnce(/      el\('wave-card-title'\)[\s\S]*?(?=      el\('salvage-actions'\))/, `      updateWaveCard({ prep, finished, baseHp });
      el('phase-copy').hidden = finished;
      el('salvage-content').hidden = finished;
      el('undo').hidden = finished;
      el('tactical-note').hidden = finished;
      if (finished) {
        showActionReason('undo-reason', null);
        el('toast').classList.remove('show');
        el('toast').textContent = '';
        toastUntil = 0;
      }
`);
  replaceOnce(/  function updateUi\(\)\{/, read('attempt-result.js') + '\n  function updateUi(){');
  replaceOnce(/finished\?\(game\.phase==='won'\?'База уцелела':'Попробуй ещё'\)/, "finished?(game.phase==='won'?'База уцелела':'База потеряна')");
  replaceOnce(/toast\('Танк потерян\. Возвращение через 4 секунды\.',3\);/, `if (game.phase === 'battle' || game.phase === 'settling') {
          toast('Танк потерян. Возвращение через 4 секунды.',3);
        }`);
  replaceOnce(/<div class="result-grid"><div><strong>\$\{game\.stats\.kills\}[\s\S]*?HP БАЗЫ<\/span><\/div><\/div>/, '${attemptResultGrid(baseHp)}');
  replaceOnce(/    unitLabels\.push\(\{actor:w,label:`[^\n]+ · до \$\{w\.expiresAfterWave\}\$\{role\}`\}\);/, `    const lifetime = game.phase === 'won' || game.phase === 'lost' ? '' : \` · до \${w.expiresAfterWave}\`;
    unitLabels.push({actor:w,label:\`\${look.mark}\${w.reinforced?' ↑':''} · \${Math.ceil(w.hp)} HP\${lifetime}\${role}\`});`);
  const materials = fs.readFileSync(path.join(__dirname, 'art/materials.webp')).toString('base64');
  replaceOnce(/  let groundLayer, coverLayer;/, `  const cityMaterials = new Image();\n  cityMaterials.src = 'data:image/webp;base64,${materials}';\n  let groundLayer, coverLayer;`);
  replaceOnce(/  function drawBase\(b\)\{[\s\S]*?(?=  const cityMaterials)/, read('base.js') + '\n');
  replaceOnce(/  function pieceShadow\(x,y,r\)\{[\s\S]*?(?=  function drawWreck\(w\))/, read('vehicles.js') + '\n');
  replaceOnce(/tankModel\(t,player,body,ang,player\?\{dark:'#224956',main:'#3c91ac',top:'#9ae1ed'\}:look\);/, 'tankModel(t,player,body,ang);');
  replaceOnce(/  requestAnimationFrame\(frame\);\n\}\)\(\);/, `  cityMaterials.decode().then(() => {
    canvas.dataset.artReady = 'true';
    requestAnimationFrame(frame);
  }).catch(() => toast('Не удалось загрузить оформление города. Откройте HTML в актуальном браузере.'));
})();`);
}

if (process.argv.includes('--stdout')) {
  process.stdout.write(html);
  return;
}

const output = path.join(lab, blockout ? 'evidence/warm-town/blockout.html' : 'tanks-warm-town.html');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(output);
