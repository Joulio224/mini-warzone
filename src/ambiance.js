// ---------------------------------------------------------------------------
// Ambiance : cycle jour / coucher de soleil / nuit, ciel, brouillard, ombres
// ---------------------------------------------------------------------------
// Tout est purement visuel et calculé côté client : aucune donnée réseau.
// Le moment de la journée se déduit de l'horloge (Date.now) : tous les joueurs
// voient donc à peu près la même heure sans que le serveur n'ait rien à faire.
//
// Contenu :
//  - un ciel en dégradé avec soleil, lune et étoiles (shader maison)
//  - le soleil / la lune (une lumière directionnelle), le ciel d'ambiance, une
//    lumière de remplissage — leurs couleurs et intensités suivent la journée
//  - un brouillard bas ("height fog") : plus dense près du sol, avec un
//    dégradé vers l'horizon, + quelques nappes de brume qui dérivent au ras du sol
//  - des ombres en cascade (CSM) : très nettes autour du joueur, plus douces
//    plus loin. Option désactivable pour les machines modestes.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

// --- Durée du cycle ---------------------------------------------------------
export const DAY_CYCLE_SECONDS = 900; // 15 min pour un jour complet
const DAY_FRACTION = 0.62; // part du cycle où le soleil est levé
const FIXED_PHASE = 0.27; // heure affichée quand le cycle est désactivé (matin clair)

// Phase (0..1) -> angle du soleil sur sa course : 0 = lever, PI = coucher, 2PI = lever suivant.
function sunAngle(phase) {
  return phase < DAY_FRACTION
    ? (Math.PI * phase) / DAY_FRACTION
    : Math.PI + (Math.PI * (phase - DAY_FRACTION)) / (1 - DAY_FRACTION);
}

// --- Images clés de la journée ---------------------------------------------
// Entre deux images clés tout est interpolé en douceur. `phase` : 0 = lever du
// soleil, 0.31 = midi, 0.62 = coucher, ~0.8 = pleine nuit.
//   top / horizon : couleurs du ciel (zénith / horizon)
//   fog           : couleur du brouillard (proche de l'horizon, pour que le décor lointain s'y fonde)
//   sun           : couleur de la lumière directionnelle (soleil le jour, lune la nuit) et intensité
//   hemi          : lumière d'ambiance (ciel / sol) et intensité
//   fogDensity    : densité du brouillard (par mètre, au niveau du sol)
//   exposure      : exposition globale (relevée la nuit pour que ça reste jouable)
const KEYS = [
  { phase: 0.0,  top: 0x3b5d9e, horizon: 0xffa66e, fog: 0xf0b48c, sun: 0xffb27a, sunI: 0.9, hemiSky: 0xffd5b8, hemiGround: 0x3a2f28, hemiI: 0.6, fogDensity: 0.010, exposure: 1.0 },
  { phase: 0.07, top: 0x4d84cf, horizon: 0xf6d6b3, fog: 0xdfe3e8, sun: 0xffe3bd, sunI: 1.4, hemiSky: 0xcfe0ff, hemiGround: 0x3a2f28, hemiI: 0.85, fogDensity: 0.007, exposure: 1.03 },
  { phase: 0.31, top: 0x4a90d9, horizon: 0xcfe8f7, fog: 0xcfe8f7, sun: 0xfff2d9, sunI: 1.7, hemiSky: 0xbfd9ff, hemiGround: 0x3a2f28, hemiI: 1.0, fogDensity: 0.0055, exposure: 1.05 },
  { phase: 0.5,  top: 0x4a82cc, horizon: 0xeadcc2, fog: 0xe3ddce, sun: 0xffe0ae, sunI: 1.5, hemiSky: 0xc8d8f2, hemiGround: 0x3a2f28, hemiI: 0.9, fogDensity: 0.0065, exposure: 1.04 },
  { phase: 0.58, top: 0x34509a, horizon: 0xff8a50, fog: 0xf0966a, sun: 0xff8e55, sunI: 1.15, hemiSky: 0xffb890, hemiGround: 0x2a2230, hemiI: 0.62, fogDensity: 0.010, exposure: 1.02 },
  { phase: 0.64, top: 0x222f66, horizon: 0xc2577f, fog: 0x7b5a8c, sun: 0x8b8cff, sunI: 0.4, hemiSky: 0x7280c0, hemiGround: 0x1c1c2a, hemiI: 0.5, fogDensity: 0.011, exposure: 1.1 },
  { phase: 0.76, top: 0x0a1030, horizon: 0x1f2c55, fog: 0x1a2342, sun: 0x93adff, sunI: 0.5, hemiSky: 0x3b5192, hemiGround: 0x10131c, hemiI: 0.68, fogDensity: 0.009, exposure: 1.35 },
  { phase: 0.9,  top: 0x0b1235, horizon: 0x23305e, fog: 0x1d2850, sun: 0x93adff, sunI: 0.45, hemiSky: 0x3b5192, hemiGround: 0x10131c, hemiI: 0.68, fogDensity: 0.009, exposure: 1.35 },
  { phase: 0.96, top: 0x1d2a5a, horizon: 0x5a4f7e, fog: 0x4a4670, sun: 0x9aa6e0, sunI: 0.4, hemiSky: 0x5a6aa6, hemiGround: 0x1c1c2a, hemiI: 0.5, fogDensity: 0.010, exposure: 1.15 },
];

const _tmpColor = new THREE.Color();
const _tmpColorB = new THREE.Color();
const smooth = (t) => t * t * (3 - 2 * t);

// Valeurs interpolées pour une phase donnée (écrit dans `out`).
function sampleKeys(phase, out) {
  const p = ((phase % 1) + 1) % 1;
  let a = KEYS[KEYS.length - 1];
  let b = KEYS[0];
  let aPhase = a.phase - 1;
  let bPhase = b.phase;
  for (let i = 0; i < KEYS.length; i++) {
    if (KEYS[i].phase <= p) {
      a = KEYS[i];
      aPhase = a.phase;
      b = KEYS[(i + 1) % KEYS.length];
      bPhase = i + 1 < KEYS.length ? b.phase : b.phase + 1;
    }
  }
  const t = smooth(THREE.MathUtils.clamp((p - aPhase) / (bPhase - aPhase), 0, 1));
  const mix = (name, target) => target.copy(_tmpColor.set(a[name])).lerp(_tmpColorB.set(b[name]), t);
  mix('top', out.top);
  mix('horizon', out.horizon);
  mix('fog', out.fog);
  mix('sun', out.sun);
  mix('hemiSky', out.hemiSky);
  mix('hemiGround', out.hemiGround);
  out.sunI = THREE.MathUtils.lerp(a.sunI, b.sunI, t);
  out.hemiI = THREE.MathUtils.lerp(a.hemiI, b.hemiI, t);
  out.fogDensity = THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, t);
  out.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
  return out;
}

// --- Brouillard bas (remplace les "chunks" de brouillard de three.js) -------
// three.js ne sait faire que du brouillard uniforme (distance seule). On
// remplace sa formule par un brouillard EXPONENTIEL EN HAUTEUR : la densité
// décroît avec l'altitude (dense au ras du sol, léger en hauteur), ce qui donne
// de la profondeur et fait "plonger" les rues dans la brume sans cacher les
// toits ni le ciel. On réutilise les trois nombres déjà transmis aux shaders
// par THREE.Fog : fogColor = couleur, fogNear = densité au sol, fogFar =
// vitesse de décroissance avec l'altitude. Voir applyFog() plus bas.
let fogChunksInstalled = false;
function installHeightFog() {
  if (fogChunksInstalled) return;
  fogChunksInstalled = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorldPosition;
    #endif
  `;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      // Position monde reconstruite depuis la position vue (marche pour tous les
      // matériaux : standard, sprites, particules, etc.)
      vFogWorldPosition = transpose( mat3( viewMatrix ) ) * mvPosition.xyz + cameraPosition;
    #endif
  `;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogWorldPosition;
      uniform float fogNear; // densité au niveau du sol
      uniform float fogFar;  // décroissance avec l'altitude (par mètre)
    #endif
  `;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      vec3 fogRay = vFogWorldPosition - cameraPosition;
      float fogDistance = length( fogRay );
      float fogK = max( fogFar, 0.0001 );
      float fogDy = fogRay.y;
      float fogA = exp( - fogK * cameraPosition.y );
      float fogB = exp( - fogK * vFogWorldPosition.y );
      // densité moyenne le long du rayon (intégrale exacte de exp(-k*y))
      float fogAverage = abs( fogDy * fogK ) < 0.001 ? fogA : ( fogA - fogB ) / ( fogK * fogDy );
      float fogFactor = clamp( 1.0 - exp( - fogNear * fogDistance * fogAverage ), 0.0, 1.0 );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
  `;
}

// --- Ciel -------------------------------------------------------------------
function createSky(radius = 400, detail = [32, 20]) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color() },
      horizonColor: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      moonDir: { value: new THREE.Vector3(0, -1, 0) },
      nightAmount: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform vec3 moonDir;
      uniform float nightAmount;

      float hash( vec3 p ) {
        return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
      }

      void main() {
        vec3 d = normalize( vDir );
        float up = clamp( d.y, 0.0, 1.0 );
        vec3 col = mix( horizonColor, topColor, pow( up, 0.55 ) );
        // sous l'horizon : on reste sur la couleur d'horizon (le brouillard fait le reste)
        col = mix( col, horizonColor * 0.85, smoothstep( 0.0, -0.25, d.y ) );

        // halo et disque du soleil (la valeur > 1 déclenche le bloom)
        float sd = max( dot( d, sunDir ), 0.0 );
        col += sunColor * ( pow( sd, 5.0 ) * 0.22 + pow( sd, 40.0 ) * 0.45 );
        col += sunColor * smoothstep( 0.9991, 0.9995, sd ) * 5.0 * smoothstep( -0.08, 0.02, sunDir.y );

        // lune + étoiles, seulement la nuit
        float md = max( dot( d, moonDir ), 0.0 );
        col += vec3( 0.78, 0.85, 1.0 ) * smoothstep( 0.9992, 0.9996, md ) * 1.6 * nightAmount;
        col += vec3( 0.35, 0.45, 0.9 ) * pow( md, 30.0 ) * 0.12 * nightAmount;
        vec3 sp = d * 230.0;
        vec3 cell = floor( sp );
        float r = length( fract( sp ) - 0.5 );
        float star = step( 0.9965, hash( cell ) ) * smoothstep( 0.2, 0.0, r );
        col += vec3( 0.9, 0.93, 1.0 ) * star * smoothstep( 0.02, 0.25, d.y ) * nightAmount * 1.3;

        gl_FragColor = vec4( col, 1.0 );
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, detail[0], detail[1]), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// --- Nappes de brume --------------------------------------------------------
function makeMistTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const MIST_COUNT = 22;
function createMist() {
  const group = new THREE.Group();
  const texture = makeMistTexture();
  const patches = [];
  for (let i = 0; i < MIST_COUNT; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false, // la brume EST le brouillard : pas la peine de la brouiller en plus
    });
    const sprite = new THREE.Sprite(material);
    const size = 16 + Math.random() * 12;
    sprite.scale.set(size, size * 0.45, 1);
    const home = new THREE.Vector3((Math.random() - 0.5) * 140, 0.7 + Math.random() * 1.2, (Math.random() - 0.5) * 140);
    sprite.position.copy(home);
    group.add(sprite);
    patches.push({ sprite, home, phase: Math.random() * Math.PI * 2, speed: 0.04 + Math.random() * 0.05, base: 0.07 + Math.random() * 0.06 });
  }
  return { group, patches };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
// options :
//   scene, camera, renderer
//   cycle        : false = heure fixe de jour ; true = cycle jour/nuit
//   mist         : nappes de brume
//   sharpShadows : ombres en cascade (CSM). Ne peut pas changer après création.
export function createAmbiance({ scene, camera, renderer, cycle = true, mist = true, sharpShadows = true }) {
  installHeightFog();

  const state = {
    top: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    sunI: 1,
    hemiI: 1,
    fogDensity: 0.008,
    exposure: 1,
  };
  let cycleEnabled = cycle;
  let mistEnabled = mist;
  let phaseOverride = null;
  let fogScale = 1;
  let currentPhase = FIXED_PHASE;
  const sunDir = new THREE.Vector3(0, 1, 0); // vers le soleil
  const lightDir = new THREE.Vector3(0, 1, 0); // vers la source de lumière réelle (soleil ou lune)
  let nightAmount = 0;
  let daylight = 1;

  // Ciel
  const sky = createSky();
  scene.add(sky);

  // Reflet du ciel sur les matériaux métalliques : la map est exportée avec des
  // matériaux 100 % métalliques (glTF par défaut), qui sans reflet à refléter
  // rendent presque noirs. On photographie donc le ciel (celui-ci, en petit)
  // dans une carte d'environnement refaite de temps en temps (lever, coucher,
  // nuit se reflètent donc aussi sur les murs).
  const envSky = createSky(50, [16, 10]);
  const envScene = new THREE.Scene();
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;
  let lastEnvPhase = -1;
  let envIntensity = 0.18;

  // Brouillard : (couleur, densité au sol, décroissance avec l'altitude)
  scene.fog = new THREE.Fog(0xcfe8f7, 0.008, 0.07);

  // Lumières d'ambiance
  const hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x3a2f28, 1.0);
  scene.add(hemiLight);
  const fillLight = new THREE.DirectionalLight(0x8fb4ff, 0.35);
  fillLight.position.set(-25, 15, -15);
  scene.add(fillLight);

  // Lumière principale : en cascade (CSM) ou une seule lumière classique
  let csm = null;
  let sunLight = null;
  if (sharpShadows) {
    csm = new CSM({
      camera,
      parent: scene,
      cascades: 3,
      maxFar: 90,
      mode: 'practical',
      shadowMapSize: 2048,
      shadowBias: -0.0004,
      lightDirection: new THREE.Vector3(-1, -1, -0.5).normalize(),
      lightIntensity: 1.7,
      lightMargin: 120,
    });
    csm.fade = true;
  } else {
    sunLight = new THREE.DirectionalLight(0xfff2d9, 1.7);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.camera.far = 200;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);
    scene.add(sunLight.target);
  }

  // Brume
  const mistSystem = createMist();
  scene.add(mistSystem.group);

  // Enregistrement des matériaux pour la cascade (voir CSM.setupMaterial) : tout
  // matériau éclairé doit être "patché" pour choisir la bonne cascade.
  const registered = new WeakSet();
  function registerObject(root) {
    if (!csm) return;
    root.traverse((child) => {
      if (!child.isMesh && !child.isSkinnedMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((m) => {
        if (!m || registered.has(m)) return;
        if (m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshPhysicalMaterial) {
          csm.setupMaterial(m);
          registered.add(m);
        }
      });
    });
  }
  let lastChildCount = -1;
  let framesSinceScan = 0;
  function scanScene() {
    registerObject(scene);
    lastChildCount = scene.children.length;
    framesSinceScan = 0;
  }

  // Phase courante (0..1)
  function computePhase() {
    if (phaseOverride !== null) return phaseOverride;
    if (!cycleEnabled) return FIXED_PHASE;
    return ((Date.now() / 1000) % DAY_CYCLE_SECONDS) / DAY_CYCLE_SECONDS;
  }

  const _groundDir = new THREE.Vector3();
  function apply() {
    currentPhase = computePhase();
    sampleKeys(currentPhase, state);

    // Position du soleil sur sa course, la lune lui fait face
    const a = sunAngle(currentPhase);
    sunDir.set(Math.cos(a), Math.sin(a) * 0.9, 0.45).normalize();
    const moonDir = _groundDir.copy(sunDir).negate();
    // Hauteur du soleil ( > 0 = levé ) : sert à choisir qui éclaire (soleil ou lune) et à éteindre en douceur à l'horizon
    const sunHeight = sunDir.y;
    const sunUp = sunHeight > 0;
    lightDir.copy(sunUp ? sunDir : moonDir);
    const lightHeight = Math.abs(sunHeight);
    const horizonFade = smooth(THREE.MathUtils.clamp(lightHeight / 0.14, 0, 1));
    const lightIntensity = state.sunI * (0.15 + 0.85 * horizonFade);

    daylight = smooth(THREE.MathUtils.clamp((sunHeight + 0.12) / 0.35, 0, 1));
    nightAmount = 1 - smooth(THREE.MathUtils.clamp((sunHeight + 0.18) / 0.3, 0, 1));

    // Ciel
    const u = sky.material.uniforms;
    u.topColor.value.copy(state.top);
    u.horizonColor.value.copy(state.horizon);
    u.sunDir.value.copy(sunDir);
    u.sunColor.value.copy(state.sun);
    u.moonDir.value.copy(moonDir);
    u.nightAmount.value = nightAmount;
    sky.position.copy(camera.position);

    // Carte d'environnement : refaite quand le ciel a assez changé
    const phaseGap = Math.min(Math.abs(currentPhase - lastEnvPhase), 1 - Math.abs(currentPhase - lastEnvPhase));
    if (lastEnvPhase < 0 || phaseGap > 0.02) { // ~18 s : le ciel change lentement, et chaque régénération alloue des textures
      lastEnvPhase = currentPhase;
      const eu = envSky.material.uniforms;
      eu.topColor.value.copy(state.top);
      eu.horizonColor.value.copy(state.horizon);
      eu.sunDir.value.copy(sunDir);
      eu.sunColor.value.copy(state.sun);
      eu.moonDir.value.copy(moonDir);
      eu.nightAmount.value = nightAmount;
      const previous = envTarget;
      envTarget = pmrem.fromScene(envScene, 0, 0.1, 100);
      scene.environment = envTarget.texture;
      if (previous) previous.dispose();
    }
    scene.environmentIntensity = envIntensity;

    // Brouillard (densité & décroissance en altitude : voir installHeightFog)
    scene.fog.color.copy(state.fog);
    scene.fog.near = state.fogDensity * fogScale;
    scene.fog.far = 0.07;

    // Lumières
    hemiLight.color.copy(state.hemiSky);
    hemiLight.groundColor.copy(state.hemiGround);
    hemiLight.intensity = state.hemiI;
    fillLight.intensity = 0.35 * (0.3 + 0.7 * daylight);
    renderer.toneMappingExposure = state.exposure;

    if (csm) {
      csm.lightDirection.copy(lightDir).negate();
      csm.lights.forEach((light) => {
        light.color.copy(state.sun);
        light.intensity = lightIntensity;
      });
    } else if (sunLight) {
      sunLight.color.copy(state.sun);
      sunLight.intensity = lightIntensity;
    }
  }

  // Ombre simple (mode sans cascade) : on garde le cadre d'ombre centré sur le
  // joueur, calé sur la grille de texels pour éviter que les ombres "grouillent".
  const _snap = new THREE.Vector3();
  function followPlayerSimple() {
    if (!sunLight) return;
    const texel = 100 / 2048;
    _snap.set(Math.round(camera.position.x / texel) * texel, 0, Math.round(camera.position.z / texel) * texel);
    sunLight.target.position.copy(_snap);
    sunLight.position.copy(_snap).addScaledVector(lightDir, 90);
    sunLight.target.updateMatrixWorld();
  }

  let lastFov = camera.fov;
  let lastAspect = camera.aspect;
  const _mistTmp = new THREE.Vector3();
  function update(delta, time = performance.now() / 1000) {
    apply();

    if (csm) {
      if (Math.abs(camera.fov - lastFov) > 0.5 || Math.abs(camera.aspect - lastAspect) > 0.001) {
        lastFov = camera.fov;
        lastAspect = camera.aspect;
        csm.updateFrustums();
      }
      framesSinceScan += 1;
      if (scene.children.length !== lastChildCount || framesSinceScan > 90) scanScene();
      csm.update();
    } else {
      followPlayerSimple();
    }

    // Brume : dérive lente, s'efface près de la caméra (sinon l'écran serait
    // masqué par de grandes taches), plus discrète la nuit
    mistSystem.group.visible = mistEnabled;
    if (mistEnabled) {
      mistSystem.patches.forEach((p) => {
        const wobble = Math.sin(time * p.speed + p.phase);
        p.sprite.position.set(p.home.x + wobble * 6, p.home.y + Math.sin(time * 0.2 + p.phase) * 0.25, p.home.z + Math.cos(time * p.speed * 0.8 + p.phase) * 5);
        const d = _mistTmp.copy(p.sprite.position).sub(camera.position).length();
        const near = THREE.MathUtils.clamp((d - 5) / 10, 0, 1); // 0 à moins de 5 m, 1 à 15 m et plus
        p.sprite.material.color.copy(state.fog);
        p.sprite.material.opacity = p.base * near * (0.45 + 0.55 * daylight);
      });
    }
  }

  return {
    update,
    registerObject,
    // Multiplie la densité du brouillard (0 = aucun) : tests, ou option de qualité
    setEnvIntensity(v) {
      envIntensity = Math.max(0, v);
    },
    setFogScale(s) {
      fogScale = Math.max(0, s);
    },
    setOptions({ cycle: c, mist: m } = {}) {
      if (typeof c === 'boolean') cycleEnabled = c;
      if (typeof m === 'boolean') mistEnabled = m;
    },
    // Pour les tests et captures d'écran : fige l'heure (null = repart sur l'horloge)
    setPhaseOverride(p) {
      phaseOverride = p;
    },
    getPhase: () => currentPhase,
    getSunDirection: () => sunDir,
    getLightDirection: () => lightDir,
    // 0 = nuit noire, 1 = plein jour : sert à teinter les effets (poussière, etc.)
    getDaylight: () => daylight,
    getFogColor: () => state.fog,
    hasCascades: () => Boolean(csm),
    // Pour que le plafond de la cascade suive le niveau de qualité si besoin
    getCascadeLights: () => (csm ? csm.lights : sunLight ? [sunLight] : []),
  };
}
