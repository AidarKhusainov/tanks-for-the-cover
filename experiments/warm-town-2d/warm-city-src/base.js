  // Top-down civic monument and firing objective. The outer stone footing
  // ends at the simulation's 1.8 × 1.8 base bounds.
  let civicBaseLayer;
  const civicBaseDensity = 180;
  const civicBaseLayerSize = 2.2;

  function baseOctagon(size, bevel) {
    const inner = size - bevel;
    return [[-inner, -size], [inner, -size], [size, -inner], [size, inner],
      [inner, size], [-inner, size], [-size, inner], [-size, -inner]];
  }

  function baseFill(c, points, color) {
    c.beginPath();
    c.moveTo(...points[0]);
    for (const point of points.slice(1)) c.lineTo(...point);
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  function baseCourse(c, outer, inner, top, edgeColors) {
    baseFill(c, outer, top);
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      baseFill(c, [outer[i], outer[j], inner[j], inner[i]], edgeColors[i]);
    }
  }

  function baseDisk(c, x, y, radius, color) {
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
  }

  function baseStoneLip(c, course) {
    for (const [i, point] of course.entries()) {
      const next = course[(i + 1) % course.length];
      const lit = i < 2 || i > 5;
      segment(c, ...point, ...next, '#5a3c2a79', .034);
      segment(c, point[0] - .009, point[1] - .010, next[0] - .009, next[1] - .010,
        lit ? '#fbdfb0cb' : '#d6b18491', .018);
    }
  }

  function baseStoneMarks(c) {
    let seed = 461;
    const rand = () => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      return (seed >>> 0) / 4294967296;
    };
    for (let i = 0; i < 680; i++) {
      const x = (rand() - .5) * 1.78, y = (rand() - .5) * 1.78;
      const highlight = rand() > .54, age = rand();
      c.fillStyle = highlight ? '#f9e7c05f' : '#6a47283e';
      c.fillRect(x, y, .005 + age * .023, .005 + rand() * .012);
    }
  }

  function paintCivicBase(c) {
    const plinth = baseOctagon(.9, 0);
    const footing = baseOctagon(.858, .05);
    const firstStep = baseOctagon(.770, .105);
    const secondStep = baseOctagon(.660, .148);
    const coping = baseOctagon(.564, .184);
    const capstone = baseOctagon(.510, .163);

    // A flat, contiguous footing fills even the squared collision corners.
    // Only its soft cast shadow extends beyond that footprint.
    c.save();
    c.shadowColor = '#4a321f85';
    c.shadowBlur = .108 * civicBaseDensity;
    c.shadowOffsetX = .10 * civicBaseDensity;
    c.shadowOffsetY = .13 * civicBaseDensity;
    baseFill(c, plinth, '#796044');
    c.restore();
    baseCourse(c, plinth, footing, '#bd9d70', ['#e4c396','#c9a880','#a78057','#916c4e','#735439','#9f7754','#d5ae7c','#e8c198']);
    baseCourse(c, footing, firstStep, '#c6aa7f', ['#d6b98c','#ddba87','#b18b61','#a78059','#846247','#946a49','#b8a078','#d6b587']);
    baseCourse(c, firstStep, secondStep, '#b3936b', ['#efd6a7','#d4b584','#b08b64','#8e6a4c','#75523a','#ac8960','#ddbc8c','#f5d4a4']);
    baseCourse(c, secondStep, coping, '#9c7e58', ['#dbbb86','#cfab74','#a38358','#826248','#6b4e39','#98744f','#caa878','#e3c28b']);
    baseCourse(c, coping, capstone, '#997755', ['#f0d3a2','#daba87','#af8c60','#906b4b','#71533c','#a6845a','#c6a177','#e2ba87']);
    const stone = c.createLinearGradient(-.5, -.5, .5, .5);
    stone.addColorStop(0, '#b69a76');
    stone.addColorStop(.45, '#9d8160');
    stone.addColorStop(1, '#826349');
    baseFill(c, capstone, stone);
    baseStoneMarks(c);
    for (const course of [footing, firstStep, secondStep, coping]) baseStoneLip(c, course);

    // Stagger the joints in each cut stone course and chip a few edges.
    for (const [index, span] of [.858, .770, .660].entries()) {
      const dx = index % 2 ? .174 : .085;
      for (const pos of [-.42 + dx, dx, .40 + dx]) {
        segment(c, pos, -span + .012, pos + .004, -span + .084, '#715442a8', .013);
        segment(c, pos, span - .012, pos - .007, span - .075, '#4e382b99', .015);
        segment(c, -span + .014, pos, -span + .081, pos + .009, '#75563a85', .013);
        segment(c, span - .011, pos, span - .075, pos - .003, '#533929a0', .011);
      }
    }
    for (const [x, y] of [[-.69,-.18],[-.63,.35],[.58,.32],[.22,.73],[.72,-.38],[-.30,-.70]]) {
      segment(c, x, y, x + .057, y + .018, '#f0cea157', .011);
      segment(c, x, y + .013, x + .028, y + .027, '#7751365c', .008);
    }

    // Bronze corner brackets are seated on stone, echoing the square's inlay.
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      c.save();
      c.scale(sx, sy);
      const bronze = c.createLinearGradient(.58, .56, .79, .81);
      bronze.addColorStop(0, '#987339');
      bronze.addColorStop(.35, '#d7ae5a');
      bronze.addColorStop(.55, '#f1c56b');
      bronze.addColorStop(1, '#866039');
      baseFill(c, [[.84,.84],[.61,.84],[.61,.80],[.71,.76],[.76,.71],[.80,.61],[.84,.61]], '#5b3e2a');
      baseFill(c, [[.816,.815],[.630,.815],[.630,.787],[.725,.749],[.750,.725],[.787,.630],[.816,.630]], bronze);
      segment(c, .640, .791, .795, .791, '#f9da908a', .015);
      segment(c, .792, .641, .792, .792, '#fff1b178', .012);
      baseDisk(c, .782, .780, .025, '#865924');
      baseDisk(c, .776, .774, .010, '#f7cc72');
      c.restore();
    }

    // Weathered inset plate. Its purpose stays legible against pale paving.
    tile(c, -.362, .325, .724, .216, .030, '#503b2b');
    tile(c, -.351, .335, .702, .188, .023, '#7e613e');
    segment(c, -.314, .341, .314, .341, '#d1a568', .013);
    for (const x of [-.304, .304]) baseDisk(c, x, .429, .017, '#e1bb75');
  }

  function drawBase(b) {
    if (!civicBaseLayer) {
      civicBaseLayer = document.createElement('canvas');
      civicBaseLayer.width = civicBaseLayer.height = Math.ceil(civicBaseDensity * civicBaseLayerSize);
      const c = civicBaseLayer.getContext('2d');
      c.scale(civicBaseDensity, civicBaseDensity);
      c.translate(civicBaseLayerSize / 2, civicBaseLayerSize / 2);
      paintCivicBase(c);
    }
    const { x, y } = b, online = b.hp > 0;
    const half = civicBaseLayerSize / 2;
    ctx.drawImage(civicBaseLayer, x - half, y - half, civicBaseLayerSize, civicBaseLayerSize);
    ctx.save();
    ctx.translate(x, y - .105);

    // Sun-and-gate seal. A high-relief bronze disk echoes the town hall cap.
    baseDisk(ctx, .037, .044, .353, '#4d302c68');
    baseDisk(ctx, 0, 0, .352, '#5b3e2f');
    baseDisk(ctx, 0, 0, .333, '#f4d296');
    baseDisk(ctx, .006, .009, .303, '#86603b');
    const brass = ctx.createLinearGradient(-.24, -.23, .24, .29);
    brass.addColorStop(0, online ? '#f4d088' : '#aa9e89');
    brass.addColorStop(.48, online ? '#cd9d4f' : '#867361');
    brass.addColorStop(1, online ? '#a97137' : '#685241');
    baseDisk(ctx, 0, 0, .277, brass);
    for (let i = 0; i < 16; i++) {
      const a = Math.PI * i / 8;
      const ax = Math.cos(a), ay = Math.sin(a);
      segment(ctx, ax * .235, ay * .235, ax * .264, ay * .264, online ? '#84582bba' : '#5d4d45b0', .013);
    }
    const gate = [[-.154,.116],[-.154,-.093],[-.116,-.093],[-.116,-.058],[-.082,-.058],[-.082,-.139],[-.045,-.139],[-.045,-.105],[-.017,-.105],[-.017,-.139],[.020,-.139],[.020,-.105],[.048,-.105],[.048,-.139],[.082,-.139],[.082,-.058],[.118,-.058],[.118,-.093],[.154,-.093],[.154,.116]];
    baseFill(ctx, gate, online ? '#72492c' : '#574538');
    segment(ctx, -.162, .116, .163, .116, '#fff0ab9d', .022);
    baseDisk(ctx, 0, .027, .045, online ? '#e4b967' : '#9f896d');
    tile(ctx, -.045, .027, .090, .087, 0, online ? '#e4b967' : '#9f896d');
    ctx.restore();
    text('БАЗА', x, y + .427, .182, '#f4dfba', 'center', 850);
  }
