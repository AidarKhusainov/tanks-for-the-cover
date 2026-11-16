'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, CONFIG, MAP_CONFIGS } = require('./load-core.cjs');
const STEP = 1 / 60;
function defense(type, near = false) {
  const game = new Game({ ...CONFIG, WALLS: [] });
  game.phase = 'battle';
  const enemy = { id: 'defender', type, x: 11, y: near ? 13.5 : 4, r: .5, hp: 120,
    targetWreckId: 'gate', route: [], routeVersion: game.navigationVersion, cooldown: .2 };
  game.enemies = [enemy];
  game.wrecks = [{ id: 'gate', x: 14, y: enemy.y, r: .5, hp: 120 }];
  Object.assign(game.player, { x: 11, y: enemy.y - 3, angle: 0 });
  return { game, enemy };
}
for (const type of ['medium', 'heavy']) for (const near of [false, true]) {
  test(`${type} counters incoming fire ${near ? 'near' : 'far from'} base without chasing or resetting reload`, () => {
    const { game, enemy } = defense(type, near);
    const start = { x: enemy.x, y: enemy.y };
    game._shoot(game.player, enemy, 'player', 40, 20, 6);
    game.update(STEP, { aimX: 8, aimY: game.player.y });
    assert.equal(enemy.activeFiringTarget?.kind, 'player');
    assert.ok(enemy.cooldown > .17 && enemy.cooldown < .2);
    game.update(.5, { aimX: 8, aimY: game.player.y });
    assert.ok(game.player.hp < 60, 'counterfire lands');
    assert.ok(Math.hypot(enemy.x - start.x, enemy.y - start.y) < .01, 'defense holds position');
    game.update(.5, { aimX: 8, aimY: game.player.y });
    assert.notEqual(enemy.stationaryTarget, 'player', 'attack memory expires and objective movement resumes');
  });
  test(`${type} responds to recent damage but immediately stops at lost range or LOS (${near})`, () => {
    const { game, enemy } = defense(type, near);
    game._applyHit({ kind: 'enemy', object: enemy }, { team: 'player', damage: 20 });
    assert.equal(game._chooseTarget(enemy, 6)?.kind, 'player');
    game.player.x = 3;
    assert.notEqual(game._chooseTarget(enemy, 6)?.kind, 'player');
    game.player.x = 11;
    game.wrecks.push({ id: 'screen', x: 11, y: enemy.y - 1.5, hp: 60, r: .5 });
    assert.notEqual(game._chooseTarget(enemy, 6)?.kind, 'player');
  });
}

test('a visible but non-attacking distant player does not distract an assigned heavy', () => {
  const { game, enemy } = defense('heavy');
  assert.equal(game._chooseTarget(enemy, 6)?.kind, 'wreck');
});

// Diagnostic reconstruction, not an exact replay: only anonymous hull geometry from the submitted final state.
function column(clear = false) {
  const game = new Game(MAP_CONFIGS.magnetic);
  game.phase = 'battle';
  Object.assign(game.player, { alive: false, respawn: 100 });
  if (!clear) game.wrecks = [
    [21.75515536810146,7.855889751292482,100], [13.736132593756228,8.263270646033439,4],
    [22.34114228737351,11.462717163250359,40], [14.858937721391941,7.8099462111208,20],
    [8.125,13.32333333333334,60], [19.989883530040068,12.219267242444214,40]
  ].map(([x,y,hp], i) => ({ id: `hull-${i}`, x,y,hp,r:.5 }));
  game.enemies = [11.375,9.9,8.9].map((y,i) => ({ id:`tank-${i}`, type:i ? 'light':'heavy',
    x:7.375,y,r:.5,hp:i ? 20:120,lane:'A',bodyAngle:Math.PI/2 }));
  return game;
}
for (const clear of [false,true]) {
  test(`magnetic A column progresses and shares actual fire (${clear ? 'clear' : 'logged hulls'})`, () => {
    const game = column(clear);
    const rear = game.enemies[1];
    const path = game.debugRoute(rear.x,rear.y,rear);
    assert.ok(path.points.length, 'an ally shot must not erase the own route');
    const shots = new Set();
    const shoot = game._shoot;
    game._shoot = function(actor,...args) { const fired=shoot.call(this,actor,...args); if(fired) shots.add(actor.id); return fired; };
    for(let frame=0;frame<480;frame++) {
      game.update(STEP);
      for(const enemy of game.enemies) assert.ok(game._positionFree(enemy.x,enemy.y,enemy,false), 'no tank/wall overlap');
    }
    assert.ok(rear.y > 11, 'rear tank leaves its original stationary position');
    assert.ok(shots.size >= 2, `multiple tanks fire, observed: ${[...shots]}`);
  });
}

test('counterfiring support is excluded from the group breach and rejoins after attack cessation', () => {
  const game = new Game({ ...CONFIG, WALLS: [
    {x:7,y:8,w:6.48,h:4},{x:14.52,y:8,w:6.48,h:4}
  ] });
  game.phase='battle';
  const lead={id:'lead',type:'light',lane:'A',x:13.45,y:6.7,r:.5,hp:20};
  const support={id:'support',type:'heavy',lane:'A',x:14.55,y:6.7,r:.5,hp:120};
  game.enemies=[lead,support];
  game.wrecks=[{id:'gate',x:14,y:10.6,r:.5,hp:64}];
  Object.assign(game.player,{x:17,y:6.7,angle:0});
  const before=game.debugRoute(lead.x,lead.y,lead);
  assert.ok(before.shooters.includes('support'));
  game._shoot(game.player,support,'player',40,20,6);
  const during=game.debugRoute(lead.x,lead.y,lead);
  assert.ok(!during.shooters.includes('support'), 'counterfire cannot simultaneously clear a hull');
  assert.ok(during.decision==='detour' || during.breachSeconds > before.breachSeconds);
  game.bullets=[];
  game._waveTime=1;
  const after=game.debugRoute(lead.x,lead.y,lead);
  assert.ok(after.shooters.includes('support'));
});

test('a defended breach clears with actual sole-shooter damage and the predicted next base shot', () => {
  const game = new Game({ ...CONFIG, WALLS: [
    {x:7,y:8,w:6.48,h:4},{x:14.52,y:8,w:6.48,h:4}
  ] });
  game.phase='battle';
  const lead={id:'lead',type:'light',lane:'A',x:13.45,y:6.7,r:.5,hp:20,reacquireDelay:10};
  const support={id:'support',type:'heavy',lane:'A',x:14.55,y:6.7,r:.5,hp:120};
  game.enemies=[lead,support];
  const gate={id:'gate',x:14,y:10.6,r:.5,hp:24};
  game.wrecks=[gate];
  Object.assign(game.player,{x:17,y:6.7,angle:Math.PI});
  game._shoot(game.player,support,'player',40,20,6);
  const estimate=game.debugRoute(lead.x,lead.y,lead);
  assert.deepEqual(Array.from(estimate.shooters),['lead']);
  assert.ok(Math.abs(estimate.estimatedSeconds-4.2)<.01, 'three light rounds plus next reload, no heavy damage');
  const hits=[];
  const apply=game._applyHit;
  game._applyHit=function(hit,bullet) {
    if(hit.object===gate) hits.push({id:bullet.ownerId,time:this._waveTime});
    apply.call(this,hit,bullet);
  };
  let firstBase;
  const shoot=game._shoot;
  game._shoot=function(actor,point,...args) {
    const target=this._firstCollision(actor.x,actor.y,point.x,point.y,actor.id);
    const fired=shoot.call(this,actor,point,...args);
    if(fired && target?.kind==='base') firstBase ??= this._waveTime;
    return fired;
  };
  game.update(4.4,{aimX:support.x,aimY:support.y});
  assert.equal(game.wrecks.includes(gate),false);
  assert.deepEqual(hits.map(hit=>hit.id),['lead','lead','lead']);
  assert.ok(hits.at(-1).time>3.1 && hits.at(-1).time<3.3);
  assert.ok(firstBase>4.15 && firstBase<4.3);
});

test('an open three-tank column reaches separate base firing positions', () => {
  const game=new Game({...CONFIG,WALLS:[]});
  game.phase='battle';
  Object.assign(game.player,{alive:false,respawn:100});
  game.enemies=[9,7.7,6.4].map((y,i)=>({id:`open-${i}`,type:'medium',x:14,y,r:.5,hp:60}));
  const shots=new Set();
  const shoot=game._shoot;
  game._shoot=function(actor,...args){const fired=shoot.call(this,actor,...args);if(fired)shots.add(actor.id);return fired;};
  for(let i=0;i<240;i++) {
    game.update(STEP);
    for(const enemy of game.enemies) assert.ok(game._positionFree(enemy.x,enemy.y,enemy,false));
  }
  assert.equal(shots.size,3);
});

test('incoming lethal fire defeats a nominal base finish while a survivable attack permits it', () => {
  for(const hp of [20,120]) {
    const game=new Game({...CONFIG,WALLS:[]});
    game.phase='battle';game.base.hp=20;
    const enemy={id:'heavy',type:'heavy',x:11,y:13.5,r:.5,hp,cooldown:0};
    game.enemies=[enemy];
    Object.assign(game.player,{x:11,y:10.5,angle:0});
    game._shoot(game.player,enemy,'player',40,20,6);
    assert.equal(game._chooseTarget(enemy,6)?.kind,hp===20?'player':'base');
  }
});

test('a dodge forecast cannot consume the live front tank exit waypoints', () => {
  const game=new Game({...CONFIG,WALLS:[]});
  game.phase='battle';
  const enemy={id:'heavy',type:'heavy',x:11,y:13.5,r:.5,hp:120,cooldown:1};
  game.enemies=[enemy];
  Object.assign(game.player,{x:8,y:13.5,angle:-Math.PI/2});
  game._normalizeEnemy(enemy);
  enemy.routeVersion=game.navigationVersion;
  enemy.exitPath={kind:'base',id:game.base.id,points:[{x:11,y:13.5},{x:11.5,y:13.5}]};
  const before=JSON.stringify(enemy.exitPath);
  game._shoot(game.player,enemy,'player',40,20,6);
  game._forecastShot(enemy,game.bullets[0],STEP,[enemy],0);
  assert.equal(JSON.stringify(enemy.exitPath),before);
});
