'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../tools/map-editor.html'), 'utf8');
const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const sandbox = vm.createContext({ URLSearchParams });
if (scripts.length > 1) vm.runInContext(scripts[0][1], sandbox);
const api = sandbox.TankEditorDraft ?? {};
const key = 'tanks-map-editor-draft-v1';
const draft = x => ({ format: 'tanks-map-editor', version: 1, width: 28, height: 18, objects: [
  { id: 'wall', type: 'wall', name: 'Стена «тест»', x, y: 4, w: 2, h: 1 }
] });
const plain = value => JSON.parse(JSON.stringify(value));
const memory = text => {
  const values = new Map(text ? [[key, text]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('editor test links carry a Unicode geometry snapshot without browser storage', () => {
  assert.equal(typeof api.fragment, 'function', 'editor draft helpers are available');
  const fragment = api.fragment(draft(3.25));
  const loaded = api.load(fragment, null);
  assert.deepEqual(plain(loaded.draft), draft(3.25));
});

test('editor saves a changed draft and restores it after reload', () => {
  assert.equal(typeof api.save, 'function', 'editor draft helpers are available');
  const storage = memory();
  assert.equal(api.save(storage, draft(6.5)), true);
  assert.deepEqual(plain(api.load('', storage).draft), draft(6.5));
});

test('returning from an older game keeps the newer saved editor draft', () => {
  assert.equal(typeof api.load, 'function', 'editor draft helpers are available');
  const storage = memory(JSON.stringify(draft(9)));
  assert.deepEqual(plain(api.load(api.fragment(draft(3)) + '&resume=1', storage).draft), draft(9));
  assert.deepEqual(plain(api.load(api.fragment(draft(3)), storage).draft), draft(3));
});

test('storage denial leaves the game-to-editor snapshot available', () => {
  assert.equal(typeof api.load, 'function', 'editor draft helpers are available');
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.equal(api.save(denied, draft(2)), false);
  assert.deepEqual(plain(api.load(api.fragment(draft(7)) + '&resume=1', denied).draft), draft(7));
});

test('broken map links retain a valid stored draft and report the bad link', () => {
  assert.equal(typeof api.load, 'function', 'editor draft helpers are available');
  const result = api.load('#map=%7Bbroken', memory(JSON.stringify(draft(8))));
  assert.deepEqual(plain(result.draft), draft(8));
  assert.ok(result.notice.length > 0);
});

test('broken saved drafts fall back without throwing and report recovery', () => {
  assert.equal(typeof api.load, 'function', 'editor draft helpers are available');
  const result = api.load('', memory('{broken'));
  assert.equal(result.draft, null);
  assert.ok(result.notice.length > 0);
});

test('JSON imports reject malicious structure and discard unrelated properties', () => {
  assert.equal(typeof api.parse, 'function', 'editor draft helpers are available');
  assert.throws(() => api.parse(JSON.stringify({ ...draft(1), objects: [null] })));
  assert.throws(() => api.parse(JSON.stringify({ ...draft(1), version: 2 })));
  const duplicate = draft(1);
  duplicate.objects.push({ ...duplicate.objects[0] });
  assert.throws(() => api.parse(JSON.stringify(duplicate)));
  const input = draft(2);
  input.executable = '<script>alert(1)</script>';
  input.objects[0].onclick = 'alert(1)';
  assert.deepEqual(plain(api.parse(JSON.stringify(input))), draft(2));
});

test('adding or duplicating at the object limit preserves the last reloadable draft', () => {
  assert.equal(typeof api.append, 'function', 'editor additions enforce the import limits');
  const input = draft(2);
  input.objects = Array.from({ length: 300 }, (_, i) => ({ ...input.objects[0], id: `wall-${i}` }));
  const storage = memory();
  assert.equal(api.save(storage, input), true);
  assert.throws(() => api.append(input, { ...input.objects[0], id: 'extra' }), /300/);
  assert.equal(input.objects.length, 300);
  assert.deepEqual(plain(api.load('', storage).draft), input);
});

test('duplicating the longest imported name keeps the result reloadable', () => {
  assert.equal(typeof api.append, 'function', 'editor additions enforce the import limits');
  const input = draft(2);
  input.objects[0].name = 'Я'.repeat(100);
  const result = api.append(input, { ...input.objects[0], id: 'copy', name: input.objects[0].name + ' (копия)' });
  const storage = memory();
  assert.equal(api.save(storage, result), true);
  assert.equal(api.load('', storage).draft.objects.length, 2);
  assert.ok(api.load('', storage).draft.objects[1].name.length <= 100);
});

test('autosave never overwrites a reloadable draft with structurally invalid state', () => {
  const storage = memory(JSON.stringify(draft(9)));
  const invalid = draft(2);
  invalid.objects = Array(301).fill(invalid.objects[0]);
  assert.equal(api.save(storage, invalid), false);
  assert.deepEqual(plain(api.load('', storage).draft), draft(9));
});

test('every schema-sized draft can be exported with indentation and imported again', () => {
  const input = draft(2);
  input.objects = Array.from({length:300}, (_, i) => ({
    ...input.objects[0], id:'"'.repeat(96)+String(i).padStart(4,'0'), name:'"'.repeat(100)
  }));
  const exported = JSON.stringify(input,null,2);
  assert.ok(exported.length > 150000, 'fixture crosses the previous inconsistent text cap');
  assert.deepEqual(plain(api.parse(exported)),input);
  const storage = memory();
  assert.equal(api.save(storage,input),true);
  assert.deepEqual(plain(api.load(api.fragment(input),storage).draft),input);
});

test('a failed autosave returns the test snapshot instead of an older readable stored draft', () => {
  const storage = { getItem: () => JSON.stringify(draft(1)), setItem() { throw Error('quota'); } };
  const saved = api.save(storage, draft(8));
  const link = api.fragment(draft(8), saved);
  assert.deepEqual(plain(api.load(link, storage).draft), draft(8));
  const goodStorage = memory();
  const goodSave = api.save(goodStorage, draft(6));
  assert.equal(new URLSearchParams(api.fragment(draft(6), goodSave).slice(1)).get('resume'), '1');
});

function validateEditorGeometry(model) {
  const ui = scripts.at(-1)[1];
  const geometry = ui.slice(ui.indexOf('function walkable'), ui.indexOf('function render'));
  return vm.runInNewContext(
    'const WIDTH=28,HEIGHT=18,RADIUS=.5,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));' + geometry + ';validate()', {model});
}

for (const [axis, edge] of [['x', 28], ['y', 18]]) {
  test(`editor and game agree on the ${axis} field boundary for fractional wall positions`, () => {
    const { createEditorMap } = require('./load-core.cjs');
    const model = draft(4);
    model.objects.push(
      { id:'s', type:'spawn', name:'Спавн', x:1, y:1, w:1, h:1 },
      { id:'b', type:'base', name:'База', x:20, y:12, w:2, h:2 },
      { id:'p', type:'player', name:'Игрок', x:18, y:11, w:1, h:1 }
    );
    const wall = model.objects[0];
    const size = axis === 'x' ? wall.w : wall.h;
    for (const [excess, allowed] of [[0, true], [5e-8, true], [2e-7, false], [0.0005, false]]) {
      wall[axis] = edge - size + excess;
      const { problems } = validateEditorGeometry(model);
      if (allowed) {
        assert.doesNotThrow(() => createEditorMap(model));
        assert.equal(problems.length, 0, `editor blocks an accepted edge at +${excess}`);
      } else {
        assert.throws(() => createEditorMap(model), /границ/);
        assert.ok(problems.some(message => message.includes('границ')), `editor allows an overrun of ${excess}`);
      }
    }
  });
}

test('a narrow firing slit is a route warning and does not prohibit testing a playable map', () => {
  const model = { format:'tanks-map-editor', version:1, width:28, height:18, objects:[
    ['s','spawn',6.5,8.5,1,1], ['b','base',12,8.5,1,1], ['p','player',18,8,1,1],
    ['t','wall',10,0,1,8.75], ['d','wall',10,9.25,1,8.75]
  ].map(([id,type,x,y,w,h]) => ({id,name:id,type,x,y,w,h})) };
  const result = validateEditorGeometry(model);
  assert.equal(result.problems.length, 0);
  assert.ok(result.route.error);
  const { Game, createEditorMap } = require('./load-core.cjs');
  assert.equal(new Game(createEditorMap(model)).getPreviewPaths({type:'medium'})[0].decision, 'detour');
});

test('a game-imported map returns to its own editor snapshot, while saved editor launches can resume newer work', () => {
  const gameSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const functions = ['updateEditorLinks', 'loadEditorText'].map(name => {
    const match = gameSource.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
    assert.ok(match, `real ${name} is available`);
    return match[0];
  });
  const links = { editor: {}, 'map-editor': {} };
  const context = vm.createContext({
    createEditorMap: require('./load-core.cjs').createEditorMap,
    location: {hash:'',pathname:'/index.html',search:''}, history:{replaceState(){}},
    el: id => links[id] ?? {}, editorConfig:null, resumeEditor:false,
    game:{config:{}}, setupMapChoices(){}, links
  });
  vm.runInContext('function selectMap(config){game={config};updateEditorLinks();}' + functions.join('\n'), context);
  const valid = { format:'tanks-map-editor',version:1,width:28,height:18,objects:[
    {id:'s',name:'Спавн',type:'spawn',x:1,y:1,w:1,h:1},
    {id:'b',name:'База',type:'base',x:23,y:13,w:2,h:2},
    {id:'p',name:'Игрок',type:'player',x:20,y:10,w:1,h:1}
  ]};
  context.input = JSON.stringify(valid);
  vm.runInContext('loadEditorText(input)', context);
  assert.equal(new URLSearchParams(links.editor.href.split('#')[1]).has('resume'), false);
  vm.runInContext('loadEditorText(input,true)', context);
  assert.equal(new URLSearchParams(links.editor.href.split('#')[1]).get('resume'), '1');
});

test('a rejected geometry snapshot can be sent back for editing even without storage', () => {
  const gameSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const declaration = gameSource.match(/  function showEditorError\([^]*?\n  \}/);
  assert.ok(declaration, 'map rejection provides a repair link');
  const elements = {'map-message':{},'map-fix':{hidden:true}};
  const context = vm.createContext({el:id=>elements[id],encodeURIComponent,readEditorDraft:require('./load-core.cjs').readEditorDraft});
  vm.runInContext(declaration[0],context);
  const broken = draft(28); // Structurally valid, but outside the field: still editable.
  context.text = JSON.stringify(broken);
  vm.runInContext('showEditorError(text,new Error("Вне поля"),false)',context);
  assert.equal(elements['map-fix'].hidden,false);
  assert.ok(elements['map-message'].textContent.includes('Вне поля'));
  assert.deepEqual(plain(api.load(elements['map-fix'].href.split('.html')[1],null).draft),broken);
});

test('editing an imported or repaired snapshot survives reload, including storage denial', () => {
  const ui = scripts.at(-1)[1];
  const declaration = ui.match(/function persistEditorDraft\([^]*?\n\}/);
  assert.ok(declaration,'saving the editor synchronizes the current URL snapshot');
  for(const storage of [memory(),{getItem:()=>JSON.stringify(draft(1)),setItem(){throw Error('quota');}}]) {
    const location = {hash:api.fragment(draft(2))};
    let replacements=0;
    const context = vm.createContext({
      TankEditorDraft:api,draftStorage:storage,model:draft(7),location,
      history:{replaceState(_state,_title,fragment){replacements++;location.hash=fragment;}}
    });
    vm.runInContext('let history=[];'+declaration[0]+';persistEditorDraft()',context);
    assert.deepEqual(plain(api.load(location.hash,storage).draft),draft(7));
    assert.equal(replacements,1,'the browser entry is replaced despite the editor undo stack');
    assert.equal(vm.runInContext('history.length',context),0,'address updates leave undo history intact');
  }
});

test('corrupt or unsupported files never advertise a repair link that opens an unrelated draft', () => {
  const gameSource=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const declaration=gameSource.match(/  function showEditorError\([^]*?\n  \}/);
  const elements={'map-message':{},'map-fix':{hidden:true}};
  const context=vm.createContext({el:id=>elements[id],encodeURIComponent,readEditorDraft:require('./load-core.cjs').readEditorDraft});
  vm.runInContext(declaration[0],context);
  for(const text of ['{broken',JSON.stringify({...draft(2),version:2}),JSON.stringify({objects:[]})]) {
    context.text=text;
    vm.runInContext('showEditorError(text,new Error("Неверный формат"),false)',context);
    assert.equal(elements['map-fix'].hidden,true);
  }
});
