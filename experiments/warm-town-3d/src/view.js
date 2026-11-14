const LANE_COLORS = { A: 0xdd9954, B: 0x78abb9, C: 0xaab579 };
const EFFECTS = {
  hit: [.15, 0xffe195], kill: [.28, 0xff8b45], death: [.28, 0xff8b45],
  wreckAppears: [.27, 0xf6e2ac], wreckBreaks: [.34, 0x5d4436], repair: [.26, 0xe1f0a8]
};

class View {
  constructor({ canvas, layout }, blockout) {
    this.canvas = canvas;
    this.layout = layout;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) {
      throw new Error('WebGL 2 unavailable');
    }
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    const gpu = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = gl.getParameter(gpu ? gpu.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    canvas.addEventListener('webglcontextrestored', () => {
      this.cacheDirty = true;
      this.renderer.shadowMap.needsUpdate = true;
    });
    this.scene = new THREE.Scene();
    this.townScene = new THREE.Scene();
    this.townScene.background = new THREE.Color(0x272d29);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .2, 100);
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2 - .16);
    this.camera.position.copy(center).add(new THREE.Vector3(0, 28, 17.5));
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.vector = new THREE.Vector3();
    this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -AIM_HEIGHT);
    this.layoutKey = '';

    const fill = new THREE.HemisphereLight(0xcbdcf2, 0xa28b6e, 1.05);
    const sun = new THREE.DirectionalLight(0xffe4bd, 3.25);
    sun.position.set(-1, 22, 17);
    sun.target.position.set(14, 0, 9);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -18, right: 18, bottom: -13, top: 13, near: 1, far: 42 });
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.normalBias = .016;
    sun.shadow.bias = -.00012;
    sun.shadow.radius = 7;
    sun.shadow.intensity = .82;
    this.townScene.add(fill, sun, sun.target);
    const unitSun = sun.clone();
    unitSun.castShadow = false;
    this.scene.add(fill.clone(), unitSun, unitSun.target);
    this.prepareTownCache();

    this.models = new Models();
    this.labels = new Map();
    this.actors = new Map();
    this.shells = new Map();
    this.impacts = new Map();
    buildTown(THREE, this.townScene, layout, { blockout });
    this.base = this.models.base();
    this.base.position.set(layout.base.x, 0, layout.base.y);
    this.models.add(this.base, this.models.shadowGeometry, this.models.shadowMaterial, .19, .028, -.04, 1.72, 1, 1.68);
    this.scene.add(this.base);
    this.addGroundMarks();

    this.routeGroup = new THREE.Group();
    this.routePaths = null;
    this.scene.add(this.routeGroup);
    this.breachGroup = new THREE.Group();
    this.scene.add(this.breachGroup);
    this.reticule = this.createReticule();
    this.scene.add(this.reticule);
    this.prepMarks = Array.from({ length: 3 }, (_, i) => {
      const mesh = this.models.add(this.scene, this.models.ringGeometry,
        this.models.material([0xf8cd89, 0xe5f39d, 0xade5e7][i], true), 0, .049, 0, .79, 1, .79);
      mesh.visible = false;
      return mesh;
    });
    this.undoMarks = [];
    this.observe = new ResizeObserver(() => this.resize());
    this.observe.observe(canvas);
    this.resize();
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const key = [width, height, ratio].join(':');
    if (!(width && height) || this.layoutKey === key) return;
    this.layoutKey = key;
    const aspect = width / height;
    const groundProjection = Math.abs(this.camera.getWorldDirection(this.vector).y);
    const frameHeight = this.layout.height * groundProjection + 1.48;
    const spanX = Math.max(this.layout.width + .62, frameHeight * aspect);
    const halfY = spanX / aspect / 2;
    Object.assign(this.camera, { left: -spanX / 2, right: spanX / 2, top: halfY, bottom: -halfY });
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.cacheDirty = true;
  }

  prepareTownCache() {
    // Retain the city's depth with its color so nearby facades still obscure units.
    // Float color attachments are optional in WebGL 2. The byte fallback
    // sacrifices highlight range, but keeps the complete town playable.
    const floatColor = this.renderer.extensions.has('EXT_color_buffer_float')
      || this.renderer.extensions.has('EXT_color_buffer_half_float');
    this.townCache = new THREE.WebGLRenderTarget(1, 1, {
      samples: 4,
      type: floatColor ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthTexture: new THREE.DepthTexture(1, 1),
      generateMipmaps: false
    });
    // Grade the static city once, rather than running the filmic curve on
    // every city pixel during combat. Keep the original depth for occlusion.
    this.gradedTown = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false, generateMipmaps: false
    });
    const material = new THREE.ShaderMaterial({
      depthFunc: THREE.AlwaysDepth,
      toneMapped: false,
      uniforms: {
        townColor: { value: this.gradedTown.texture },
        townDepth: { value: this.townCache.depthTexture }
      },
      vertexShader: `
        varying vec2 texCoord;
        void main() {
          texCoord = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D townColor;
        uniform sampler2D townDepth;
        varying vec2 texCoord;
        void main() {
          gl_FragColor = texture2D(townColor, texCoord);
          gl_FragDepth = texture2D(townDepth, texCoord).r;
          #include <colorspace_fragment>
        }
      `
    });
    const background = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    background.frustumCulled = false;
    this.screenScene = new THREE.Scene();
    this.screenScene.add(background);
    this.screenCamera = new THREE.Camera();
    this.gradeMaterial = new THREE.ShaderMaterial({
      toneMapped: false, depthTest: false, depthWrite: false,
      uniforms: {
        townColor: { value: this.townCache.texture },
        toneMappingExposure: { value: this.renderer.toneMappingExposure }
      },
      vertexShader: material.vertexShader,
      fragmentShader: `
        uniform sampler2D townColor;
        varying vec2 texCoord;
        #include <tonemapping_pars_fragment>
        void main() {
          gl_FragColor = vec4(ACESFilmicToneMapping(texture2D(townColor, texCoord).rgb), 1.0);
        }
      `
    });
    const grade = new THREE.Mesh(background.geometry, this.gradeMaterial);
    grade.frustumCulled = false;
    this.gradeScene = new THREE.Scene();
    this.gradeScene.add(grade);
  }

  paint() {
    const renderer = this.renderer;
    if (this.cacheDirty) {
      this.townCache.setSize(this.canvas.width, this.canvas.height);
      renderer.setRenderTarget(this.townCache);
      renderer.autoClear = true;
      renderer.render(this.townScene, this.camera);
      this.gradedTown.setSize(this.canvas.width, this.canvas.height);
      this.gradeMaterial.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
      renderer.setRenderTarget(this.gradedTown);
      renderer.render(this.gradeScene, this.screenCamera);
      renderer.setRenderTarget(null);
      this.cacheDirty = false;
    }
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(this.screenScene, this.screenCamera);
    renderer.render(this.scene, this.camera);
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.ray.setFromCamera(this.ndc, this.camera);
    const point = this.ray.ray.intersectPlane(this.aimPlane, this.vector);
    return point ? { x: point.x, y: point.z } : { x: 0, y: 0 };
  }

  worldToScreen(x, y, elevation = AIM_HEIGHT) {
    const rect = this.canvas.getBoundingClientRect();
    const projected = this.vector.set(x, elevation, y).project(this.camera);
    return {
      x: rect.left + (projected.x + 1) * .5 * rect.width,
      y: rect.top + (1 - projected.y) * .5 * rect.height,
      visible: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
    };
  }

  diagnostics() {
    const { render } = this.renderer.info;
    return { gpu: this.gpu, width: this.canvas.width, height: this.canvas.height,
      calls: render.calls, triangles: render.triangles };
  }

  label(value, color, size, depthTest = false) {
    const key = [value, color, size, depthTest].join('|');
    if (!this.labels.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = size === 1 ? 112 : 256;
      canvas.height = 56;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#262a24';
      ctx.beginPath();
      ctx.roundRect(3, 5, canvas.width - 6, 46, 8);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '700 32px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value, canvas.width / 2, 29);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      this.labels.set(key, new THREE.SpriteMaterial({ map, depthTest, depthWrite: false, toneMapped: false }));
    }
    const sprite = new THREE.Sprite(this.labels.get(key));
    sprite.scale.set(size, size === 1 ? .50 : .40, 1);
    sprite.renderOrder = 8;
    return sprite;
  }

  addGroundMarks() {
    const { returnPoint, spawns, base } = this.layout;
    this.models.add(this.scene, this.models.ringGeometry, this.models.material(0x5c827a, true),
      returnPoint.x, .034, returnPoint.y, .64, 1, .64);
    for (const [name, lane] of Object.entries(spawns)) {
      const incoming = lane.direction === 'left' ? [-1, 0] : [0, 1];
      const x = lane.x - incoming[0] * .93;
      const z = lane.y - incoming[1] * .89;
      const marker = this.label(name, '#' + LANE_COLORS[name].toString(16), 1);
      marker.scale.set(.72, .36, 1);
      marker.position.set(x, .18, z);
      this.scene.add(marker);
      const bar = this.models.box(this.scene, LANE_COLORS[name], x, .04, z, 1.27, .022, .075, true);
      if (incoming[0]) bar.rotation.y = Math.PI / 2;
      const left = lane.x - lane.w / 2;
      const right = lane.x + lane.w / 2;
      const top = lane.y - lane.h / 2;
      const bottom = lane.y + lane.h / 2;
      const boundary = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
        [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]
          .map(([x, z]) => new THREE.Vector3(x, .036, z))
      ), new THREE.LineDashedMaterial({
        color: LANE_COLORS[name], dashSize: .16, gapSize: .11, transparent: true, opacity: .72
      }));
      boundary.computeLineDistances();
      this.scene.add(boundary);
    }
    const baseLabel = this.label('БАЗА', '#fff0b8', 1.22);
    baseLabel.position.set(base.x, .64, base.y + .70);
    this.scene.add(baseLabel);
  }

  createReticule() {
    const root = new THREE.Group();
    const color = this.models.material(0xe0f9ec, true);
    const border = this.models.material(0x2a4f4c, true);
    const ring = this.models.add(root, this.models.ringGeometry, border, 0, 0, 0, .24, 1, .24);
    this.models.add(root, this.models.ringGeometry, color, 0, .004, 0, .205, 1, .205);
    for (const direction of [-1, 1]) {
      this.models.box(root, 0x2a4f4c, direction * .291, 0, 0, .12, .018, .042, true);
      this.models.box(root, 0x2a4f4c, 0, 0, direction * .291, .042, .018, .12, true);
    }
    root.userData.ring = ring;
    // A cursor over a facade still indicates the shot's projected ground-plane destination.
    root.traverse(node => {
      if (!node.isMesh) return;
      node.material = node.material.clone();
      node.material.depthTest = false;
      node.material.depthWrite = false;
      node.renderOrder = 10;
    });
    return root;
  }

  syncActors(frame) {
    const visible = new Set();
    const addActor = (actor, type) => {
      const variant = type + (actor.reinforced ? '-reinforced' : '');
      const key = actor.id;
      visible.add(key);
      let entry = this.actors.get(key);
      if (entry && entry.variant !== variant) {
        this.scene.remove(entry.model);
        entry = null;
      }
      if (!entry) {
        const model = this.models.tank(type, actor.reinforced);
        const team = TEAM[type];
        const backdrop = this.models.box(model, 0x292721, 0, .72, -.59, .62, .018, .091, true);
        const meter = this.models.box(model, team.ink, 0, .735, -.59, .59, .020, .064, true);
        backdrop.renderOrder = 5;
        meter.renderOrder = 6;
        // Only the occluded parts of the dim outline show through nearby rooftops.
        const outline = this.models.add(model, this.models.ringGeometry, new THREE.MeshBasicMaterial({
          color: team.ink, transparent: true, opacity: .57, depthFunc: THREE.GreaterDepth, depthWrite: false
        }), 0, .55, 0, .62, 1, .62);
        outline.renderOrder = 3;
        entry = { model, meter, variant };
        this.scene.add(model);
        this.actors.set(key, entry);
      }
      const { model, meter } = entry;
      const { body, turret, select } = model.userData;
      body.rotation.y = -(actor.bodyAngle ?? actor.angle ?? (type === 'wreck' ? .6 : 0));
      turret.rotation.y = -(actor.aimPoint
        ? Math.atan2(actor.aimPoint.y - actor.y, actor.aimPoint.x - actor.x)
        : actor.angle ?? (type === 'wreck' ? -.4 : 0));
      model.position.set(actor.x, 0, actor.y);
      const fraction = Math.max(0, Math.min(1, actor.hp / actor.maxHp));
      meter.scale.x = .59 * fraction;
      meter.position.x = -(.59 - meter.scale.x) / 2;
      select.visible = type === 'player' || actor.id === frame.selected || actor.id === frame.reinforcement?.targetId
        || actor.id === frame.firstWreck?.id;
    };
    for (const wreck of frame.wrecks) addActor(wreck, 'wreck');
    for (const enemy of frame.enemies) if (!enemy.dead) addActor(enemy, enemy.type);
    if (frame.player.alive) addActor(frame.player, 'player');
    for (const [key, entry] of this.actors) {
      if (visible.has(key)) continue;
      this.scene.remove(entry.model);
      this.actors.delete(key);
    }
  }

  syncShells(bullets) {
    const present = new Set(bullets);
    for (const bullet of bullets) {
      let shell = this.shells.get(bullet);
      if (!shell) {
        shell = this.models.shell(bullet.team === 'player');
        this.scene.add(shell);
        this.shells.set(bullet, shell);
      }
      shell.position.set(bullet.x, AIM_HEIGHT, bullet.y);
      shell.rotation.y = -Math.atan2(bullet.dy, bullet.dx);
    }
    for (const [bullet, shell] of this.shells) {
      if (present.has(bullet)) continue;
      this.scene.remove(shell);
      this.shells.delete(bullet);
    }
  }

  syncRoutes(paths, wrecks) {
    if (this.routePaths === paths) return;
    this.routePaths = paths;
    this.routeGroup.clear();
    this.breachGroup.clear();
    const blocked = new Set();
    for (const route of paths) {
      const color = LANE_COLORS[route.lane];
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1];
        const b = route.points[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const dash = .23;
        for (let d = 0; d < length; d += .36) {
          const width = Math.min(dash, length - d);
          const center = d + width / 2;
          const marker = this.models.box(this.routeGroup, color,
            a.x + Math.cos(angle) * center, .052, a.y + Math.sin(angle) * center, width, .014, .11, true);
          marker.rotation.y = -angle;
        }
      }
      if (route.blockedWreckId && route.points.length) {
        blocked.add(route.blockedWreckId);
        const end = route.points.at(-1);
        this.models.add(this.routeGroup, this.models.ringGeometry, this.models.material(color, true),
          end.x, .054, end.y, .24, 1, .24);
      }
    }
    for (const wreck of wrecks) {
      if (!blocked.has(wreck.id)) continue;
      const ring = wreck.r + .25;
      this.models.add(this.breachGroup, this.models.ringGeometry, this.models.material(0xffc87e, true),
        wreck.x, .045, wreck.y, ring, 1, ring);
    }
  }

  syncPreview(preview) {
    const targets = [preview?.spent, preview?.target, preview?.undo?.player];
    this.prepMarks.forEach((marker, i) => {
      const target = targets[i];
      marker.visible = Boolean(target);
      if (target) marker.position.set(target.x, .049, target.y);
    });
    const restored = preview?.undo?.wrecks || [];
    restored.forEach((wreck, i) => {
      this.undoMarks[i] ??= this.models.add(this.scene, this.models.ringGeometry,
        this.models.material(0xade5e7, true), 0, .055, 0, .77, 1, .77);
      this.undoMarks[i].position.set(wreck.x, .055, wreck.y);
      this.undoMarks[i].visible = true;
    });
    for (let i = restored.length; i < this.undoMarks.length; i++) this.undoMarks[i].visible = false;
  }

  createImpact(x, z, color, count) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: .55, depthWrite: false
    });
    const ring = this.models.add(group, this.models.ringGeometry, ringMaterial, 0, .059, 0, 1, 1, 1);
    const flash = this.models.add(group, this.models.shellGeometry, ringMaterial, 0, .38, 0, .20, .13, .20);

    const positions = new Float32Array(count * 6);
    const geometry = new THREE.BufferGeometry();
    const vertices = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', vertices);
    const sparks = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color, transparent: true, depthWrite: false
    }));
    sparks.frustumCulled = false;
    group.add(sparks);
    this.scene.add(group);
    return { group, ring, flash, sparks, vertices, count };
  }

  syncEffects(effects, time) {
    const active = new Set(effects);
    for (const fx of effects) {
      const style = EFFECTS[fx.type];
      if (!style) continue;
      const [life, color] = style;
      const progress = Math.max(0, Math.min(1, (time - fx.at) / life));
      const major = fx.type === 'kill' || fx.type === 'death' || fx.type === 'wreckBreaks';
      let impact = this.impacts.get(fx);
      if (!impact) {
        impact = this.createImpact(fx.x, fx.y, color, major ? 13 : 7);
        this.impacts.set(fx, impact);
      }
      const { ring, flash, sparks, vertices, count } = impact;
      const radius = .16 + progress * (major ? .89 : .44);
      const opacity = 1 - progress;
      ring.scale.set(radius, 1, radius);
      ring.material.opacity = opacity * .64;
      flash.visible = progress < .33;
      flash.scale.setScalar(.15 + progress * .35);
      sparks.material.opacity = opacity;
      for (let i = 0; i < count; i++) {
        const angle = i * 2.39996 + fx.x;
        const vx = Math.cos(angle);
        const vz = Math.sin(angle);
        const reach = radius * (.77 + (i % 4) * .17);
        const y = .24 + Math.sin(progress * Math.PI) * (.18 + (i % 3) * .13);
        vertices.setXYZ(i * 2, vx * reach, y, vz * reach);
        vertices.setXYZ(i * 2 + 1, vx * (reach - .1), y - .045, vz * (reach - .1));
      }
      vertices.needsUpdate = true;
    }
    for (const [fx, { group, ring, sparks }] of this.impacts) {
      if (active.has(fx)) continue;
      this.scene.remove(group);
      ring.material.dispose();
      sparks.geometry.dispose();
      sparks.material.dispose();
      this.impacts.delete(fx);
    }
  }

  render(frame) {
    this.base.userData.lamp.material.color.setHex(frame.base.hp > 0 ? 0xffe094 : 0x766956);
    this.syncActors(frame);
    this.syncShells(frame.bullets);
    this.syncEffects(frame.effects, frame.visualTime);
    this.syncRoutes(frame.phase === 'prep' && frame.routePreview?.length ? frame.routePreview : NO_ROUTES, frame.wrecks);
    this.syncPreview(frame.preparationPreview);
    const { pointer, player } = frame;
    this.reticule.visible = pointer.inside && frame.phase === 'battle' && !frame.paused && player.alive;
    if (this.reticule.visible) {
      this.reticule.position.set(pointer.x, AIM_HEIGHT, pointer.y);
      const inRange = Math.hypot(pointer.x - player.x, pointer.y - player.y) <= frame.weaponRange + player.r;
      this.reticule.userData.ring.material.color.setHex(inRange ? 0x2a4f4c : 0xa33d22);
    }
    this.paint();
  }
}

const NO_ROUTES = [];
