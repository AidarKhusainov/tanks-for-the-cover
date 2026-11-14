  // Vehicle sprites are painted once, on transparent canvases. Their tracks and
  // hull turn with the chassis while the turret keeps the simulation's aim.
  const vehiclePaint = {
    player: ['#30403b', '#54706c', '#839b90', '#bdc6af'],
    light: ['#57352b', '#a45847', '#c78060', '#efbc89'],
    medium: ['#57442c', '#9c753f', '#bc9856', '#e8c58a'],
    heavy: ['#493747', '#7d5b79', '#a47d93', '#d0aaba'],
    wreck: ['#38332c', '#615b4c', '#8f8167', '#b2a28a']
  };
  const vehicleSprites = new Map();
  const vehicleSpriteSize = 1.8;

  function vehiclePath(c, points) {
    c.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  }
  function vehiclePoly(c, points, paint) {
    vehiclePath(c, points);
    c.fillStyle = paint;
    c.fill();
  }
  function vehicleGradient(c, x, y, u, v, stops) {
    const gradient = c.createLinearGradient(x, y, u, v);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    return gradient;
  }
  function vehicleEllipse(c, x, y, rx, ry, paint) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = paint;
    c.fill();
  }
  function vehicleCasting(c, points, colors) {
    const [dark, paint, light, edge] = colors;
    vehiclePath(c, points);
    c.lineJoin = 'round';
    c.lineWidth = .025;
    c.strokeStyle = '#28241e';
    c.stroke();
    c.fillStyle = vehicleGradient(c, -.26, -.29, .34, .31, [
      [0, light], [.27, paint], [.62, paint], [1, dark]
    ]);
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = edge + '86';
    c.lineWidth = .018;
    c.translate(.013, .014);
    c.stroke();
    c.translate(-.029, -.032);
    c.strokeStyle = dark + 'c8';
    c.lineWidth = .029;
    c.stroke();
    c.restore();
  }
  function vehicleFastener(c, x, y, r = .016, cap = '#c5ad75') {
    vehicleEllipse(c, x + .006, y + .009, r + .004, r + .004, '#292a248d');
    vehicleEllipse(c, x, y, r, r, '#554834');
    vehicleEllipse(c, x - r * .16, y - r * .24, r * .65, r * .55, cap);
  }
  function vehicleWear(c, points, size, salt, amount) {
    c.save();
    vehiclePath(c, points);
    c.clip();
    const noise = i => {
      const value = Math.sin(i * 91.71 + salt * 51.17) * 43758.5453;
      return value - Math.floor(value);
    };
    for (let i = 0; i < amount; i++) {
      const x = (noise(i * 3) - .5) * size;
      const y = (noise(i * 3 + 1) - .5) * size;
      const r = .006 + noise(i * 3 + 2) * .009;
      vehicleEllipse(c, x, y, r * 1.6, r * .63, i % 3 ? '#f3d6a43d' : '#312a2354');
    }
    c.restore();
  }
  function vehicleTracks(c, damaged) {
    for (const y of [-.325, .325]) {
      tile(c, -.501, y - .096, 1.004, .192, .060, '#292621');
      tile(c, -.476, y - .082, .952, .163, .048, vehicleGradient(c, 0, y - .083, 0, y + .083, [
        [0, '#514c40'], [.31, '#817563'], [.53, '#413e35'], [1, '#65594a']
      ]));
      for (let i = 0; i < 13; i++) {
        const x = -.446 + i * .072;
        segment(c, x, y - .067, x + .010, y + .067, '#2d2a23', .018);
        segment(c, x + .015, y - .056, x + .025, y + .056, '#c1a886a6', .009);
      }
      for (const x of [-.444, .417]) vehicleFastener(c, x, y, .014, '#948269');
      if (damaged && y > 0) {
        vehiclePoly(c, [[.203, .409], [.335, .365], [.481, .399], [.473, .428], [.267, .414]], '#332c24');
        segment(c, .254, .410, .449, .431, '#9e7453', .014);
      }
    }
  }
  function vehicleFenders(c, colors, damaged) {
    const [dark, paint, light, edge] = colors;
    for (const side of [-1, 1]) {
      c.save();
      c.scale(1, side);
      const front = damaged && side > 0 ? .23 : .426;
      const panel = [[-.393, .271], [front - .025, .271], [front, .310], [front - .013, .366], [-.370, .381], [-.408, .348]];
      vehicleCasting(c, panel, colors);
      segment(c, -.34, .295, front - .045, .294, dark, .014);
      segment(c, -.35, .306, front - .045, .306, light, .009);
      tile(c, -.423, .274, .124, .114, .024, dark);
      tile(c, -.413, .281, .102, .092, .018, paint);
      segment(c, -.387, .293, -.325, .290, edge + 'a1', .013);
      if (!damaged || side < 0) {
        tile(c, .319, .265, .144, .108, .027, dark);
        tile(c, .323, .274, .129, .081, .020, light);
        segment(c, .361, .282, .429, .285, edge + '8c', .016);
      }
      for (const x of [-.346, -.071, .228]) vehicleFastener(c, x, .341, .014);
      c.restore();
    }
  }
  function vehicleDeck(c, colors, type) {
    const [dark, paint, light, edge] = colors;
    vehicleTracks(c, false);
    const plate = [[-.472, -.202], [-.392, -.269], [.345, -.267], [.468, -.182], [.465, .160], [.349, .250], [-.388, .260], [-.478, .168]];
    vehicleCasting(c, plate, colors);
    vehicleFenders(c, colors, false);
    tile(c, -.396, -.181, .257, .358, .025, dark);
    tile(c, -.383, -.166, .226, .332, .018, paint);
    tile(c, -.353, -.130, .101, .260, .013, '#272e29');
    for (let i = 0; i < 6; i++) {
      const y = -.112 + i * .045;
      segment(c, -.342, y, -.267, y, light, .015);
      segment(c, -.342, y + .012, -.267, y + .012, '#141e19a4', .008);
    }
    const nose = [[.259, -.198], [.378, -.195], [.439, -.143], [.439, .128], [.363, .186], [.258, .186]];
    vehicleCasting(c, nose, colors);
    segment(c, .358, -.153, .368, .148, dark, .016);
    segment(c, .346, -.143, .355, .144, edge + '83', .011);
    for (const [x, y] of [[-.409, -.187], [-.416, .182], [.381, -.204], [.381, .195], [.245, .202], [.245, -.207]]) {
      vehicleFastener(c, x, y, .018);
    }
    vehicleWear(c, plate, .9, type.length, 100);
  }
  function vehicleTurret(c, colors, type) {
    const [dark, paint, light, edge] = colors;
    const shell = type === 'heavy'
      ? [[-.227, -.220], [.108, -.232], [.235, -.129], [.229, .139], [.119, .220], [-.218, .202], [-.263, .096], [-.267, -.101]]
      : [[-.230, -.089], [-.148, -.204], [.023, -.220], [.152, -.171], [.220, -.068], [.204, .093], [.098, .188], [-.054, .213], [-.176, .160], [-.238, .062]];
    const bore = type === 'heavy' ? .73 : type === 'light' ? .62 : .68;
    const barrel = [[.119, -.068], [.311, -.044], [bore, -.025], [bore, .025], [.310, .048], [.119, .069]];
    vehiclePoly(c, barrel.map(([x, y]) => [x + .023, y + .051]), '#2b211e61');
    vehiclePoly(c, barrel, vehicleGradient(c, 0, -.06, 0, .06, [
      [0, '#2b281f'], [.26, light], [.44, edge], [.58, paint], [1, dark]
    ]));
    tile(c, bore - .038, -.033, .067, .067, .016, dark);
    segment(c, bore - .028, -.019, bore + .010, -.019, light, .015);
    vehicleEllipse(c, -.012, .039, .253, .219, '#28241eb5');
    vehicleCasting(c, shell, colors);
    tile(c, .154, -.078, .123, .157, .039, dark);
    tile(c, .166, -.062, .094, .117, .025, paint);
    segment(c, .181, -.052, .232, -.051, light, .016);
    vehicleEllipse(c, -.083, -.026, .090, .093, dark);
    vehicleEllipse(c, -.093, -.035, .072, .075, light);
    vehicleEllipse(c, -.087, -.030, .056, .055, paint);
    segment(c, -.113, -.038, -.058, -.039, '#e2c385', .015);
    tile(c, -.005, .075, .083, .062, .014, '#37372b');
    tile(c, .005, .083, .062, .030, .007, paint);
    vehicleFastener(c, -.151, .072, .022, '#d7ab62');
    vehicleFastener(c, .090, -.129, .019, edge);
    vehicleWear(c, shell, .54, 27 + type.length, 52);
  }
  function vehicleBurnt(c, heavy) {
    const colors = heavy ? ['#342b32', '#61545a', '#948077', '#b6a08c'] : vehiclePaint.wreck;
    vehicleTracks(c, true);
    const plate = [[-.464, -.205], [-.376, -.251], [.276, -.269], [.433, -.171], [.377, .007], [.302, .097], [.344, .239], [-.275, .257], [-.413, .193]];
    vehicleCasting(c, plate, colors);
    vehicleFenders(c, colors, true);
    vehiclePoly(c, [[-.330, -.184], [.152, -.204], [.282, -.053], [.252, .139], [.136, .216], [-.291, .123]], '#302a24');
    const scorch = c.createRadialGradient(.035, -.023, .037, .036, -.020, .32);
    scorch.addColorStop(0, '#1f1d19');
    scorch.addColorStop(.61, '#302820');
    scorch.addColorStop(1, '#59483800');
    vehicleEllipse(c, .036, -.020, .334, .272, scorch);
    const torn = [[-.220, -.025], [-.130, -.171], [.018, -.172], [.147, -.060], [.206, -.129], [.211, .068], [.132, .148], [.061, .064], [-.058, .121], [-.171, .113]];
    vehicleCasting(c, torn, colors);
    vehicleEllipse(c, -.042, -.036, .119, .093, '#2a251e');
    vehicleEllipse(c, -.054, -.050, .054, .033, '#59483a');
    segment(c, .091, .047, .195, .114, '#1f1a16', .025);
    segment(c, .210, -.069, .337, -.138, '#27231f', .049);
    segment(c, .211, -.082, .328, -.145, '#9e8061', .018);
    vehicleWear(c, plate, .91, 62, 116);
    for (const [x, y] of [[.231, .160], [.290, .097], [-.310, -.079], [.318, -.224], [-.209, .178]]) {
      vehicleFastener(c, x, y, .023, '#b07b56');
    }
  }
  function getVehicleSprite(type, part) {
    const key = `${type}:${part}`;
    if (vehicleSprites.has(key)) return vehicleSprites.get(key);
    const sprite = document.createElement('canvas'), resolution = 144;
    sprite.width = sprite.height = Math.round(vehicleSpriteSize * resolution);
    const c = sprite.getContext('2d');
    c.translate(sprite.width / 2, sprite.height / 2);
    c.scale(resolution, resolution);
    if (part === 'deck') vehicleDeck(c, vehiclePaint[type], type);
    else if (part === 'turret') vehicleTurret(c, vehiclePaint[type], type);
    else vehicleBurnt(c, type === 'heavy');
    vehicleSprites.set(key, sprite);
    return sprite;
  }
  function paintVehicleSprite(type, part, x, y, angle, length, width) {
    const sprite = getVehicleSprite(type, part), radius = vehicleSpriteSize / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(length, width);
    ctx.drawImage(sprite, -radius, -radius, vehicleSpriteSize, vehicleSpriteSize);
    ctx.restore();
  }
  function vehicleShadow(x, y, angle, length, width) {
    ctx.save();
    ctx.translate(x + .062, y + .089);
    ctx.rotate(angle);
    ctx.scale(length * .63, width * .51);
    const shade = ctx.createRadialGradient(0, 0, .17, 0, 0, 1);
    shade.addColorStop(0, '#36291ebf');
    shade.addColorStop(.71, '#37291d79');
    shade.addColorStop(1, '#3d2b1800');
    vehicleEllipse(ctx, 0, 0, 1, 1, shade);
    ctx.restore();
  }
  function wreckModel(w) {
    const heavy = w.type === 'heavy', size = heavy ? 1.03 : .92;
    const angle = (Number(String(w.id).slice(1)) || 0) * .8 + .35;
    vehicleShadow(w.x, w.y, angle, size, size);
    paintVehicleSprite(w.type, 'wreck', w.x, w.y, angle, size, size);
  }
  function tankModel(t, player, body, aim) {
    const type = player ? 'player' : t.type;
    const length = type === 'light' ? .88 : type === 'heavy' ? 1.06 : .98;
    const width = type === 'light' ? .82 : type === 'heavy' ? 1.04 : .96;
    vehicleShadow(t.x, t.y, body, length, width);
    paintVehicleSprite(type, 'deck', t.x, t.y, body, length, width);
    paintVehicleSprite(type, 'turret', t.x, t.y, aim, length, width);
  }
