// Static, procedural city. Gameplay uses this same layout in the x/z plane.
export function buildTown(THREE, scene, layout, options = {}) {
  if (!options.blockout) return buildDetailedTown(THREE, scene, layout);
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(layout.width, .24, layout.height),
    new THREE.MeshStandardMaterial({ color: 0xb4a78f })
  );
  ground.position.set(layout.width / 2, -.12, layout.height / 2);
  ground.receiveShadow = true;
  scene.add(ground);
  const mass = new THREE.MeshStandardMaterial({ color: 0xa48261 });
  for (const building of layout.buildings) {
    const shape = new THREE.Shape(building.shape.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1.12, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, mass);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  return {};
}

const HOUSES = {
  trade: { eave: 1.12, plaster: [0xf1dbb6, 0xe6c197, 0xf0d8b4], tile: 0xce8351 },
  southwest: { eave: 1.12, plaster: [0xe8ceb0, 0xe4c5a1], tile: 0xb9714b },
  market: { eave: 1.17, plaster: [0xefcf9e, 0xe2bb89], tile: 0xc97f4c },
  'north-homes': { eave: 1.10, plaster: [0xf3dfbd, 0xe5bd9e], tile: 0xae7051 },
  'east-upper': { eave: 1.13, plaster: [0xe9c7a8, 0xe3b991, 0xf0d0a8], tile: 0xc8794e },
  'east-main': { eave: 1.11, plaster: [0xe7c394, 0xf1dcc0, 0xdcb58f], tile: 0xc98657 },
  townhall: { eave: 1.22, plaster: [0xf2dfbc], tile: 0xbc7950 },
  edge: { eave: 1.08, plaster: [0xe1c097, 0xe9ccab], tile: 0xb37456 }
};

const PLANTED_EDGES = {
  trade: [2,4,6], market: [2,4], 'north-homes': [2],
  'east-upper': [2,3,4], 'east-main': [0,2], southwest: [2], townhall: [0,2]
};

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function surface(THREE, size, draw, anisotropy = 4) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  return texture;
}

function stoneTexture(THREE, plaza) {
  return surface(THREE, 768, (context, size) => {
    const rng = seededRandom(plaza ? 774 : 125);
    const columns = plaza ? 8 : 18;
    const rows = plaza ? 8 : 21;
    const stepX = size / columns;
    const stepY = size / rows;
    const grout = plaza ? '#b1a18b' : '#a39987';
    context.fillStyle = grout;
    context.fillRect(0, 0, size, size);

    for (let row = 0; row < rows; row++) {
      const offset = plaza ? 0 : (row % 2 * .5 + (rng()-.5)*.3) * stepX;
      for (let col = 0; col < columns; col++) {
        const x = col * stepX + offset + rng() * (plaza ? 1 : 4.5);
        const y = row * stepY + .8 + rng() * (plaza ? 1 : 4);
        const w = stepX - (plaza ? 2.2 : 3.8) - rng() * 3;
        const h = stepY - (plaza ? 2.1 : 3.8) - rng() * 2.8;
        const tone = Math.round((plaza ? 216 : 193) + (rng() - .5) * (plaza ? 14 : 27));
        const warm = plaza ? 9 : 4 + Math.round(rng() * 7);
        const tint = light => `rgb(${tone + warm + light} ${tone + light} ${tone - warm - 7 + light})`;
        const flecks = Array.from({ length: 8 }, () => ({
          x: 5 + rng() * (w - 10), y: 4 + rng() * (h - 8),
          w: 1 + rng() * 6, h: 1 + rng() * 3
        }));
        // Draw the rightmost staggered pavers on both sides of the seam.
        for (const left of x + w > size ? [x, x - size] : [x]) {
          const gradient = context.createLinearGradient(left, y, left + w * .44, y + h);
          gradient.addColorStop(0, tint(11));
          gradient.addColorStop(.20, tint(4));
          gradient.addColorStop(.78, tint(0));
          gradient.addColorStop(1, tint(-10));
          context.fillStyle = gradient;
          context.beginPath();
          if (plaza) {
            context.roundRect(left, y, w, h, [2, 3, 2, 4]);
          } else {
            // Uneven cut corners and bowed sides keep courses recognizable
            // without the identical rounded-rectangle look of a floor grid.
            context.moveTo(left + w*.18,y);
            context.lineTo(left+w*.80,y+1.5);
            context.quadraticCurveTo(left+w,y+2,left+w-1,y+h*.28);
            context.lineTo(left+w-2,y+h*.78);
            context.quadraticCurveTo(left+w-3,y+h,left+w*.75,y+h);
            context.lineTo(left+w*.18,y+h-1);
            context.quadraticCurveTo(left,y+h-2,left+1,y+h*.70);
            context.lineTo(left,y+h*.23);
            context.quadraticCurveTo(left+1,y+2,left+w*.18,y);
            context.closePath();
          }
          context.fill();
          for (const [i, fleck] of flecks.entries()) {
            context.fillStyle = i % 3 ? 'rgba(95,84,73,.08)' : 'rgba(255,248,222,.16)';
            context.fillRect(left + fleck.x, y + fleck.y, fleck.w, fleck.h);
          }
        }
      }
    }
    for (let i = 0; i < 7500; i++) {
      context.fillStyle = i % 2 ? 'rgba(248,240,216,.055)' : 'rgba(67,58,51,.045)';
      context.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1);
    }
  });
}

function plasterTexture(THREE) {
  return surface(THREE, 384, (context, size) => {
    const rng = seededRandom(318);
    context.fillStyle = '#f4eee1';
    context.fillRect(0, 0, size, size);
    for (let i = 0; i < 420; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 2 + rng() * 27;
      const shade = context.createRadialGradient(x, y, 0, x, y, r);
      shade.addColorStop(0, rng() < .52 ? 'rgba(128,96,75,.26)' : 'rgba(254,250,237,.28)');
      shade.addColorStop(1, 'rgba(211,193,170,0)');
      context.fillStyle = shade;
      context.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let i = 0; i < 3400; i++) {
      context.fillStyle = rng() < .55 ? 'rgba(96,69,52,.11)' : 'rgba(255,251,231,.21)';
      context.fillRect(rng() * size, rng() * size, .7 + rng() * 3, .5 + rng() * 2);
    }
  });
}

function roofTexture(THREE) {
  return surface(THREE, 768, (context, size) => {
    const rng = seededRandom(907);
    context.fillStyle = '#8e7460';
    context.fillRect(0, 0, size, size);
    for (let row = 0; row < 12; row++) {
      const h = size / 12;
      const y = row * h;
      for (let col = 0; col < 12; col++) {
        const w = size / 12;
        const x = (col + (row % 2 ? .025 : -.015) + (rng() - .5) * .048) * w;
        const top = y + (rng() - .5) * 3.4;
        const tileWidth = w - .75 - rng() * 1.5;
        const tone = Math.round(205 + rng() * 41 - (rng() < .1 ? 25 : 0));
        const weathered = rng() < .16;
        const warmth = weathered ? -6 : 3;
        for (const wrap of [-size, 0, size]) {
          const left = x + wrap;
          const barrel = context.createLinearGradient(left, top, left + tileWidth, top);
          barrel.addColorStop(0, `rgb(${tone - 48} ${tone - 53} ${tone - 61})`);
          barrel.addColorStop(.18, `rgb(${tone - 9} ${tone - 12} ${tone - 20})`);
          barrel.addColorStop(.39, `rgb(${tone + 13} ${tone + 9 - warmth} ${tone + 2 - warmth})`);
          barrel.addColorStop(.70, `rgb(${tone + 2} ${tone - warmth} ${tone - 5 - warmth})`);
          barrel.addColorStop(.89, `rgb(${tone - 24} ${tone - 27} ${tone - 33})`);
          barrel.addColorStop(1, `rgb(${tone - 53} ${tone - 57} ${tone - 61})`);
          context.beginPath();
          context.moveTo(left + 2, top);
          context.lineTo(left + tileWidth - 2, top);
          context.lineTo(left + tileWidth - .3, top + h - 4);
          context.quadraticCurveTo(left + tileWidth / 2, top + h + .1, left + .3, top + h - 4);
          context.closePath();
          context.fillStyle = barrel;
          context.fill();
          const course = context.createLinearGradient(left, top, left, top + h);
          course.addColorStop(0, 'rgba(57,36,33,.24)');
          course.addColorStop(.19, 'rgba(57,36,33,0)');
          course.addColorStop(.76, 'rgba(255,237,216,.12)');
          course.addColorStop(.91, 'rgba(255,240,219,.25)');
          course.addColorStop(1, 'rgba(68,45,41,.47)');
          context.fillStyle = course;
          context.fill();
        }
      }
    }
    for (let i = 0; i < 4800; i++) {
      context.fillStyle = rng() < .5 ? 'rgba(255,255,248,.08)' : 'rgba(52,33,21,.07)';
      context.fillRect(rng() * size, rng() * size, 1 + rng() * 3, 1 + rng() * 3);
    }
  });
}

function contactTexture(THREE) {
  const texture = surface(THREE, 64, (context, size) => {
    const gradient = context.createLinearGradient(0,0,0,size);
    gradient.addColorStop(0, 'rgba(50,40,27,.24)');
    gradient.addColorStop(.22, 'rgba(50,40,27,.12)');
    gradient.addColorStop(1, 'rgba(50,40,27,0)');
    context.fillStyle = gradient;
    context.fillRect(0,0,size,size);
  },1);
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function reliefMap(THREE, texture) {
  const relief = texture.clone();
  relief.colorSpace = THREE.NoColorSpace;
  relief.needsUpdate = true;
  return relief;
}

// Batches each surface class into a single draw call. Coordinates use the
// approved plan directly, so the edge of a facade is the edge of the wall.
class Faces {
  constructor(THREE) {
    this.THREE = THREE;
    this.position = [];
    this.uv = [];
    this.color = [];
    this.palette = new Map();
  }

  face(points, tint, uv = points.map(([x, , z]) => [x, z])) {
    const colors = Array.isArray(tint) ? tint : points.map(() => tint);
    for (const color of colors) {
      if (!this.palette.has(color)) this.palette.set(color, new this.THREE.Color(color));
    }
    for (let i = 1; i < points.length - 1; i++) {
      for (const j of [0, i, i + 1]) {
        this.position.push(...points[j]);
        this.uv.push(...uv[j]);
        const { r, g, b } = this.palette.get(colors[j]);
        this.color.push(r, g, b);
      }
    }
  }

  mesh(scene, material, { cast = false, receive = true } = {}) {
    const T = this.THREE;
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('uv', new T.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute('color', new T.Float32BufferAttribute(this.color, 3));
    geometry.computeVertexNormals();
    const mesh = new T.Mesh(geometry, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    scene.add(mesh);
    return mesh;
  }
}

function horizontalQuad(batch, x, z, w, d, h, color, tileSize = 1) {
  const points = [[x, h, z], [x, h, z + d], [x + w, h, z + d], [x + w, h, z]];
  batch.face(points, color, points.map(([a, , b]) => [a / tileSize, b / tileSize]));
}

function cuboid(batch, frame, u, h, d, w, tall, thick, tint) {
  const [a,b,c,e] = [[u,h,d],[u+w,h,d],[u+w,h,d+thick],[u,h,d+thick]].map(point => frame(...point));
  const upper = point => [point[0], point[1] + tall, point[2]];
  const [A,B,C,E] = [a,b,c,e].map(upper);
  batch.face([a,A,B,b], tint);
  batch.face([b,B,C,c], tint);
  batch.face([c,C,E,e], tint);
  batch.face([e,E,A,a], tint);
  batch.face([A,E,C,B], tint);
}

function polygonWithin(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

function horizontalPolygon(THREE, batch, polygon, y, tint, tileSize) {
  const contour = polygon.map(([x, z]) => new THREE.Vector2(x, z));
  for (const triangle of THREE.ShapeUtils.triangulateShape(contour, [])) {
    const points = triangle.reverse().map(index => [polygon[index][0], y, polygon[index][1]]);
    batch.face(points, tint, points.map(([x, , z]) => [x / tileSize, z / tileSize]));
  }
}

function streetPaving(THREE, batch, width, height) {
  const interval = 1;
  const tileSize = 2.38;
  const stone = new THREE.Color(0xe8e2d8);
  for (let z = 0; z < height; z += interval) {
    for (let x = 0; x < width; x += interval) {
      const right = Math.min(x + interval, width);
      const bottom = Math.min(z + interval, height);
      const points = [[x, 0, z], [x, 0, bottom], [right, 0, bottom], [right, 0, z]];
      const colors = points.map(([a, , b]) => {
        const variation = .95 + .04 * Math.sin(a * .63 + b * .78) + .034 * Math.cos(a * .27 - b * 1.47);
        return stone.clone().multiplyScalar(variation).getHex();
      });
      batch.face(points, colors, points.map(([a, , b]) => [a / tileSize, b / tileSize]));
    }
  }
}

function ground(THREE, scene, layout, batches) {
  const { width, height, plaza, courts } = layout;
  const [x, z, w, d] = [plaza.x, plaza.y, plaza.w, plaza.h];
  const slab = new THREE.Mesh(new THREE.BoxGeometry(width, .32, height),
    new THREE.MeshStandardMaterial({ color: 0x93836e, roughness: 1 }));
  slab.position.set(width / 2, -.167, height / 2);
  scene.add(slab);
  streetPaving(THREE, batches.road, width, height);
  for (const court of courts) horizontalPolygon(THREE, batches.road, court, .006, 0xf3e3cb, 2.88);
  horizontalQuad(batches.plaza, x, z, w, d, .008, 0xf2e3c9, 2.48);

  const marking = batches.inlay;
  const edge = 0xa68b70;
  function plazaBorder(inset, stroke, color, height) {
    for (const bottom of [z + inset, z + d - inset - stroke]) {
      horizontalQuad(marking, x + inset, bottom, w - 2 * inset, stroke, height, color);
    }
    for (const left of [x + inset, x + w - inset - stroke]) {
      horizontalQuad(marking, left, z + inset + stroke, stroke, d - 2 * inset - 2 * stroke, height, color);
    }
  }
  plazaBorder(.025, .095, 0xc3ae93, .011);
  plazaBorder(.13, .19, 0xd8c4a5, .011);
  plazaBorder(.13, .025, edge, .013);
  plazaBorder(.295, .025, edge, .013);
  const markY = .014;
  const sector = (cx, cz, r, t) => [cx + r * Math.cos(t), markY, cz - r * Math.sin(t)];
  function rosette(cx, cz, radius, leaves) {
    const phi = Math.PI * 2 / leaves;
    for (let i = 0; i < 36; i++) {
      const t0 = i * Math.PI / 18;
      const t1 = (i + 1) * Math.PI / 18;
      for (const band of [1, .89]) {
        marking.face([sector(cx, cz, radius * band, t0), sector(cx, cz, radius * band, t1),
          sector(cx, cz, radius * (band - .038), t1), sector(cx, cz, radius * (band - .038), t0)], edge);
      }
    }
    for (let leaf = 0; leaf < leaves; leaf++) {
      const t = leaf * phi;
      marking.face([sector(cx, cz, radius * .04, t), sector(cx, cz, radius * .4, t - phi * .37),
        sector(cx, cz, radius * .8, t), sector(cx, cz, radius * .4, t + phi * .37)],
        leaf % 2 ? 0xb0987c : 0x998471);
    }
  }
  rosette(layout.base.x, plaza.y + 1.19, .68, 12);
  for (const cx of [x + .49, x + w - .49]) {
    for (const cz of [z + .49, z + d - .49]) rosette(cx, cz, .16, 6);
  }
  // Fine paving joints on the perimeter read as an edge without a curb.
  for (let i = 0; i < width; i += .28) {
    const step = Math.min(.245, width - i);
    horizontalQuad(marking, i, .012, step, .085, .014, 0xa69883);
    horizontalQuad(marking, i, height - .097, step, .085, .014, 0xa69883);
  }
}

function boundary(polygon) {
  return polygon.map(([x, z], i) => {
    const [endX, endZ] = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(endX - x, endZ - z);
    const xAxis = (endX - x) / length;
    const zAxis = (endZ - z) / length;
    const local = (a, b) => [(a - x) * xAxis + (b - z) * zAxis, (a - x) * zAxis - (b - z) * xAxis];
    const point = (offset, y, depth = 0) => [x + xAxis * offset + zAxis * depth, y, z + zAxis * offset - xAxis * depth];
    // Fixed-pitch offsets meet at square corners. The max of these planes
    // measures distance to the eave, including beyond the ends of the edge.
    const [u, v] = local(0,0);
    const distancePlanes = [
      [zAxis,-xAxis,v], [-zAxis,xAxis,-v],
      [-xAxis,-zAxis,-u], [xAxis,zAxis,u-length]
    ];
    return { local, point, length, distancePlanes };
  });
}

function roofSample(edges, x, z) {
  let distance = Infinity;
  let edge = edges[0];
  let plane = 0;
  for (const candidate of edges) {
    const [u, v] = candidate.local(x, z);
    const extents = [v, -v, -u, u - candidate.length];
    const test = Math.max(...extents);
    if (test < distance) {
      distance = test;
      edge = candidate;
      plane = extents.indexOf(test);
    }
  }
  return [distance, edge, plane];
}

function splitRoofFace(points, a, b, c) {
  const value = ([x,z]) => a * x + b * z + c;
  const distances = points.map(value);
  if (Math.min(...distances) >= -1e-7 || Math.max(...distances) <= 1e-7) return [points];
  const positive = [];
  const negative = [];
  for (const [i, point] of points.entries()) {
    const next = (i + 1) % points.length;
    const d = distances[i];
    const e = distances[next];
    if (d >= -1e-7) positive.push(point);
    if (d <= 1e-7) negative.push(point);
    if (d * e >= 0 || Math.min(Math.abs(d),Math.abs(e)) < 1e-7) continue;
    const t = d / (d - e);
    const crossing = [point[0] + t * (points[next][0] - point[0]), point[1] + t * (points[next][1] - point[1])];
    positive.push(crossing);
    negative.push(crossing);
  }
  return [positive, negative];
}

function roofPartition(edges, rectangle) {
  // On each side of an equality line the order of two distance planes is
  // fixed, so a fragment uses a single slope and continuous tile coordinates.
  let faces = [rectangle];
  const planes = edges.flatMap(edge => edge.distancePlanes);
  const lines = new Set();
  for (let i = 0; i < planes.length; i++) {
    const [a,b,c] = planes[i];
    for (const [x,z,y] of planes.slice(0,i)) {
      const dx = a - x, dz = b - z, dh = c - y;
      const scale = dx || dz;
      if (!scale) continue;
      const key = [dx/scale,dz/scale,dh/scale].map(n => n.toFixed(7)).join(',');
      if (lines.has(key)) continue;
      lines.add(key);
      faces = faces.flatMap(points => splitRoofFace(points,dx,dz,dh));
    }
  }
  return faces;
}

// Ridge caps sit on crests where the same offset reaches both eaves.
function hipTiles(detail, edges, polygon, yAt, tint) {
  const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      const first = edges[a];
      const second = edges[b];
      const [x0,,z0] = first.point(0,0);
      const [x1,,z1] = first.point(0,0,1);
      const [x2,,z2] = second.point(0,0);
      const [x3,,z3] = second.point(0,0,1);
      const nx = x1-x0 - x3+x2;
      const nz = z1-z0 - z3+z2;
      const norm = Math.hypot(nx,nz);
      if (norm < .1) continue;
      const line = (first.local(0,0)[1] - second.local(0,0)[1]) / norm;
      const origin = [-line*nx/norm,-line*nz/norm];
      const dx = nz/norm, dz = -nx/norm;
      const min = Math.min(...polygon.map(([x,z]) => (x-origin[0])*dx+(z-origin[1])*dz));
      const max = Math.max(...polygon.map(([x,z]) => (x-origin[0])*dx+(z-origin[1])*dz));
      const at = (t, width = 0) => [origin[0]+dx*t+nx/norm*width, origin[1]+dz*t+nz/norm*width];
      const crest = ([x,z]) => {
        const [u,v] = first.local(x,z), [w,h] = second.local(x,z);
        return u >= -.003 && w >= -.003 && u <= first.length+.003 && w <= second.length+.003 &&
          v < -.035 && h < -.035 && Math.abs(roofSample(edges,x,z)[0] + v) < .006 &&
          polygonWithin(polygon,x,z);
      };
      const positions = [];
      for (let t = min + .035; t < max; t += .12) {
        const point = at(t);
        if (crest(point)) positions.push([t,point]);
      }
      for (let i = 1; i < positions.length; i++) {
        const [start, p] = positions[i-1];
        const [end, q] = positions[i];
        if (distance(p,q) > .121) continue;
        const capWidth = .045;
        const coord = (t,w,height) => {
          const [x,z] = at(t,w);
          return [x,yAt(x,z)+height,z];
        };
        for (const side of [-1,1]) {
          detail.face([coord(start,0,.031),coord(end-.007,0,.047),
            coord(end-.007,side*capWidth,.014),coord(start,side*capWidth,.01)],
            i % 5 === 0 ? 0xcb987a : side < 0 ? tint : 0xcf977a);
        }
      }
    }
  }
}

function roof(THREE, building, style, edges, batches, rng) {
  const bounds = building.shape;
  const X = [...new Set(bounds.map(point => point[0]))].sort((a,b) => a-b);
  const Z = [...new Set(bounds.map(point => point[1]))].sort((a,b) => a-b);
  const slope = building.id === 'market' ? .29 : .42;
  const elevation = distance => style.eave + .048 + distance * slope;
  const yAt = (x,z) => elevation(roofSample(edges, x, z)[0]);
  const tint = style.tile;
  for (let zi = 1; zi < Z.length; zi++) {
    for (let xi = 1; xi < X.length; xi++) {
      const [left, right, north, south] = [X[xi-1], X[xi], Z[zi-1], Z[zi]];
      if (!polygonWithin(bounds, (left + right) / 2, (north + south) / 2)) continue;
      const rectangle = [[left,north],[left,south],[right,south],[right,north]];
      for (const face of roofPartition(edges,rectangle)) {
        const x = face.reduce((sum, point) => sum + point[0], 0) / face.length;
        const z = face.reduce((sum, point) => sum + point[1], 0) / face.length;
        const [,edge,plane] = roofSample(edges,x,z);
        const [nx,nz,offset] = edge.distancePlanes[plane];
        const uv = face.map(([xx,zz]) => {
          const course = -nz * xx + nx * zz;
          const rise = nx * xx + nz * zz + offset;
          return [course / 1.56, rise / 2.15];
        });
        batches.roof.face(face.map(([xx,zz]) => [xx,yAt(xx,zz),zz]),tint,uv);
      }
    }
  }
  const detail = batches.detail;
  hipTiles(detail, edges, bounds, yAt, tint);
  for (const edge of edges) {
    cuboid(detail, edge.point, 0, style.eave - .079, -.035, edge.length, .048, .058, 0x8b634c);
    cuboid(detail, edge.point, 0, style.eave - .038, -.07, edge.length, .064, .106, 0xcd9f78);
    cuboid(detail, edge.point, 0, style.eave + .027, -.03, edge.length, .021, .071, tint);
  }
  const chimneys = building.context ? 1 : building.id === 'townhall' ? 0 : Math.floor(1 + (X.at(-1) - X[0] + Z.at(-1) - Z[0]) / 4.6);
  const installed = [];
  for (let tries = 0; tries < 65 && installed.length < chimneys; tries++) {
    const x = X[0] + rng() * (X.at(-1) - X[0]);
    const z = Z[0] + rng() * (Z.at(-1) - Z[0]);
    if (!polygonWithin(bounds,x,z) || roofSample(edges,x,z)[0] < .33 ||
      installed.some(([a,b]) => Math.hypot(a-x,b-z) < 1.34)) continue;
    installed.push([x,z]);
    const y = yAt(x,z);
    const frame = (u,h,d) => [x+u,h,z+d];
    cuboid(detail, frame, -.176, y - .11, -.145, .352, .105, .29, 0xa6745b);
    cuboid(detail, frame, -.133, y - .11, -.11, .266, .362, .22, 0xd5bd9f);
    cuboid(detail, frame, -.185, y + .188, -.145, .37, .052, .29, 0xb79679);
    cuboid(detail, frame, -.172, y + .237, -.128, .344, .039, .256, 0xe8d2b0);
    for (const u of [-.126, .029]) {
      cuboid(detail, frame, u, y + .276, -.065, .097, .043, .13, 0x9f705c);
      horizontalQuad(detail, x + u + .009, z - .056, .079, .112, y + .322, 0x513e35);
    }
    for (let joint = 0; joint < 3; joint++) {
      cuboid(detail, frame, -.121, y + .034 + joint * .041, -.105, .252, .005, .209, 0xad9176);
    }
  }
  if (building.id === 'townhall') {
    const x = 10.2, z = 14.62;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(.24, .29, .34, 8),
      new THREE.MeshStandardMaterial({ color: 0xd4b999 }));
    const dome = new THREE.Mesh(new THREE.ConeGeometry(.3, .217, 8),
      new THREE.MeshStandardMaterial({ color: 0x5b7567 }));
    const crown = new THREE.Mesh(new THREE.SphereGeometry(.041, 10, 5),
      new THREE.MeshStandardMaterial({ color: 0xc49651, metalness: .23 }));
    const y = yAt(x,z);
    drum.position.set(x, y + .062, z);
    dome.position.set(x, y + .333, z);
    crown.position.set(x, y + .454, z);
    for (const item of [drum, dome, crown]) item.castShadow = true;
    batches.scene.add(drum,dome,crown);
  }
}

function facadeRectangle(batch, frame, left, y, width, height, depth, color, tileSize = .8) {
  const points = [[left,y,depth],[left,y+height,depth],[left+width,y+height,depth],[left+width,y,depth]];
  batch.face(points.map(p => frame(...p)), color, points.map(([x,h]) => [x / tileSize,h / tileSize]));
}

function archedDoor(batch, edge, center, width, height, color) {
  const frame = edge.point;
  const depth = .013;
  const radius = width * .5;
  const spring = height - radius * .57;
  const outer = 1 + .055 / radius;
  const steps = 9;
  const dome = (rad, i, layer = depth) => {
    const angle = Math.PI - Math.PI * i / steps;
    return frame(center + radius * rad * Math.cos(angle), spring + radius * .57 * rad * Math.sin(angle), layer);
  };
  facadeRectangle(batch,frame,center-radius, .033,width,spring-.033,depth,color);
  for (let i = 0; i < steps; i++) {
    batch.face([frame(center,spring,depth),dome(1,i+1),dome(1,i)],color);
    batch.face([dome(1,i,.022),dome(1,i+1,.022),dome(outer,i+1,.025),dome(outer,i,.025)],
      i === 4 ? 0xf8dbac : i % 2 ? 0xc4a07b : 0xe6c6a0);
  }
  for (const side of [-1,1]) {
    const left = center + side * radius - (side < 0 ? .055 : 0);
    for (let i = 0; i < 5; i++) {
      facadeRectangle(batch,frame,left,.024 + i * (spring-.024) / 5,.055,(spring-.024)/5-.004,.022,
        i % 2 ? 0xd8b892 : 0xc8a580);
    }
  }
  // Closed planked doors distinguish decorative entrances from drive-through
  // paths. Slender dark joints are kept within the arch.
  for (let i = 1; i < 8; i++) {
    facadeRectangle(batch,frame,center-radius+width*i/8,.045,.006,spring-.049,.016,0x5e4d3c);
  }
  facadeRectangle(batch,frame,center+.018,spring*.50,.028,.022,.022,0xcd9a51);
  cuboid(batch,frame,center-radius-.062,0,-.005,width+.124,.033,.044,0x9d886e);
}

function windowFrame(edge, batch, center, y, width, height, shutter, flowers, rng) {
  const frame = edge.point;
  const x = center - width / 2;
  facadeRectangle(batch,frame,x-.034,y-.02,width+.068,height+.081,.009,0xebd7b9);
  facadeRectangle(batch,frame,x,y,width,height,.012,0x453e36);
  const frameColor = 0xa69576;
  facadeRectangle(batch,frame,x+.023,y+.023,width-.046,height-.046,.014,0x6e7164);
  facadeRectangle(batch,frame,center-.009,y,.018,height,.016,frameColor);
  facadeRectangle(batch,frame,x,y+height*.58,width,.015,.016,frameColor);
  cuboid(batch,frame,x-.048,y+height+.037,-.008,width+.096,.027,.058,0xd8bb96);
  cuboid(batch,frame,x-.054,y-.026,-.008,width+.108,.033,.078,0xdbc19e);
  for (const left of [x - width*.4 - .02, x + width + .02]) {
    cuboid(batch,frame,left,y,.009,width*.4,height,.02,shutter);
    for (let slat = 1; slat < 6; slat++) {
      facadeRectangle(batch,frame,left+.012,y+height*slat/6,width*.4-.024,.007,.031,0x495745);
    }
  }
  if (flowers) {
    cuboid(batch,frame,x-.046,y-.077,.024,width+.092,.05,.093,0xa96d51);
    cuboid(batch,frame,x-.058,y-.038,.017,width+.116,.02,.116,0xbd7a61);
    wallPlant(batch,frame,center,y-.016,.09,width*.69,.043,33,rng,rng() < .5);
  }
}

function wallPlant(batch, frame, center, y, depth, spread, height, count, rng, flowering) {
  const leaves = [0x354b28,0x4c6735,0x6e8745,0x8b9d53,0x799248];
  const blooms = [0xb26182,0xd78e9f,0xe9c26c,0x864c78];
  for (let i = 0; i < count; i++) {
    const angle = rng() * 2 * Math.PI;
    const radius = Math.sqrt(rng());
    const u = center + spread * radius * Math.cos(angle);
    const h = y + height * radius * Math.sin(angle);
    const d = depth + rng() * .046;
    const size = .029 + rng() * .043;
    const point = (dx,dy,dz) => frame(u + dx * size,h + dy * size,d + dz * size);
    const tone = flowering && i % 5 === 0 ? blooms[i % blooms.length] : leaves[i % leaves.length];
    batch.face([point(-.62,-.32,0),point(-.19,.53,-.2),point(.67,.18,0),point(.21,-.45,.57)],tone);
    batch.face([point(-.42,0,-.42),point(.54,0,-.35),point(.25,.24,.59),point(-.2,.23,.62)],tone);
  }
}

function wallPot(batch, edge, center, scale, rng, flowers) {
  const depth = .092 * scale;
  const point = (theta,r,y) => edge.point(center + Math.cos(theta) * r * scale,y * scale,depth + Math.sin(theta) * r * scale);
  const bands = [[.077,.006],[.11,.121],[.124,.124],[.125,.153],[.097,.154],[.094,.128]];
  const tones = [0xa06248,0xb97756,0xc58560,0xd59970,0x986446];
  for (let i = 0; i < 10; i++) {
    const a = i * Math.PI / 5, b = (i + 1) * Math.PI / 5;
    for (let j = 1; j < bands.length; j++) {
      batch.face([point(a,...bands[j-1]),point(b,...bands[j-1]),point(b,...bands[j]),point(a,...bands[j])],tones[j-1]);
    }
  }
  const foliage = [0x495d38,0x637b46,0x7b9150,0x536f42];
  for (let cluster = 0; cluster < 5; cluster++) {
    const u = center + (rng()-.5)*.17*scale;
    const h = (.205+rng()*.11)*scale;
    const d = depth + (rng()-.3)*.074*scale;
    const radius = (.061+rng()*.035)*scale;
    const tip = edge.point(u,h+radius,d);
    const base = edge.point(u,h-radius*.82,d);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * .4;
      const b = a + Math.PI * .4;
      const left = edge.point(u + Math.cos(a)*radius,h,d + Math.sin(a)*radius);
      const right = edge.point(u + Math.cos(b)*radius,h,d + Math.sin(b)*radius);
      batch.face([tip,left,right],foliage[(cluster+i)%foliage.length]);
      batch.face([base,right,left],foliage[0]);
    }
  }
  wallPlant(batch,edge.point,center,.273*scale,depth,.131*scale,.117*scale,48,rng,flowers);
}

function leafMass(batch, frame, u, y, depth, width, height, thick, rng, colors) {
  const sides = 9;
  const rings = 4;
  const point = (ring, side) => {
    const phi = Math.PI * ring / rings;
    const theta = Math.PI * 2 * side / sides;
    return frame(u + Math.sin(phi)*Math.cos(theta)*width,
      y + Math.cos(phi)*height, depth + Math.sin(phi)*Math.sin(theta)*thick);
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < sides; side++) {
      batch.face([point(ring,side),point(ring+1,side),point(ring+1,side+1),point(ring,side+1)],
        colors[Math.floor(rng()*colors.length)]);
    }
  }
}

function woodyBranch(batch, frame, a, b, width) {
  const x = b[0]-a[0], y = b[1]-a[1];
  const length = Math.hypot(x,y);
  const dx = y/length*width, dy = -x/length*width;
  batch.face([frame(a[0]-dx,a[1]-dy,a[2]),frame(b[0]-dx*.46,b[1]-dy*.46,b[2]),
    frame(b[0]+dx*.46,b[1]+dy*.46,b[2]),frame(a[0]+dx,a[1]+dy,a[2])],0x776242);
  batch.face([frame(a[0],a[1],a[2]+width),frame(b[0],b[1],b[2]+width*.46),
    frame(b[0]+dx*.46,b[1]+dy*.46,b[2]),frame(a[0]+dx,a[1]+dy,a[2])],0x998061);
}

function facadeGarden(batch, edge, center, rng, cypress = false) {
  const frame = edge.point;
  if (cypress) {
    // The root and stem sit inside the solid building footprint. This is
    // corner planting, not a new obstacle in a driveable street or court.
    woodyBranch(batch,frame,[center,.04,-.11],[center,1.72,-.11],.034);
    const colors = [0x354c32,0x435c36,0x526b3a,0x657b43,0x73894a];
    leafMass(batch,frame,center,1.07,-.12,.19,.79,.20,rng,colors);
    for (let i = 0; i < 7; i++) {
      leafMass(batch,frame,center + (rng()-.5)*.17,.56+i*.16,-.025,
        .10+rng()*.045,.17+rng()*.10,.10,rng,colors);
    }
    return;
  }
  // An espalier olive: branching is flat to the facade and the crown is
  // above the tank body. Nothing adds a free-standing trunk to a passage.
  woodyBranch(batch,frame,[center,.035,-.022],[center-.035,.77,.06],.043);
  const colors = [0x53643b,0x687945,0x7b8b55,0x91a16a,0xa0ac76];
  for (const [offset, h] of [[-.29,.95],[.27,1.06],[-.08,1.26]]) {
    woodyBranch(batch,frame,[center-.035,.53,.065],[center+offset,h,.08],.027);
    leafMass(batch,frame,center+offset,h,.10,.25,.22,.16,rng,colors);
    leafMass(batch,frame,center+offset*.8,h+.12,.10,.19,.17,.14,rng,colors);
  }
}

function marketDisplay(batch, edge, center, width, rng) {
  const frame = edge.point;
  // A shallow wall-mounted counter remains inside the tank's existing
  // collision clearance, below a hanging canvas roof.
  cuboid(batch,frame,center-width/2,.24,.016,width,.07,.145,0x7c5b39);
  cuboid(batch,frame,center-width/2-.018,.30,.006,width+.036,.035,.173,0xb18a57);
  const boxes = Math.max(2, Math.floor(width/.27));
  for (let box = 0; box < boxes; box++) {
    const x = center-width/2+(box+.12)*width/boxes;
    const w = width/boxes*.76;
    cuboid(batch,frame,x,.335,.022,w,.027,.131,0x675138);
    for (const end of [x,x+w-.017]) cuboid(batch,frame,end,.35,.021,.017,.073,.14,0xb18a57);
    cuboid(batch,frame,x,.35,.148,w,.051,.016,0xa77d4f);
    for (let item = 0; item < 7; item++) {
      const fruit = [0xbb5a37,0xd2a443,0x8e9f51][box%3];
      leafMass(batch,frame,x+.035+rng()*(w-.07),.385+rng()*.025,.065+rng()*.06,
        .031,.028,.028,rng,[fruit,fruit,0xc2aa65]);
    }
  }
}

function hangingSign(batch, edge, at, y, width, color) {
  const frame = edge.point;
  for (const u of [at-width*.37,at+width*.37]) {
    cuboid(batch,frame,u-.009,y+.09,.024,.018,.12,.021,0x665b47);
  }
  cuboid(batch,frame,at-width/2,y-.025,.037,width,.145,.03,0x79593b);
  facadeRectangle(batch,frame,at-width/2+.024,y-.004,width-.048,.099,.069,color);
  for (const u of [-.11,0,.11]) {
    facadeRectangle(batch,frame,at+u-.025,y+.024,.05,.025,.072,0xd9c48f);
  }
}

function awning(batch, edge, center, width, y, color, reach = .39) {
  const point = edge.point;
  const stripes = Math.round(width / .15);
  const step = width / stripes;
  for (let i = 0; i < stripes; i++) {
    const x = center - width / 2 + i * step;
    const tone = i % 2 ? 0xf0e1c6 : color;
    const fabric = (u,t) => point(u,y-.11*t-.058*Math.sin(Math.PI*t),.018+(reach-.018)*t);
    for (let segment = 0; segment < 4; segment++) {
      const a = segment/4, b = (segment+1)/4;
      batch.face([fabric(x,a),fabric(x,b),fabric(x+step,b),fabric(x+step,a)],tone);
    }
    batch.face([point(x,y-.11,reach+.003),point(x+step,y-.11,reach+.003),point(x+step,y-.15,reach+.003),
      point(x+step*.5,y-.178,reach+.008),point(x,y-.15,reach+.003)],tone);
  }
  cuboid(batch,point,center-width/2,y-.125,reach-.024,width,.015,.022,0x8b6b53);
}

function civicPorch(batch, edge, center, width) {
  const point = edge.point;
  for (const [inset,y,height] of [[0,.018,.036],[.04,.054,.034],[.08,.088,.032]]) {
    cuboid(batch,point,center-width/2+inset,y,-.015,width-2*inset,height,.23-inset,0xbea180);
  }
  for (const position of [center-width*.42,center+width*.42]) {
    cuboid(batch,point,position-.088,.12,.033,.176,.075,.14,0xc7aa85);
    cuboid(batch,point,position-.064,.195,.055,.128,.945,.094,0xe6cda8);
    cuboid(batch,point,position-.064,.218,.152,.025,.90,.019,0xc7aa85);
    cuboid(batch,point,position-.082,1.14,.035,.164,.067,.146,0xc8af8d);
  }
  cuboid(batch,point,center-width/2,1.196,-.014,width,.051,.224,0xba9d7e);
  cuboid(batch,point,center-width/2,1.248,-.016,width,.034,.229,0xf1d8b1);
  batch.face([point(center-width/2,1.278,.204),point(center,1.493,.204),point(center+width/2,1.278,.204)],0xcbaa83);
  batch.face([point(center-width/2-.022,1.274,.234),point(center,1.528,.234),point(center+width/2+.022,1.274,.234),
    point(center+width/2-.105,1.294,.234),point(center,1.471,.234),point(center-width/2+.105,1.294,.234)],0xefd5ad);
  const crest = [];
  for (let i = 0; i < 12; i++) {
    const angle = Math.PI * i / 6;
    crest.push(point(center + .057 * Math.cos(angle),1.354 + .057 * Math.sin(angle),.218));
  }
  batch.face(crest,0xe3c096);
}

function fixedLantern(batch, edge, position, y) {
  const frame = edge.point;
  cuboid(batch,frame,position-.045,y+.075,.016,.09,.015,.089,0x57574a);
  cuboid(batch,frame,position-.036,y+.02,.085,.072,.055,.061,0xb78d56);
  cuboid(batch,frame,position-.045,y+.015,.079,.09,.010,.073,0x57574a);
  cuboid(batch,frame,position-.047,y+.073,.078,.094,.019,.075,0x57574a);
  for (const x of [position-.036,position+.028]) {
    cuboid(batch,frame,x,y+.02,.083,.009,.061,.066,0x595848);
  }
}

function facade(building, style, edge, doors, batches, rng, index) {
  const { point, length } = edge;
  const fabric = batches.detail;
  const shutters = [0x63794e,0x456e5a,0x5c7068,0x667347];
  const shutter = shutters[(building.id.length + index) % shutters.length];
  const exposure = point(length/2,0,.025);
  const offMap = exposure[0] < 0 || exposure[2] < 0 || exposure[0] > batches.width || exposure[2] > batches.height;
  const panels = Math.max(1, Math.round(length/2.5));
  for (let i = 0; i < panels; i++) {
    const [left,right] = [length * i/panels,length * (i+1)/panels];
    const tone = style.plaster[(i + index) % style.plaster.length];
    facadeRectangle(batches.plaster,point,left,0,right-left,style.eave,.001,tone,1.44);
    if (i) facadeRectangle(fabric,point,left-.009,.056,.018,style.eave-.077,.003,0xc3a689);
  }
  facadeRectangle(fabric,point,0,.009,length,.136,.004,0xa3917d);
  for (let row = 0; row < 2; row++) {
    for (let a = row ? -.1 : 0; a < length; a += .217) {
      const left = Math.max(0,a+.009);
      const w = Math.min(a+.213,length)-left;
      if (w <= 0) continue;
      const tone = [0xc7b496,0xb8a287,0xd4be9f,0xb69e85][Math.floor(rng()*4)];
      facadeRectangle(fabric,point,left,.014+row*.058,w,.052,.006,tone);
    }
  }

  for (const end of [0,length-.085]) {
    if (end < 0) continue;
    for (let i = 0; i < Math.floor((style.eave-.19)/.112); i++) {
      const w = i % 2 ? .08 : .137;
      const pos = end ? length - w : 0;
      facadeRectangle(fabric,point,pos,.152+i*.112,w,.098,.006,i%2?0xd3b798:0xc7ad8d);
    }
  }
  if (offMap) return;
  const civicFront = building.id === 'townhall' && index === 2;

  const occurrences = doors.flatMap(door => {
    const [[a, da],[b, db]] = door.p.map(([x,z]) => edge.local(x,z));
    if (Math.abs(da) > .0001 || Math.abs(db) > .0001 || Math.min(a,b) < -.0001 || Math.max(a,b) > length + .0001) return [];
    return [{ left:Math.min(a,b), right:Math.max(a,b), center:(a+b)/2, name:door.name }];
  });
  for (const door of occurrences) {
    const civic = building.id === 'townhall';
    archedDoor(fabric,edge,door.center,door.right-door.left,civic ? .98 : .79,
      civic ? 0x694a37 : building.id === 'market' ? 0x66513b : 0x705641);
    if (building.id === 'trade' && /Лавка|Магазин/.test(door.name)) {
      awning(fabric,edge,door.center,Math.min(door.right-door.left+.40, 1.12),1.01,index % 2 ? 0xc5aa80 : 0xd7b88b);
    }
    if (building.id === 'market' && /главный/.test(door.name)) {
      awning(fabric,edge,door.center,1.28,1.04,0xd9c6a1,.47);
    }
    if (building.id === 'trade' && index === 2) {
      awning(fabric,edge,door.center,1.72,1.07,0xd5bd96,.59);
    }
    if (civic) civicPorch(fabric,edge,door.center,door.right-door.left+.52);
    for (const x of [door.left-.17,door.right+.17]) {
      if (x > .16 && x < length-.16) fixedLantern(fabric,edge,x,.481);
    }
  }

  if (building.id === 'market' && index === 1) {
    awning(fabric,edge,1.70,2.86,style.eave-.05,0xdccaaa,.61);
    marketDisplay(fabric,edge,1.70,2.52,rng);
  }
  if (building.id === 'trade' && index === 2) {
    marketDisplay(fabric,edge,.72,.94,rng);
    hangingSign(fabric,edge,.72,.83,.53,0x526c4b);
  }
  if (building.id === 'trade' && index === 6) {
    hangingSign(fabric,edge,length*.68,.91,.67,0x865d45);
  }
  if (civicFront) {
    // A closed civic facade gives the southern street a recognizable
    // landmark; the approved entrance/collision data remains untouched.
    archedDoor(fabric,edge,length/2,.94,.98,0x73533a);
    civicPorch(fabric,edge,length/2,1.67);
    for (const u of [length/2-.95,length/2+.95]) fixedLantern(fabric,edge,u,.73);
  }
  const planted = PLANTED_EDGES[building.id]?.includes(index);
  if (planted) {
    // Keep pots close to corners so streets and courtyard centers stay open.
    for (const [at,scale] of [[.33,1.77],[length-.34,1.49]]) {
      if (occurrences.some(door => at > door.left-.22 && at < door.right+.22)) continue;
      wallPot(fabric,edge,at,scale,rng,(index + building.id.length) % 3 !== 1);
    }
    if (length > 1.8 && ['trade','east-upper','east-main'].includes(building.id)) {
      const corner = occurrences.some(door => door.left < .68) ? length-.26 : .26;
      if (!occurrences.some(door => corner > door.left-.24 && corner < door.right+.24)) {
        for (let rung = 0; rung < 8; rung++) {
          wallPlant(fabric,point,corner + Math.sin(rung*.94)*.105,.20+rung*.13,.066,.19,.14,32,rng,rung > 2);
        }
        wallPlant(fabric,point,corner+.15,.91,.075,.32,.20,85,rng,true);
      }
    }
  }

  if (index === 2 && ['townhall','north-homes','southwest'].includes(building.id)) {
    facadeGarden(fabric,edge,length-.19,rng,true);
    if (building.id === 'townhall') facadeGarden(fabric,edge,.19,rng,true);
  }
  if ((building.id === 'east-upper' && index === 4) || (building.id === 'trade' && index === 6)) {
    facadeGarden(fabric,edge,length-.57,rng);
  }
  if (building.id === 'east-main' && index === 2) {
    facadeGarden(fabric,edge,.22,rng,true);
    wallPlant(fabric,point,length*.52,.78,.082,.69,.25,170,rng,true);
  }

  const windowCount = Math.floor(length/1.06);
  for (let i = 0; i < windowCount; i++) {
    const center = (.5 + i) * length / windowCount;
    const blocked = occurrences.some(door => center > door.left-.38 && center < door.right+.38);
    if (blocked || (civicFront && Math.abs(center-length/2) < .83)) continue;
    const openingWidth = building.id === 'market' ? .31 : .29;
    const openingHeight = building.id === 'market' ? .35 : .37;
    windowFrame(edge,fabric,center,.43 + rng()*.025,openingWidth,openingHeight,shutter,
      !building.context && (planted || (i+index)%3 === 1) && (i+index)%2 === 0,rng);
  }
}

function groundContact(batch, edge, layout) {
  const mid = edge.point(edge.length/2,0,.04);
  if (mid[0] < 0 || mid[2] < 0 || mid[0] > layout.width || mid[2] > layout.height) return;
  const point = (u,depth) => edge.point(u,.018,depth);
  batch.face([point(0,-.005),point(0,.26),point(edge.length,.26),point(edge.length,-.005)],
    0xffffff,[[0,1],[0,0],[1,0],[1,1]]);
}

function buildDetailedTown(THREE, scene, layout) {
  const rng = seededRandom(158026);
  const batches = Object.fromEntries(['detail','plaster','roof','road','plaza','inlay','contact'].map(key => [key, new Faces(THREE)]));
  Object.assign(batches, { scene, width:layout.width, height:layout.height });
  ground(THREE,scene,layout,batches);
  for (const building of layout.buildings) {
    const style = HOUSES[building.id] ?? HOUSES.edge;
    const edges = boundary(building.shape);
    for (const [i, edge] of edges.entries()) {
      facade(building,style,edge,layout.doors,batches,rng,i);
      groundContact(batches.contact,edge,layout);
    }
    roof(THREE,building,style,edges,batches,rng);
  }
  function material(options = {}) {
    return new THREE.MeshStandardMaterial({vertexColors:true, roughness:.98, ...options});
  }
  const stones = stoneTexture(THREE,false);
  const square = stoneTexture(THREE,true);
  const plaster = plasterTexture(THREE);
  const tiles = roofTexture(THREE);
  batches.road.mesh(scene,material({map:stones,bumpMap:reliefMap(THREE,stones),bumpScale:.022,side:THREE.DoubleSide}));
  batches.plaza.mesh(scene,material({map:square,bumpMap:reliefMap(THREE,square),bumpScale:.011}));
  batches.inlay.mesh(scene,material({side:THREE.DoubleSide}));
  batches.plaster.mesh(scene,material({map:plaster,bumpMap:reliefMap(THREE,plaster),bumpScale:.009}),{cast:true});
  batches.detail.mesh(scene,material({side:THREE.DoubleSide}),{cast:true});
  batches.roof.mesh(scene,material({map:tiles,bumpMap:reliefMap(THREE,tiles),bumpScale:.031,roughness:.91}),{cast:true});
  batches.contact.mesh(scene,new THREE.MeshBasicMaterial({
    map:contactTexture(THREE),vertexColors:true,transparent:true,depthWrite:false,
    side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1
  }),{receive:false});
  return {};
}
