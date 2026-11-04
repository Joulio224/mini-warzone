// ---------------------------------------------------------------------------
// Effets visuels 3D des tirs : étincelles, poussière, trous dans les murs,
// douilles, flash de bouche, traceurs fins.
// ---------------------------------------------------------------------------
// Tout est "pooled" (tableaux de taille fixe réutilisés) : aucune allocation par
// tir, pas de fuite mémoire même après des heures de jeu. Purement visuel : rien
// ici n'est envoyé au serveur et rien n'influe sur le gameplay.
//
// Ce module ne connaît ni le réseau ni les armes : main.js lui dit quoi
// afficher (impact(), ejectShell(), tracer()...) et l'appelle à chaque image
// (update).
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// --- Particules (étincelles + poussière) -------------------------------------
// Un petit shader de "points" : taille et transparence propres à CHAQUE
// particule (ce que PointsMaterial ne sait pas faire).
function createParticleSystem({ max, additive, color }) {
  const positions = new Float32Array(max * 3);
  const sizes = new Float32Array(max);
  const alphas = new Float32Array(max);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uScale: { value: 600 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = aSize * uScale / max( -mv.z, 0.1 );
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.05, d ) * vAlpha;
        if ( a < 0.01 ) discard;
        gl_FragColor = vec4( uColor, a );
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;

  // état CPU de chaque particule
  const state = Array.from({ length: max }, () => ({
    alive: false,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    age: 0, life: 1, size: 0.05, grow: 0, drag: 0, gravity: 0, alpha: 1,
  }));
  let cursor = 0;

  function spawn(p) {
    const s = state[cursor];
    cursor = (cursor + 1) % max;
    Object.assign(s, p, { alive: true, age: 0 });
  }

  function update(delta) {
    for (let i = 0; i < max; i++) {
      const s = state[i];
      if (!s.alive) {
        alphas[i] = 0;
        continue;
      }
      s.age += delta;
      if (s.age >= s.life) {
        s.alive = false;
        alphas[i] = 0;
        continue;
      }
      const drag = Math.max(0, 1 - s.drag * delta);
      s.vx *= drag;
      s.vy = s.vy * drag - s.gravity * delta;
      s.vz *= drag;
      s.x += s.vx * delta;
      s.y += s.vy * delta;
      s.z += s.vz * delta;
      const t = s.age / s.life;
      positions[i * 3] = s.x;
      positions[i * 3 + 1] = s.y;
      positions[i * 3 + 2] = s.z;
      sizes[i] = s.size * (1 + s.grow * t);
      alphas[i] = s.alpha * (1 - t) * (1 - t * 0.3);
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { points, material, spawn, update };
}

// --- Textures dessinées à la volée -------------------------------------------
function makeHoleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  c.translate(size / 2, size / 2);

  // halo sombre autour du trou (poussière/brûlure) : lisible sur toutes les surfaces
  const scorch = c.createRadialGradient(0, 0, 6, 0, 0, 30);
  scorch.addColorStop(0, 'rgba(20,18,16,0.5)');
  scorch.addColorStop(0.6, 'rgba(30,28,25,0.22)');
  scorch.addColorStop(1, 'rgba(30,28,25,0)');
  c.fillStyle = scorch;
  c.beginPath();
  c.arc(0, 0, 30, 0, Math.PI * 2);
  c.fill();

  // fin éclat clair sur le bord (peinture/béton écaillé), discret
  c.strokeStyle = 'rgba(205,195,175,0.38)';
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(0, 0, 11.5, 0, Math.PI * 2);
  c.stroke();

  // petites fissures
  c.strokeStyle = 'rgba(25,22,20,0.55)';
  c.lineWidth = 1.2;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.sin(i * 12.9898) * 0.4;
    c.beginPath();
    c.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
    c.lineTo(Math.cos(a) * (16 + (i % 3) * 5), Math.sin(a) * (16 + (i % 3) * 5));
    c.stroke();
  }

  // trou sombre, bord irrégulier
  c.fillStyle = 'rgba(8,8,8,0.96)';
  c.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = 8.5 + Math.sin(i * 7.3) * 1.6;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
  c.fill();
  return new THREE.CanvasTexture(canvas);
}

function makeFlashTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  c.translate(size / 2, size / 2);
  c.globalCompositeOperation = 'lighter';

  // gerbes (étoile irrégulière)
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const len = 38 + (i % 3) * 14;
    const g = c.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,240,190,0.95)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    c.strokeStyle = g;
    c.lineWidth = 7 - (i % 3) * 2;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    c.stroke();
  }
  // cœur brillant
  const core = c.createRadialGradient(0, 0, 0, 0, 0, 26);
  core.addColorStop(0, 'rgba(255,255,235,1)');
  core.addColorStop(0.4, 'rgba(255,205,110,0.75)');
  core.addColorStop(1, 'rgba(255,140,40,0)');
  c.fillStyle = core;
  c.beginPath();
  c.arc(0, 0, 26, 0, Math.PI * 2);
  c.fill();
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const MAX_DECALS = 160;
const MAX_SHELLS = 40;
const MAX_TRACERS = 24;
const MAX_WORLD_FLASHES = 8;

const Z_AXIS = new THREE.Vector3(0, 0, 1);

// options :
//   scene, camera, renderer
//   getDaylight : () => 0..1 (plein jour = 1), pour assombrir la poussière la nuit
//   getFloorY   : () => hauteur du sol sous le joueur (les douilles y tombent)
//   onShellLand : () => void (son d'une douille qui touche le sol)
export function createFx({ scene, camera, renderer, getDaylight = () => 1, getFloorY = () => 0, onShellLand = () => {} }) {
  let enabled = true;
  const root = new THREE.Group();
  scene.add(root);

  // Étincelles (additives) et poussière (mélange normal)
  const sparks = createParticleSystem({ max: 260, additive: true, color: 0xffb347 });
  const dust = createParticleSystem({ max: 140, additive: false, color: 0xc8c0b0 });
  root.add(sparks.points, dust.points);

  // --- Trous d'impact : un seul InstancedMesh ---------------------------------
  const decalMaterial = new THREE.MeshBasicMaterial({
    map: makeHoleTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), decalMaterial, MAX_DECALS);
  decals.frustumCulled = false;
  decals.count = 0;
  decals.renderOrder = 2;
  root.add(decals);
  let decalCursor = 0;
  let decalCount = 0;

  // --- Douilles : un InstancedMesh, couleur et taille par douille --------------
  const shellGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  shellGeometry.rotateZ(Math.PI / 2); // allongée selon X
  const shells = new THREE.InstancedMesh(
    shellGeometry,
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.85, roughness: 0.32 }),
    MAX_SHELLS
  );
  shells.frustumCulled = false;
  shells.count = MAX_SHELLS;
  // Crée tout de suite le tableau de couleurs par instance : sinon il n'apparaît
  // qu'à la première douille, ce qui change la variante du shader et le fait
  // recompiler en plein tir.
  shells.setColorAt(0, new THREE.Color(0xffffff));
  root.add(shells);
  const shellState = Array.from({ length: MAX_SHELLS }, () => ({ alive: false }));
  let shellCursor = 0;
  const shellColor = new THREE.Color();

  // --- Traceurs : fins, additifs, qui s'estompent en ~90 ms ----------------------
  const tracerGeometry = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 5, 1, true);
  tracerGeometry.translate(0, 0.5, 0);
  tracerGeometry.rotateX(Math.PI / 2); // aligné le long de +Z local
  const tracers = Array.from({ length: MAX_TRACERS }, () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0xfff1b0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(tracerGeometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    return { mesh, material, life: 0, maxLife: 0.09 };
  });
  let tracerCursor = 0;

  // --- Flashs de tir dans le monde (tireurs distants) ------------------------------
  const flashTexture = makeFlashTexture();
  const worldFlashes = Array.from({ length: MAX_WORLD_FLASHES }, () => {
    const material = new THREE.SpriteMaterial({
      map: flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    root.add(sprite);
    return { sprite, material, life: 0 };
  });
  let flashCursor = 0;

  // ---------------------------------------------------------------------------
  const _q = new THREE.Quaternion();
  const _roll = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _scale = new THREE.Vector3();
  const _t = new THREE.Vector3();

  function addDecal(point, normal, size) {
    _q.setFromUnitVectors(Z_AXIS, normal);
    _roll.setFromAxisAngle(Z_AXIS, Math.random() * Math.PI * 2);
    _q.multiply(_roll);
    _pos.copy(point).addScaledVector(normal, 0.012);
    _scale.setScalar(size);
    _m.compose(_pos, _q, _scale);
    decals.setMatrixAt(decalCursor, _m);
    decalCursor = (decalCursor + 1) % MAX_DECALS;
    decalCount = Math.min(MAX_DECALS, decalCount + 1);
    decals.count = decalCount;
    decals.instanceMatrix.needsUpdate = true;
  }

  // kind : 'surface' (mur/sol) ou 'body' (joueur touché)
  // light : true pour les tirs à plusieurs plombs (on réduit les effets de chacun)
  function impact({ point, normal, kind = 'surface', light = false }) {
    if (!enabled) return;
    const n = normal;
    const daylight = getDaylight();
    const sparkCount = kind === 'body' ? 4 : light ? 3 : 8;
    for (let i = 0; i < sparkCount; i++) {
      // direction : rebond autour de la normale + dispersion
      _t.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2.2);
      _t.addScaledVector(n, 1.2 + Math.random() * 1.8).normalize();
      const speed = 2.5 + Math.random() * 5;
      sparks.spawn({
        x: point.x + n.x * 0.02, y: point.y + n.y * 0.02, z: point.z + n.z * 0.02,
        vx: _t.x * speed, vy: _t.y * speed, vz: _t.z * speed,
        life: 0.18 + Math.random() * 0.28,
        size: kind === 'body' ? 0.045 : 0.035 + Math.random() * 0.025,
        grow: -0.4, drag: 1.2, gravity: 9, alpha: 1,
      });
    }
    if (kind === 'body') return; // pas de poussière ni de trou sur un joueur

    const dustCount = light ? 1 : 3;
    for (let i = 0; i < dustCount; i++) {
      _t.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.7).addScaledVector(n, 0.9);
      const speed = 0.4 + Math.random() * 0.9;
      dust.spawn({
        x: point.x + n.x * 0.05, y: point.y + n.y * 0.05, z: point.z + n.z * 0.05,
        vx: _t.x * speed, vy: _t.y * speed + 0.3, vz: _t.z * speed,
        life: 0.6 + Math.random() * 0.5,
        size: 0.18 + Math.random() * 0.14,
        grow: 2.2, drag: 2.2, gravity: -0.15, // légèrement ascendante
        alpha: 0.4 * (0.35 + 0.65 * daylight),
      });
    }
    addDecal(point, n, 0.1 + Math.random() * 0.05);
  }

  // Douille : position/vitesse données par l'appelant (dans le monde).
  // size : longueur en mètres ; color : 0xrrggbb (laiton, rouge pour les cartouches de fusil à pompe)
  function ejectShell({ position, velocity, size = 0.035, thickness = 0.011, color = 0xd4a64a }) {
    if (!enabled) return;
    const s = shellState[shellCursor];
    const index = shellCursor;
    shellCursor = (shellCursor + 1) % MAX_SHELLS;
    s.alive = true;
    s.age = 0;
    s.life = 3.2;
    s.pos = (s.pos || new THREE.Vector3()).copy(position);
    s.vel = (s.vel || new THREE.Vector3()).copy(velocity);
    s.quat = (s.quat || new THREE.Quaternion()).setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    s.spin = (s.spin || new THREE.Vector3()).set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    s.size = size;
    s.thickness = thickness;
    s.bounces = 0;
    s.floorY = getFloorY();
    shellColor.setHex(color);
    shells.setColorAt(index, shellColor);
    shells.instanceColor.needsUpdate = true;
  }

  function stepShells(delta) {
    const spinQ = new THREE.Quaternion();
    for (let i = 0; i < MAX_SHELLS; i++) {
      const s = shellState[i];
      if (!s.alive) {
        _m.makeScale(0, 0, 0);
        shells.setMatrixAt(i, _m);
        continue;
      }
      s.age += delta;
      if (s.age >= s.life) {
        s.alive = false;
        _m.makeScale(0, 0, 0);
        shells.setMatrixAt(i, _m);
        continue;
      }
      const resting = s.bounces >= 3;
      if (!resting) {
        s.vel.y -= 14 * delta;
        s.pos.addScaledVector(s.vel, delta);
        const floor = s.floorY + s.thickness;
        if (s.pos.y < floor) {
          s.pos.y = floor;
          if (Math.abs(s.vel.y) > 0.6) {
            if (s.bounces === 0) onShellLand();
            s.vel.y = -s.vel.y * 0.36;
            s.vel.x *= 0.55;
            s.vel.z *= 0.55;
            s.spin.multiplyScalar(0.5);
            s.bounces += 1;
          } else {
            s.bounces = 3;
          }
        }
        spinQ.setFromEuler(new THREE.Euler(s.spin.x * delta, s.spin.y * delta, s.spin.z * delta));
        s.quat.multiply(spinQ);
      }
      // rétrécit doucement à la fin de sa vie
      const fade = Math.min(1, (s.life - s.age) / 0.5);
      _scale.set(s.size * fade, s.thickness * 2 * fade, s.thickness * 2 * fade);
      _m.compose(s.pos, s.quat, _scale);
      shells.setMatrixAt(i, _m);
    }
    shells.instanceMatrix.needsUpdate = true;
  }

  // Traceur du point `from` au point `to`
  function tracer(from, to) {
    _t.copy(to).sub(from);
    const length = _t.length();
    if (length < 0.2) return;
    const t = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
    t.mesh.position.copy(from);
    t.mesh.quaternion.setFromUnitVectors(Z_AXIS, _t.multiplyScalar(1 / length));
    t.mesh.scale.set(1, 1, length);
    t.mesh.visible = true;
    t.life = t.maxLife;
    t.material.opacity = 0.85;
  }

  // Flash de bouche pour un tireur distant (position = bouche du canon)
  function worldMuzzleFlash(position, size = 0.5) {
    const f = worldFlashes[flashCursor];
    flashCursor = (flashCursor + 1) % MAX_WORLD_FLASHES;
    f.sprite.position.copy(position);
    f.sprite.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    f.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.visible = true;
    f.life = 0.06;
    f.material.opacity = 1;
  }

  function update(delta) {
    // échelle des points : pixels par mètre à 1 m de la caméra
    const scale = (renderer.domElement.height / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    sparks.material.uniforms.uScale.value = scale;
    dust.material.uniforms.uScale.value = scale;

    // la poussière suit la lumière : claire le jour, sombre la nuit
    const daylight = getDaylight();
    dust.material.uniforms.uColor.value.setRGB(0.1 + 0.68 * daylight, 0.11 + 0.64 * daylight, 0.15 + 0.55 * daylight);

    sparks.update(delta);
    dust.update(delta);
    stepShells(delta);

    tracers.forEach((t) => {
      if (!t.mesh.visible) return;
      t.life -= delta;
      if (t.life <= 0) {
        t.mesh.visible = false;
        return;
      }
      t.material.opacity = 0.85 * (t.life / t.maxLife);
    });
    worldFlashes.forEach((f) => {
      if (!f.sprite.visible) return;
      f.life -= delta;
      if (f.life <= 0) f.sprite.visible = false;
      else f.material.opacity = f.life / 0.06;
    });
  }

  return {
    impact,
    ejectShell,
    tracer,
    worldMuzzleFlash,
    update,
    getFlashTexture: () => flashTexture, // main.js s'en sert pour le flash du canon en main
    // Désactive étincelles, poussière, trous et douilles (les traceurs et flashs de tir restent : ils servent le gameplay)
    setEnabled(value) {
      enabled = Boolean(value);
      sparks.points.visible = enabled;
      dust.points.visible = enabled;
      decals.visible = enabled;
      shells.visible = enabled;
    },
    isEnabled: () => enabled,
  };
}
