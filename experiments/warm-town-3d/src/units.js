const AIM_HEIGHT = 0.43;
const TEAM = {
  player: { body: 0x204e50, top: 0x3c7977, ink: 0xc2e7d8 },
  light: { body: 0x743d32, top: 0xad604a, ink: 0xf0b497 },
  medium: { body: 0x6b4b22, top: 0x9d7737, ink: 0xefca83 },
  heavy: { body: 0x473c4b, top: 0x76596f, ink: 0xe3c6dd },
  wreck: { body: 0x3a322b, top: 0x635142, ink: 0xe3d2ad }
};

class Models {
  constructor() {
    this.materials = new Map();
    this.tankParts = new Map();
    this.partGeometry = new WeakMap();
    this.armorMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: .69, metalness: .20
    });
    this.masonryMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: .94, metalness: .03
    });
    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.bevelGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    this.wheelFaceGeometry = new THREE.CircleGeometry(1, 8);
    this.plateGeometry = this.createPlateGeometry();
    this.ringGeometry = new THREE.RingGeometry(.85, 1, 40).rotateX(-Math.PI / 2);
    this.selectionGeometry = new THREE.RingGeometry(.917, 1, 40).rotateX(-Math.PI / 2);
    this.shellGeometry = new THREE.SphereGeometry(1, 10, 6);
    this.hiddenShell = [0xf2bf7c, 0xb5e7d7].map(color => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: .52, depthFunc: THREE.GreaterDepth, depthWrite: false
    }));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 9, 32, 32, 31);
    gradient.addColorStop(0, '#252119a8');
    gradient.addColorStop(.52, '#27201964');
    gradient.addColorStop(1, '#27201900');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1
    });
    this.shadowGeometry = new THREE.PlaneGeometry(1.54, 1.42).rotateX(-Math.PI / 2);
  }

  material(color, unlit = false) {
    const key = color + ':' + unlit;
    if (!this.materials.has(key)) {
      const Kind = unlit ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
      this.materials.set(key, new Kind({ color }));
    }
    return this.materials.get(key);
  }

  add(parent, geometry, material, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  box(parent, color, x, y, z, sx, sy, sz, unlit = false) {
    return this.add(parent, this.boxGeometry, this.material(color, unlit), x, y, z, sx, sy, sz);
  }

  cylinder(parent, color, x, y, z, sx, sy, sz) {
    const mesh = this.add(parent, this.bevelGeometry, this.material(color), x, y, z, sx, sy, sz);
    mesh.rotation.y = Math.PI / 8;
    return mesh;
  }

  createPlateGeometry() {
    const shape = new THREE.Shape([
      [-.385, -.465], [.385, -.465], [.465, -.385], [.465, .385],
      [.385, .465], [-.385, .465], [-.465, .385], [-.465, -.385]
    ].map(([x, y]) => new THREE.Vector2(x, y)));
    // The bevel stays inside the original unit bounds; light catches the
    // armor edges without enlarging the silhouette or its collision proxy.
    return new THREE.ExtrudeGeometry(shape, {
      depth: .88, bevelEnabled: true, bevelThickness: .06,
      bevelSize: .035, bevelSegments: 1, steps: 1
    }).rotateX(-Math.PI / 2).translate(0, -.44, 0);
  }

  plate(parent, color, x, y, z, length, height, width) {
    return this.add(parent, this.plateGeometry, this.material(color), x, y, z, length, height, width);
  }

  axle(parent, color, x, y, z, radius, length, axis) {
    const mesh = this.add(parent, this.bevelGeometry, this.material(color), x, y, z, radius, length, radius);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    return mesh;
  }

  // Combine the painted parts so each tank's hull and turret
  // use one draw call apiece. They can still rotate independently.
  bakeParts(parts, material = this.armorMaterial) {
    const positions = [];
    const normals = [];
    const colors = [];
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    for (const mesh of parts.children) {
      if (!this.partGeometry.has(mesh.geometry)) {
        this.partGeometry.set(mesh.geometry, mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry);
      }
      const geometry = this.partGeometry.get(mesh.geometry);
      const sourcePositions = geometry.getAttribute('position');
      const sourceNormals = geometry.getAttribute('normal');
      const { r, g, b } = mesh.material.color;
      mesh.updateMatrix();
      normalMatrix.getNormalMatrix(mesh.matrix);
      for (let i = 0; i < sourcePositions.count; i++) {
        position.fromBufferAttribute(sourcePositions, i).applyMatrix4(mesh.matrix);
        normal.fromBufferAttribute(sourceNormals, i).applyNormalMatrix(normalMatrix);
        positions.push(position.x, position.y, position.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(r, g, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Mesh(geometry, material);
  }

  createTankParts(kind, reinforced) {
    const wreck = kind === 'wreck';
    const { body: paint, top, ink } = TEAM[kind] || TEAM.medium;
    const body = new THREE.Group();
    const turret = new THREE.Group();
    const width = kind === 'light' ? .63 : kind === 'heavy' ? .80 : .73;
    const side = width / 2 - .07;
    const rubber = wreck ? 0x29231e : 0x222724;
    const steel = wreck ? 0x6f5540 : 0x7b8376;
    const iron = wreck ? 0x43352b : 0x343c39;
    for (const dir of [-1, 1]) {
      const z = side * dir;
      this.plate(body, rubber, 0, .145, z, 1.02, .222, .226);
      for (const x of [-.36, -.18, 0, .18, .36]) {
        const face = this.add(body, this.wheelFaceGeometry, this.material(steel),
          x, .143, z + dir * .114, .072, .072, 1);
        const hub = this.add(body, this.wheelFaceGeometry, this.material(iron),
          x, .143, z + dir * .118, .034, .034, 1);
        face.rotation.y = hub.rotation.y = dir > 0 ? 0 : Math.PI;
      }
      for (let tread = -4; tread <= 4; tread++) {
        const x = tread * .106;
        this.box(body, tread % 2 ? iron : steel, x, .261, z, .058, .018, .219);
      }
      this.plate(body, paint, -.07, .286, z - dir * .047, .68, .055, .144);
      this.plate(body, top, .31, .303, z, .28, .052, .219);
      this.plate(body, iron, -.405, .278, z, .159, .039, .222);
      this.box(body, wreck ? 0x604332 : 0x9a6346, -.425, .314, z + dir * .042, .068, .022, .052);
    }
    this.plate(body, paint, 0, .238, 0, 1.056, .218, 2 * (side + .032));
    this.plate(body, top, .012, .349, 0, .936, .106, 2 * (side + .037));
    if (!wreck) {
      // Broad painted recognition marks remain visible at the play camera.
      const marking = kind === 'player' ? 0xd8d5b4 : 0xbd9574;
      for (const z of [-side * .78, side * .78]) {
        this.box(body, marking, .264, .404, z, .105, .006, .068);
        this.box(body, paint, -.02, .407, z, .32, .008, .018);
      }
    }
    this.plate(body, iron, -.311, .405, 0, .192, .034, .294);
    for (const x of [-.363, -.328, -.293, -.258]) this.box(body, steel, x, .429, 0, .013, .013, .239);
    for (const z of [-side * .75, side * .75]) {
      this.box(body, iron, .386, .384, z, .087, .034, .067);
      this.box(body, wreck ? rubber : 0xdbcca0, .409, .397, z, .041, .023, .056);
    }
    const turretLength = kind === 'light' ? .437 : kind === 'heavy' ? .575 : .512;
    const turretWidth = width * (kind === 'light' ? .64 : .70);
    this.cylinder(turret, iron, 0, -.034, 0, turretLength * .42, .07, turretWidth * .42);
    this.plate(turret, paint, 0, .045, 0, turretLength, .174, turretWidth);
    this.plate(turret, top, -.027, .139, 0, turretLength * .82, .060, turretWidth * .83);
    if (!wreck) {
      const marking = kind === 'player' ? 0xd8d5b4 : 0xbd9574;
      this.box(turret, marking, .087, .172, 0, .044, .006, turretWidth * .64);
      if (kind === 'player') this.box(turret, marking, .016, .172, 0, .025, .006, turretWidth * .64);
      for (const z of [-1, 1]) {
        this.box(turret, iron, -.057, .061, z * turretWidth * .497, .131, .021, .008);
      }
    }
    this.cylinder(turret, iron, -.067, .178, .055, .087, .043, .087);
    this.cylinder(turret, top, -.067, .204, .055, .069, .025, .069);
    this.box(turret, steel, -.035, .220, .055, .051, .015, .014);
    this.plate(turret, iron, -.082, .184, -.107, .082, .037, .102);
    this.box(turret, wreck ? rubber : ink, -.083, .205, -.105, .052, .016, .079);
    this.plate(turret, paint, turretLength * .45, .022, 0, .17, .118, .18);
    const barrelLength = wreck ? .35 : .48;
    const barrelParts = new THREE.Group();
    barrelParts.position.set(.27, .021, 0);
    this.axle(barrelParts, iron, barrelLength * .5, 0, 0, .030, barrelLength, 'x');
    this.axle(barrelParts, top, .089, 0, 0, .045, .154, 'x');
    this.axle(barrelParts, steel, barrelLength - .036, 0, 0, .045, .067, 'x');
    this.axle(barrelParts, rubber, barrelLength - .002, 0, 0, .028, .017, 'x');
    if (wreck) {
      barrelParts.rotation.set(0, .17, -.22);
      for (const [x, z, rotation] of [[-.29, -.26, .51], [.25, .30, -.67], [.12, -.27, .20]]) {
        const scrap = this.plate(body, rubber, x, .431, z, .24, .055, .107);
        scrap.rotation.y = rotation;
      }
      if (reinforced) {
        for (const z of [-.32, .32]) {
          this.plate(body, 0xab8c56, .053, .482, z, .72, .065, .134);
          for (const x of [-.18, .29]) this.box(body, iron, x, .52, z, .041, .016, .097);
        }
      }
    }
    barrelParts.updateMatrixWorld(true);
    for (const mesh of barrelParts.children.slice()) turret.attach(mesh);
    return { body: this.bakeParts(body), turret: this.bakeParts(turret) };
  }

  tank(kind, reinforced = false) {
    const wreck = kind === 'wreck';
    const key = reinforced ? kind + '-reinforced' : kind;
    if (!this.tankParts.has(key)) this.tankParts.set(key, this.createTankParts(kind, reinforced));
    const parts = this.tankParts.get(key);
    const root = new THREE.Group();
    const body = parts.body.clone();
    const turret = parts.turret.clone();
    root.add(body, turret);
    this.add(root, this.shadowGeometry, this.shadowMaterial, .08, .028, -.015, 1, 1, 1);
    body.scale.y = wreck ? .73 : 1;
    turret.position.y = wreck ? .275 : AIM_HEIGHT;
    turret.rotation.z = wreck ? -.21 : 0;
    const { ink } = TEAM[kind] || TEAM.medium;
    const select = this.add(root, this.selectionGeometry, this.material(ink, true), 0, .044, 0, .65, 1, .65);
    select.visible = false;
    root.userData = { body, turret, select };
    return root;
  }

  base() {
    const masonry = new THREE.Group();
    for (const [size, height, thickness, color] of [
      [1.8, .05, .1, 0x9a8c73], [1.69, .133, .066, 0xd1b998],
      [1.56, .202, .072, 0x9f8a6c], [1.48, .257, .043, 0xd9c09e],
      [1.35, .297, .036, 0x735a41], [1.26, .375, .12, 0x6f6550],
      [1.29, .443, .040, 0xad9369], [1.16, .467, .023, 0x514e43]
    ]) {
      this.plate(masonry, color, 0, height, 0, size, thickness, size);
    }
    for (const x of [-.68, .68]) for (const z of [-.68, .68]) {
      this.plate(masonry, 0x97734c, x, .299, z, .235, .16, .235);
      this.plate(masonry, 0xc29759, x, .394, z, .204, .047, .204);
      this.plate(masonry, 0xdebc77, x, .433, z, .144, .039, .144);
    }
    this.axle(masonry, 0x373c31, 0, .489, 0, .389, .036);
    this.axle(masonry, 0xb99259, 0, .532, 0, .353, .046);
    this.axle(masonry, 0x63503a, 0, .559, 0, .301, .025);
    const ring = new THREE.TorusGeometry(.264, .012, 3, 24).rotateX(-Math.PI / 2);
    this.add(masonry, ring, this.material(0xe1bf79), 0, .575, 0, 1, 1, 1);
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const spoke = this.plate(masonry, 0xc7a467, .211 * Math.cos(angle), .579, .211 * Math.sin(angle),
        .109, .017, i % 2 ? .035 : .048);
      spoke.rotation.y = -angle;
    }
    this.axle(masonry, 0x98713c, 0, .59, 0, .165, .037);
    this.axle(masonry, 0xe2bd75, 0, .618, 0, .138, .028);
    const root = new THREE.Group();
    root.add(this.bakeParts(masonry, this.masonryMaterial));
    const lamp = this.add(root, this.bevelGeometry, new THREE.MeshBasicMaterial({ color: 0xffe094 }),
      0, .636, 0, .097, .019, .097);
    root.userData.lamp = lamp;
    return root;
  }

  shell(player) {
    const root = new THREE.Group();
    const halo = this.material(player ? 0x3c989a : 0xaa4627, true);
    const trail = this.material(player ? 0xbff7f0 : 0xffb35b, true);
    this.add(root, this.shellGeometry, halo, -.154, 0, 0, .252, .066, .066);
    this.add(root, this.shellGeometry, trail, -.138, .023, 0, .266, .043, .043);
    this.add(root, this.shellGeometry, this.material(0xfff3c8, true), .042, .030, 0, .071, .059, .059);
    const throughCover = this.add(root, this.shellGeometry, this.hiddenShell[Number(player)],
      -.17, .024, 0, .23, .029, .029);
    throughCover.renderOrder = 4;
    return root;
  }
}
