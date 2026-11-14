  // Draw selected material crops onto the approved map. Source axes include
  // the corners of joined roofs, so the artwork bends at the same points as
  // the collision outline. Artwork from one quarter never extends into a road.
  const roofCrops = {
    'trade':      { at: [0, 0],     x: [241, 353, 585],       y: [120, 249, 352, 466] },
    'market':     { at: [349, 0],   x: [680, 798, 916],       y: [19, 290, 382] },
    'east-upper': { at: [590, 0],   x: [1017, 1193, 1322, 1548], y: [314, 430, 599] },
    'east-main':  { at: [590, 291], x: [1019, 1384],          y: [703, 855] },
    'north-homes':{ at: [0, 352],   x: [1064, 1313],          y: [20, 162] },
    'southwest':  { at: [253, 368], x: [241, 416],            y: [626, 854] },
    'townhall':   { at: [658, 449], x: [442, 632],            y: [727, 855] },
    'edge-0':     { at: [962, 289], x: [3, 81],               y: [111, 438] },
    'edge-3':     { at: [1042, 289],x: [1475, 1558],          y: [20, 222] }
  };
  roofCrops['edge-1'] = roofCrops['edge-0'];
  roofCrops['edge-2'] = roofCrops['edge-0'];
  const pavingCrops = {
    main: [0, 624, 552, 552],
    plaza: [1128, 365, 135, 166], compass: [1128, 532, 86, 86], court: [434, 516, 215, 75]
  };

  function cityPath(c, shape) {
    c.beginPath();
    for (let i = 0; i < shape.length; i++) {
      const [x, y] = shape[i];
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  }
  function cityFill(c, shape, color) {
    cityPath(c, shape);
    c.fillStyle = color;
    c.fill();
  }
  function cityRect(c, x, y, w, h, color) {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  }
  function cityStroke(c, shape, color, width) {
    cityPath(c, shape);
    c.lineWidth = width;
    c.strokeStyle = color;
    c.stroke();
  }
  function cityBox(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
  function cityAxis(shape, axis) { return [...new Set(shape.map(p => p[axis]))].sort((a, b) => a - b); }
  function cityNoise(x, y, material = 0) {
    const value = Math.sin(x * 127.1 + y * 311.7 + material * 74.7) * 43758.5453;
    return value - Math.floor(value);
  }

  function cityPaving(c, shape, crop, scale = 1 / 56, originX = 0, originY = 0, mirror = true) {
    const [sx, sy, sw, sh] = crop;
    const dx = sw * scale, dy = sh * scale;
    const xs = cityAxis(shape, 0), ys = cityAxis(shape, 1);
    c.save();
    cityPath(c, shape);
    c.clip();
    for (let j = Math.floor((ys[0] - originY) / dy); originY + j * dy < ys.at(-1); j++) {
      const y = originY + j * dy;
      for (let i = Math.floor((xs[0] - originX) / dx); originX + i * dx < xs.at(-1); i++) {
        const x = originX + i * dx;
        const flipX = mirror && i % 2 !== 0, flipY = mirror && j % 2 !== 0;
        c.save();
        c.translate(x + (flipX ? dx : 0), y + (flipY ? dy : 0));
        c.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        c.drawImage(cityMaterials, sx, sy, sw, sh, 0, 0, dx + .011, dy + .011);
        c.restore();
      }
    }
    c.restore();
  }
  function cityWash(c, x, y, rx, ry, color) {
    c.save();
    c.translate(x, y);
    c.scale(rx, ry);
    const wash = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    wash.addColorStop(0, color);
    wash.addColorStop(.48, color);
    wash.addColorStop(1, color.slice(0, 7) + '00');
    cityRect(c, -1, -1, 2, 2, wash);
    c.restore();
  }
  function cityCompass(c, x, y) {
    const [sx, sy, sw, sh] = pavingCrops.compass;
    const relief = document.createElement('canvas');
    relief.width = sw;
    relief.height = sh;
    const paint = relief.getContext('2d');
    paint.drawImage(cityMaterials, sx, sy, sw, sh, 0, 0, sw, sh);
    paint.globalCompositeOperation = 'destination-in';
    const mask = paint.createRadialGradient(sw / 2, sh / 2, 0, sw / 2, sh / 2, sw / 2);
    mask.addColorStop(0, '#fff');
    mask.addColorStop(.88, '#fff');
    mask.addColorStop(1, '#fff0');
    cityRect(paint, 0, 0, sw, sh, mask);
    c.drawImage(relief, x - .79, y - .79, 1.58, 1.58);
  }
  function paintGround(c) {
    const { plaza: p, tradeCourt } = CONFIG.CITY;
    cityPaving(c, cityBox(0, 0, 28, 18), pavingCrops.main, 1 / 53, -.43, .64, false);
    cityPaving(c, tradeCourt, pavingCrops.court, 1 / 54, 6.6, 4.8);
    cityWash(c, 7.9, 5.37, 1.8, .70, '#5b3a2329');
    cityWash(c, 22.8, 11.81, 4.1, 1.15, '#60462c33');
    cityWash(c, 25.32, 10.9, 2.2, 1.9, '#76533a29');
    // Broad, diffuse variations from traffic and sun. Solid geometry is
    // confined to the rendered buildings and base.
    for (const [x, y, rx, ry, tone] of [
      [2.75, 6.9, 1.58, 7.2, '#fae0b42f'], [17.9, 3.6, 2.9, 3.4, '#ffdfaa2b'],
      [11.6, 9.58, 7.9, 1.4, '#f3d5a73b'], [13.5, 17.23, 14, .86, '#f4d5a436'],
      [25.96, 14.7, .87, 2.5, '#fae2b225'], [10.83, 6.46, .7, 2.5, '#8b604325'],
      [3.4, 12.65, 2.1, 2.2, '#8d624430'], [17.33, 7.04, 2.45, 1.5, '#79513823']
    ]) cityWash(c, x, y, rx, ry, tone);

    const plaza = cityBox(p.x, p.y, p.w, p.h);
    cityPaving(c, plaza, pavingCrops.plaza, 1 / 54, p.x + .12, p.y + .16);
    cityWash(c, 13.65, 12.76, 5.3, 3.5, '#f6deb32d');
    for (const [inset, color, width] of [[0, '#9d7651', .046], [.065, '#f1d4a5', .064], [.16, '#a9865d', .028], [.30, '#fce2b4', .036]]) {
      cityStroke(c, cityBox(p.x + inset, p.y + inset, p.w - inset * 2, p.h - inset * 2), color, width);
    }
    for (const x of [p.x + .51, p.x + p.w - .51]) for (const y of [p.y + .50, p.y + p.h - .50]) {
      cityStroke(c, cityBox(x - .135, y - .135, .27, .27), '#9f794e9c', .021);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, dx = Math.cos(a), dy = Math.sin(a);
        segment(c, x + dx * .028, y + dy * .028, x + dx * .109, y + dy * .109, '#94704e', .020);
      }
    }
    cityCompass(c, 13.95, 11.53);
    for (const [x, y, angle] of [[6.83, 5.81, 0], [24.36, 10.73, Math.PI / 2], [16.77, 16.07, 0]]) {
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      cityRect(c, 0, 0, .24, .076, '#79614c');
      for (let i = 0; i < 4; i++) cityRect(c, .027 + i * .052, .022, .011, .045, '#cfaf85');
      c.restore();
    }
  }

  function paintCityRoof(c, { id, shape }) {
    const crop = roofCrops[id], xs = cityAxis(shape, 0), ys = cityAxis(shape, 1);
    const left = xs[0], top = ys[0], right = xs.at(-1), bottom = ys.at(-1);
    const xStops = xs.map(x => x === left ? x + .035 : x === right ? x - .036 : x);
    const yStops = ys.map(y => y === top ? y + .035 : y === bottom ? y - .055 : y);
    // Splitting along both source and destination corners steers the texture
    // around each shared wing instead of measuring it from a bounding box.
    for (let j = 1; j < ys.length; j++) {
      for (let i = 1; i < xs.length; i++) {
        const sx = crop.at[0] + crop.x[i - 1] - crop.x[0], sy = crop.at[1] + crop.y[j - 1] - crop.y[0];
        const sw = crop.x[i] - crop.x[i - 1], sh = crop.y[j] - crop.y[j - 1];
        const box = c.getTransform();
        // Round shared raster boundaries identically so resampling leaves no
        // translucent hairline on the roof between neighboring patches.
        const px = x => Math.round(x * box.a) / box.a, py = y => Math.round(y * box.d) / box.d;
        const x = px(xStops[i - 1]), y = py(yStops[j - 1]);
        c.drawImage(cityMaterials, sx, sy, sw, sh, x, y, px(xStops[i]) - x, py(yStops[j]) - y);
      }
    }
  }
  function cityExteriorEdge(shape, [p, q]) {
    return shape.some(([a, b], i) => {
      const [u, v] = shape[(i + 1) % shape.length];
      return a === u
        ? p[0] === a && q[0] === a && Math.min(p[1], q[1]) >= Math.min(b, v) && Math.max(p[1], q[1]) <= Math.max(b, v)
        : p[1] === b && q[1] === b && Math.min(p[0], q[0]) >= Math.min(a, u) && Math.max(p[0], q[0]) <= Math.max(a, u);
    });
  }
  function cityDoor(c, [[x, y], [u, v]], name) {
    const span = Math.hypot(u - x, v - y);
    const civic = name.startsWith('Ратуша');
    const awning = /Магазин|Лавка|Разгруз/.test(name);
    c.save();
    c.translate(x, y);
    c.rotate(Math.atan2(v - y, u - x));
    const stone = c.createLinearGradient(0, -.27, 0, .27);
    stone.addColorStop(0, '#d6b080');
    stone.addColorStop(.5, '#eed0a0');
    stone.addColorStop(1, '#a87a51');
    cityRect(c, -.029, -.15, span + .058, .3, '#705037');
    cityRect(c, -.018, -.135, span + .036, .27, stone);
    if (civic || awning) {
      // The awning/portico is inset on the building side of the playable edge.
      const roof = c.createLinearGradient(0, -.31, 0, .31);
      const fabric = name.startsWith('Магазин') ? '#d9bd85' : '#7b7b4c';
      roof.addColorStop(0, civic ? '#9b6042' : '#685d42');
      roof.addColorStop(.26, civic ? '#c78f5c' : fabric);
      roof.addColorStop(.50, civic ? '#e8bc82' : '#e2cca3');
      roof.addColorStop(.80, civic ? '#c08757' : fabric);
      roof.addColorStop(1, civic ? '#734b35' : '#5d5234');
      cityRect(c, -.033, -.292, span + .066, .584, '#67482e');
      cityRect(c, -.018, -.267, span + .036, .534, roof);
      for (let i = .061; i < span; i += civic ? .071 : .107) cityRect(c, i, -.254, .012, .508, '#60492270');
      segment(c, 0, -.268, span, -.268, '#fad4a3', .025);
      segment(c, 0, .268, span, .268, '#f4ca9a', .021);
    }
    cityRect(c, .065, -.095, span - .130, .190, '#7b5437');
    cityRect(c, .082, -.069, span - .164, .138, civic ? '#9e7550' : '#aa8159');
    for (let i = .13; i < span - .08; i += .066) cityRect(c, i, -.064, .012, .128, '#73523d');
    segment(c, 0, 0, span, 0, '#e7c597', .031);
    c.restore();
  }
  function cityPlant(c, x, y, radius, seed, flowering) {
    for (let i = 0; i < 40; i++) {
      const angle = cityNoise(i, seed) * Math.PI * 2;
      const r = Math.sqrt(cityNoise(i, seed, 3)) * radius;
      const xx = x + r * Math.cos(angle), yy = y + r * Math.sin(angle) * .56;
      const leaf = ['#403f24', '#536034', '#6e7840', '#7d803f', '#a2a158'][Math.floor(cityNoise(i, seed, 8) * 5)];
      const a = .024 + cityNoise(i, seed, 9) * .038;
      tile(c, xx, yy, a, a * .62, .020, leaf);
      if (flowering && cityNoise(i, seed, 6) > .69) {
        tile(c, xx + .012, yy - .016, .031, .028, .012, i % 2 ? '#da938b' : '#aa4c55');
      }
    }
  }
  function paintCityCover(c) {
    const { buildings, doors } = CONFIG.CITY;
    for (const { shape } of buildings) {
      const [x, y] = shape[0];
      c.save();
      c.shadowBlur = 11;
      c.shadowOffsetX = 7;
      c.shadowOffsetY = 9;
      c.shadowColor = '#523b27ab';
      cityFill(c, shape, '#897153');
      c.restore();
      // Thin contact shadow stays visibly attached to the masonry.
      c.save();
      c.translate(.075, .095);
      c.shadowBlur = 3;
      c.shadowColor = '#47322169';
      cityFill(c, shape, '#47322158');
      c.restore();
      cityWash(c, x + .18, y + .24, .41, .36, '#9a6e3923');
    }
    for (const building of buildings) {
      const { id, shape } = building;
      c.save();
      cityPath(c, shape);
      c.clip();
      cityFill(c, shape, '#786044');
      paintCityRoof(c, building);
      cityStroke(c, shape, '#6e5238a0', .042);
      for (const { p, name } of doors) if (cityExteriorEdge(shape, p)) cityDoor(c, p, name);
      for (const [x, y, r, seed] of ({
        trade: [[5.36, 8.50, .31, 72], [7.54, 8.54, .33, 54], [9.16, 4.79, .21, 62], [5.29, 2.52, .19, 81]],
        'east-main': [[20.03, 15.61, .27, 94], [21.83, 15.65, .36, 65], [22.32, 13.04, .23, 67]],
        'east-upper': [[20.16, 10.89, .38, 73], [23.66, 10.96, .22, 90], [27.20, 8.08, .27, 79]],
        'north-homes': [[19.67, 2.89, .24, 74]],
        townhall: [[9.07, 15.62, .17, 66], [11.43, 15.63, .22, 99]],
        market: [[12.82, 6.92, .19, 96]]
      })[id] ?? []) cityPlant(c, x, y, r, seed, id === 'trade' || id === 'east-main');
      c.restore();
    }
  }
