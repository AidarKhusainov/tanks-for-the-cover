'use strict';

// The campaign input driver from Tanks for the Cover tools/verify-campaign.cjs.
// Isolated from browser actions so planning remains local to the test process.
module.exports = function combatDriver(config, base) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const { x, y, w, h } = base;
  const walls = [...config.WALLS, { x: x - w / 2, y: y - h / 2, w, h }];
  const spawns = Object.values(config.SPAWNS).map(({ x, y, w, h }) => ({ x: x - w / 2, y: y - h / 2, w, h }));
  const specs = config.ENEMY_TYPES;
  function closestRect(p, rect) {
    return {x: clamp(p.x, rect.x, rect.x + rect.w), y: clamp(p.y, rect.y, rect.y + rect.h)};
  }
  function circleIntersection(a, b, p, r) {
    const x = a.x - p.x, y = a.y - p.y, dx = b.x - a.x, dy = b.y - a.y;
    const c = x*x + y*y - r*r;
    if (c <= 0) return 0;
    const aa = dx*dx + dy*dy;
    if (aa < 1e-10) return Infinity;
    const bb = x*dx + y*dy;
    const delta = bb*bb - aa*c;
    if (delta < 0) return Infinity;
    const t = (-bb - Math.sqrt(delta)) / aa;
    return t >= 0 && t <= 1 ? t : Infinity;
  }
  function rectIntersection(a, b, rect) {
    let lo = 0, hi = 1;
    for (const [axis, size] of [['x','w'],['y','h']]) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-9) {
        if (a[axis] < rect[axis] || a[axis] > rect[axis]+rect[size]) return Infinity;
        continue;
      }
      const enter = (rect[axis] - a[axis]) / delta;
      const exit = (rect[axis]+rect[size] - a[axis]) / delta;
      lo = Math.max(lo, Math.min(enter, exit));
      hi = Math.min(hi, Math.max(enter, exit));
      if (hi < lo) return Infinity;
    }
    return lo;
  }
  function firstBlock(a, b, actors, skip) {
    let first = Infinity;
    for (const wall of walls) first = Math.min(first, rectIntersection(a, b, wall));
    for (const actor of actors) {
      if (actor.id === skip) continue;
      first = Math.min(first, circleIntersection(a, b, actor, actor.r));
    }
    return first;
  }
  function positionFree(p, actors, radius = .5) {
    if (p.x < radius || p.y < radius || p.x > 28-radius || p.y > 18-radius) return false;
    for (const rect of [...walls, ...spawns]) {
      const q = closestRect(p, rect);
      if ((p.x-q.x)**2+(p.y-q.y)**2 < radius*radius-1e-7) return false;
    }
    for (const a of actors) if ((p.x-a.x)**2+(p.y-a.y)**2 < (radius+a.r)**2-1e-7) return false;
    return true;
  }
  function predict(p, vx, vy, seconds, actors) {
    const out = {x: p.x, y: p.y};
    const steps = Math.ceil(seconds/.05);
    for (let i=0; i<steps; i++) {
      const x = out.x + vx*seconds/steps;
      if (positionFree({x, y: out.y}, actors)) out.x = x;
      const y = out.y + vy*seconds/steps;
      if (positionFree({x: out.x, y}, actors)) out.y = y;
    }
    return out;
  }
  function shotAt(p, e, actors, maxDistance = 6.38, margin = .018) {
    const distance = dist(p, e);
    if (distance > maxDistance || distance < .1) return null;
    const angle = Math.atan2(e.y-p.y, e.x-p.x);
    for (const offset of [0, -.23, .23, -.36, .36]) {
      const adjust = Math.atan2(offset,distance);
      const end = {x:p.x+Math.cos(angle+adjust)*6,y:p.y+Math.sin(angle+adjust)*6};
      const impact = circleIntersection(p,end,e,e.r-margin);
      if (impact === Infinity) continue;
      if (firstBlock(p, end, actors, e.id) > impact + margin/6) {
        return {x:p.x+Math.cos(angle+adjust)*distance,y:p.y+Math.sin(angle+adjust)*distance};
      }
    }
    return null;
  }
  const validTarget = (p, e, actors, maxDistance) => !!shotAt(p,e,actors,maxDistance);

  function targetValue(p, e) {
    const vulnerability = Math.max(0, 8 - dist(e, base));
    const threatensBase = e.stationaryTarget === 'base';
    const heavy = e.type === 'heavy';
    const urgency = (threatensBase ? 7 : 0) + vulnerability * .75 + (heavy ? 1.25 : 0);
    const quick = e.hp <= 20 ? 2.2 : e.hp <= 40 ? 1.2 : 0;
    return urgency + quick - dist(p, e) * .17;
  }
  function target(p, s, actors, previous) {
    let best = null;
    let value = -Infinity;
    for (const e of s.enemies) {
      const old = previous?.enemies.find(item => item.id === e.id);
      const elapsed = s.battleSeconds - (previous?.battleSeconds ?? s.battleSeconds);
      const aim = {...e};
      if (old && elapsed > .002 && elapsed < .1) {
        const lead = dist(p, e) / 40 + .018;
        aim.x += clamp((e.x-old.x)/elapsed, -specs[e.type].speed, specs[e.type].speed) * lead;
        aim.y += clamp((e.y-old.y)/elapsed, -specs[e.type].speed, specs[e.type].speed) * lead;
        if (!validTarget(p, aim, actors, 6.38)) Object.assign(aim, e);
      }
      const shot = shotAt(p,aim,actors);
      if (!shot) continue;
      const score = targetValue(p,e);
      if (score > value) { best = {...aim,...shot}; value = score; }
    }
    return best;
  }

  const spacing = .35;
  const grid = [];
  const columns = 79;
  const rows = 50;
  for (let j=0; j<rows; j++) {
    for (let i=0; i<columns; i++) grid.push({x: .55+i*spacing, y: .55+j*spacing});
  }
  const steps = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  // Search the reachable grid for a firing position or preparation waypoint.
  function plan(s, actors, destination) {
    const p = s.player;
    const accessible = grid.map(point => positionFree(point, actors, .53));
    const cost = new Float64Array(grid.length).fill(Infinity);
    const paths = new Int32Array(grid.length).fill(-1);
    const queue = [];
    const push = (id, length, parent) => {
      if (length + .001 >= cost[id]) return;
      cost[id] = length;
      paths[id] = parent;
      let index = queue.length;
      queue.push({id, length});
      while (index > 0) {
        const up = (index-1)>>1;
        if (queue[up].length <= length) break;
        [queue[up], queue[index]] = [queue[index], queue[up]];
        index = up;
      }
    };
    const pop = () => {
      const first = queue[0], end = queue.pop();
      if (!queue.length) return first;
      queue[0] = end;
      let i=0;
      while (i*2+1 < queue.length) {
        let low = i*2+1;
        if (low+1 < queue.length && queue[low+1].length < queue[low].length) low++;
        if (queue[low].length >= queue[i].length) break;
        [queue[i], queue[low]] = [queue[low], queue[i]];
        i = low;
      }
      return first;
    };
    function clearLine(a, b) {
      const length = dist(a,b);
      const checks = Math.ceil(length/.19);
      for (let i = 1; i <= checks; i++) {
        const t = i / checks;
        if (!positionFree({x: a.x+(b.x-a.x)*t, y: a.y+(b.y-a.y)*t}, actors, .5)) return false;
      }
      return true;
    }
    const closestX = clamp(Math.round((p.x-.55)/spacing),0,columns-1);
    const closestY = clamp(Math.round((p.y-.55)/spacing),0,rows-1);
    for(let j = Math.max(0, closestY-2); j<=Math.min(rows-1,closestY+2); j++) {
      for(let i = Math.max(0, closestX-2); i<=Math.min(columns-1,closestX+2); i++) {
        const id = j*columns+i;
        if(accessible[id] && clearLine(p,grid[id])) push(id, dist(p,grid[id]), -1);
      }
    }

    const opponents = s.enemies;
    const goalLane = s.queue[0]?.lane;
    const queuePost = goalLane ? { A: { x: 11.35, y: 10.55 }, B: { x: 14.45, y: 9.6 }, C: { x: 18.2, y: 12 } }[goalLane] : base;
    let best = -1, bestValue = Infinity, bestEnemy;
    function evaluateGoal(point, length) {
      if (destination || !opponents.length) return [length + dist(point,destination ?? queuePost)*4, null];
      let value = Infinity, enemy;
      for (const e of opponents) {
        const distance = dist(e,point);
        if (!shotAt(point,e,actors,6.20,.065)) continue;
        let incoming = 0;
        for (const other of opponents) {
          if (other.id !== e.id && validTarget(point,other,actors,specs[other.type].range+.5)) incoming += .6;
        }
        const distanceCost = distance < 3.8 ? (3.8-distance)*.40 : (distance-3.8)*.07;
        const closeness = dist(p,point);
        const doorstep = closeness < .19 ? (.19-closeness)*15 : 0;
        const score = length + distanceCost + incoming + doorstep - targetValue(point,e)*.40;
        if (score < value) { value = score; enemy = e; }
      }
      return [value, enemy];
    }
    let fallback = -1, fallbackValue = Infinity;
    while (queue.length) {
      const {id, length} = pop();
      if (length > cost[id]+.001) continue;
      const point = grid[id];
      const [value, enemy] = evaluateGoal(point,length);
      if (value < bestValue) { best = id; bestValue = value; bestEnemy = enemy; }
      if (opponents.length) {
        const fallbackScore = Math.min(...opponents.map(e => dist(point,e))) + .3*length;
        if (fallbackScore < fallbackValue) { fallback = id; fallbackValue = fallbackScore; }
      }
      if (length > bestValue + (destination ? .3 : 5.5)) break;
      const i = id % columns, j = Math.floor(id/columns);
      for (const [dx,dy] of steps) {
        const x = i+dx, y = j+dy;
        if (x<0 || y<0 || x>=columns || y>=rows) continue;
        const next = y*columns+x;
        if (!accessible[next]) continue;
        if (dx && dy && (!accessible[j*columns+x] || !accessible[y*columns+i])) continue;
        const mid = {x:(point.x+grid[next].x)/2, y:(point.y+grid[next].y)/2};
        if (!positionFree(mid,actors,.51)) continue;
        push(next,length+spacing*Math.hypot(dx,dy),id);
      }
    }
    if (best < 0) best = fallback;
    if (best < 0) return {point: p, goal: p};
    const goal = grid[best];
    const route = [];
    for(let current=best; current>=0; current=paths[current]) route.push(grid[current]);
    const point = route.find(node => clearLine(p,node)) ?? route.at(-1);
    return {point, goal, enemy: bestEnemy?.id};
  }

  function direction(s, waypoint, aim, actors) {
    const p = s.player;
    const speed = p.module === 'engine' ? 5 : 4;
    const risky = s.bullets.filter(b => b.team === 'enemy' && dist(b,p) < b.remaining + 2.5);
    const bullets = risky.map(b => {
      const endpoint = {x:b.x+b.dx*b.remaining, y:b.y+b.dy*b.remaining};
      const collide = firstBlock(b,endpoint,actors,b.ownerId);
      return {...b, time: Math.min(collide,1)*b.remaining/b.speed};
    });
    let bestMove = [];
    let bestScore = Infinity;
    const options = [[0,0],...steps];
    for (let i=0; i<options.length; i++) {
      const [x,y] = options[i];
      const length = Math.max(1, Math.hypot(x,y));
      const vx = x*speed/length, vy = y*speed/length;
      const horizon = clamp(dist(p,waypoint)/speed,.018,.14);
      const end = predict(p,vx,vy,horizon,actors);
      const avx = (end.x-p.x)/horizon, avy = (end.y-p.y)/horizon;
      let score = dist(end,waypoint) + i*.0005 + (i ? .005 : 0);
      if (aim) {
        const effective = dist(end,aim);
        if (effective > 6.4) score += 1.0;
        if (!validTarget(end,aim,actors,6.42)) score += .45;
      }
      for (const b of bullets) {
        const rx = b.x-p.x, ry = b.y-p.y;
        const dx = b.dx*b.speed-avx, dy = b.dy*b.speed-avy;
        const time = clamp(-(rx*dx+ry*dy)/(dx*dx+dy*dy), 0, Math.min(b.time,.49));
        if (time <= 0) continue;
        const gap = Math.hypot(rx+dx*time, ry+dy*time);
        if (gap < .63) score += (b.damage/6)*(1.3-time)*(1.05-gap);
      }
      if (score < bestScore) {
        bestScore = score;
        bestMove = [x===1?'d':x===-1?'a':null,y===1?'s':y===-1?'w':null].filter(Boolean);
      }
    }
    return bestMove;
  }
  return { target, plan, direction };
};
