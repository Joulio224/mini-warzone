import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { auth } from './firebase.js';
import {
  connectToServer,
  sendMove,
  sendShoot,
  sendCollectLoot,
  sendCollectVest,
  sendUseVest,
  sendCollectWeapon,
  sendBuyItem,
} from './network.js';
import { initShop, openShop, closeShop, isShopOpen, renderShop, rarityColor } from './shop.js';

// ---------------------------------------------------------------------------
// Scène, caméra, rendu
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const SKY_TOP_COLOR = 0x4a90d9;
const SKY_BOTTOM_COLOR = 0xcfe8f7;
scene.fog = new THREE.Fog(SKY_BOTTOM_COLOR, 20, 150);

// Ciel en dégradé (une grosse sphère retournée, avec un shader simple qui
// mélange deux couleurs du zénith vers l'horizon) — beaucoup plus vivant
// qu'un fond uni, pour un coût de performance quasi nul.
const skyMesh = new THREE.Mesh(
  new THREE.SphereGeometry(400, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(SKY_TOP_COLOR) },
      bottomColor: { value: new THREE.Color(SKY_BOTTOM_COLOR) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPosition;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      void main() {
        float h = normalize(vWorldPosition).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
      }
    `,
  })
);
scene.add(skyMesh);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
const BASE_FOV = 75;
const AIM_FOV = 50;
camera.position.set(0, 1.7, 5); // 1.7 ~ hauteur d'yeux debout

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

// Post-traitement : juste un bloom (lueur des éléments très clairs/émissifs
// — loot, traceurs, flash de tir), avec un seuil assez haut pour ne pas
// tout faire baver. OutputPass en dernier pour garder les bonnes couleurs
// (tone mapping + espace de couleur) une fois passé par le composer.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45,
  0.4,
  0.85
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Lumières
// ---------------------------------------------------------------------------
const hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x3a2f28, 1.0);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff2d9, 1.7);
sunLight.position.set(30, 40, 10);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -50;
sunLight.shadow.camera.right = 50;
sunLight.shadow.camera.top = 50;
sunLight.shadow.camera.bottom = -50;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

// Lumière de "remplissage" douce et froide, opposée au soleil, pour éviter
// que les zones à l'ombre soient totalement noires.
const fillLight = new THREE.DirectionalLight(0x8fb4ff, 0.35);
fillLight.position.set(-25, 15, -15);
scene.add(fillLight);

// ---------------------------------------------------------------------------
// Textures procédurales (dessinées sur un <canvas>, sans fichier externe) —
// un bruit tacheté pour le béton (sol/murs), des veines pour le bois (caisses).
// ---------------------------------------------------------------------------
function makeSpeckledTexture({ base, variation, size = 128, repeat = 8 }) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.12; i++) {
    const shade = (Math.random() - 0.5) * variation;
    const r = Math.max(0, Math.min(255, base[0] + shade));
    const g = Math.max(0, Math.min(255, base[1] + shade));
    const b = Math.max(0, Math.min(255, base[2] + shade));
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  return texture;
}

function makeWoodTexture({ base = [138, 109, 59], size = 128, repeat = 1 }) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 4 + Math.random() * 3) {
    const shade = (Math.random() - 0.5) * 30;
    ctx.strokeStyle = `rgba(${base[0] + shade}, ${base[1] + shade}, ${base[2] + shade}, 0.5)`;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  return texture;
}

// Sol de secours tant que la map n'est pas chargée (évite de tomber dans le vide)
const fallbackGround = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x3a3a3a })
);
fallbackGround.rotation.x = -Math.PI / 2;
fallbackGround.receiveShadow = true;
scene.add(fallbackGround);

// Objets sur lesquels on teste le sol (raycast vers le bas) — séparé de
// scene.children pour ne pas taper les autres joueurs, les traceurs de tir,
// le loot au sol, ou l'arme (enfant de la caméra, jamais concernée).
const groundObjects = [fallbackGround];

// Boîtes de collision horizontale (murs, caisses de couverture) — un
// THREE.Box3 par obstacle. Vérifiées séparément du sol (vertical).
const collisionBoxes = [];

// ---------------------------------------------------------------------------
// Map : soit la vraie map téléchargée (map.glb), soit une petite salle
// construite à la main (sol + murs + caisses pour se planquer), avec des
// zones de spawn par équipe (rouge à l'ouest, bleue à l'est). Repasse
// USE_DOWNLOADED_MAP à true pour revenir à la vraie map plus tard.
// ---------------------------------------------------------------------------
const USE_DOWNLOADED_MAP = false;

const loadingEl = document.getElementById('loading');
const playButton = document.getElementById('play-button');

// Dimensions de la salle — doivent rester cohérentes avec TEAM_SPAWN_POINTS
// dans mini-warzone-server/server.js si tu les changes.
const ROOM_HALF_WIDTH = 20; // étendue en X
const ROOM_HALF_DEPTH = 14; // étendue en Z
const WALL_HEIGHT = 5;
const WALL_THICKNESS = 0.6;
const BALCONY_HEIGHT = 3.2;
const BALCONY_THICKNESS = 0.3;

const wallMaterial = new THREE.MeshStandardMaterial({
  map: makeSpeckledTexture({ base: [85, 91, 102], variation: 22, repeat: 5 }),
  roughness: 0.85,
  metalness: 0.05,
});
const floorMaterial = new THREE.MeshStandardMaterial({
  map: makeSpeckledTexture({ base: [58, 58, 58], variation: 26, repeat: 12 }),
  roughness: 0.9,
  metalness: 0.05,
});
const coverMaterial = new THREE.MeshStandardMaterial({
  map: makeWoodTexture({ base: [138, 109, 59] }),
  roughness: 0.75,
  metalness: 0.05,
});
const teamZoneMaterials = {
  red: new THREE.MeshStandardMaterial({ color: 0x7a1f1f }),
  blue: new THREE.MeshStandardMaterial({ color: 0x1f3f7a }),
};

function addWallMesh(centerX, centerZ, width, depth) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, WALL_HEIGHT, depth), wallMaterial);
  mesh.position.set(centerX, WALL_HEIGHT / 2, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  collisionBoxes.push(
    new THREE.Box3(
      new THREE.Vector3(centerX - width / 2, 0, centerZ - depth / 2),
      new THREE.Vector3(centerX + width / 2, WALL_HEIGHT, centerZ + depth / 2)
    )
  );
}

function addCoverBox(centerX, centerZ, width, depth, height) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), coverMaterial);
  mesh.position.set(centerX, height / 2, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  collisionBoxes.push(
    new THREE.Box3(
      new THREE.Vector3(centerX - width / 2, 0, centerZ - depth / 2),
      new THREE.Vector3(centerX + width / 2, height, centerZ + depth / 2)
    )
  );
}

// Rampe en pente : une simple boîte inclinée, ajoutée à groundObjects (donc
// "marchable" via le même raycast vertical que le reste du sol) mais PAS à
// collisionBoxes (qui est un test 2D en X/Z sans notion de hauteur — une
// rampe y bloquerait tout le monde en permanence, peu importe l'altitude).
function addRamp(centerX, zStart, width, rise, run) {
  const slopeLength = Math.hypot(rise, run);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, slopeLength), floorMaterial);
  mesh.position.set(centerX, rise / 2, zStart + run / 2);
  mesh.rotation.x = -Math.atan2(rise, run);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  groundObjects.push(mesh);
}

function buildCustomRoom() {
  // Sol (surface au niveau y = 0, pour rester cohérent avec les spawns).
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM_HALF_WIDTH * 2, 0.2, ROOM_HALF_DEPTH * 2),
    floorMaterial
  );
  floor.position.set(0, -0.1, 0);
  floor.receiveShadow = true;
  scene.add(floor);
  scene.remove(fallbackGround);
  groundObjects.length = 0;
  groundObjects.push(floor);

  // Les 4 murs, avec un peu de recouvrement aux coins.
  const fullWidth = ROOM_HALF_WIDTH * 2 + WALL_THICKNESS * 2;
  const fullDepth = ROOM_HALF_DEPTH * 2;
  addWallMesh(0, -ROOM_HALF_DEPTH, fullWidth, WALL_THICKNESS); // sud
  addWallMesh(0, ROOM_HALF_DEPTH, fullWidth, WALL_THICKNESS); // nord
  addWallMesh(-ROOM_HALF_WIDTH, 0, WALL_THICKNESS, fullDepth); // ouest (équipe rouge)
  addWallMesh(ROOM_HALF_WIDTH, 0, WALL_THICKNESS, fullDepth); // est (équipe bleue)

  // --- Balcon (2e étage), ouvert côté sud (vue plongeante sur la salle) ---
  const balconyDepth = 6;
  const balconyZStart = ROOM_HALF_DEPTH - balconyDepth; // bord ouvert, côté salle
  const balconyWidth = ROOM_HALF_WIDTH * 2 - 6; // laisse de la place aux rampes sur les bords
  const balconyFloor = new THREE.Mesh(
    new THREE.BoxGeometry(balconyWidth, BALCONY_THICKNESS, balconyDepth),
    floorMaterial
  );
  balconyFloor.position.set(0, BALCONY_HEIGHT, balconyZStart + balconyDepth / 2);
  balconyFloor.castShadow = true;
  balconyFloor.receiveShadow = true;
  scene.add(balconyFloor);
  groundObjects.push(balconyFloor);

  // Garde-corps bas sur le bord ouvert — purement visuel/décoratif, pas de
  // collision : on veut pouvoir tirer/sauter par-dessus depuis le balcon.
  const railGeometry = new THREE.BoxGeometry(balconyWidth, 0.7, 0.08);
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.5, metalness: 0.4 });
  const rail = new THREE.Mesh(railGeometry, railMaterial);
  rail.position.set(0, BALCONY_HEIGHT + 0.35 + BALCONY_THICKNESS / 2, balconyZStart);
  rail.castShadow = true;
  scene.add(rail);

  // Rampes d'accès, une de chaque côté, menant du sol jusqu'au bord ouvert
  // du balcon.
  const rampRun = balconyZStart - 1;
  addRamp(-(ROOM_HALF_WIDTH - 4), 1, 4, BALCONY_HEIGHT, rampRun);
  addRamp(ROOM_HALF_WIDTH - 4, 1, 4, BALCONY_HEIGHT, rampRun);

  // Zones de spawn colorées au sol, purement visuelles (pas de collision),
  // pour repérer son côté d'un coup d'œil.
  const zoneGeometry = new THREE.PlaneGeometry(4, ROOM_HALF_DEPTH * 2 - 1);
  const redZone = new THREE.Mesh(zoneGeometry, teamZoneMaterials.red);
  redZone.rotation.x = -Math.PI / 2;
  redZone.position.set(-ROOM_HALF_WIDTH + 2.5, 0.01, 0);
  scene.add(redZone);

  const blueZone = new THREE.Mesh(zoneGeometry, teamZoneMaterials.blue);
  blueZone.rotation.x = -Math.PI / 2;
  blueZone.position.set(ROOM_HALF_WIDTH - 2.5, 0.01, 0);
  scene.add(blueZone);

  // Lumières d'ambiance colorées près de chaque zone de spawn — renforce
  // l'identité de chaque équipe, et donne du grain au bloom.
  const redAccentLight = new THREE.PointLight(0xff4d4d, 6, 12, 2);
  redAccentLight.position.set(-ROOM_HALF_WIDTH + 2, 3, 0);
  scene.add(redAccentLight);

  const blueAccentLight = new THREE.PointLight(0x4d94ff, 6, 12, 2);
  blueAccentLight.position.set(ROOM_HALF_WIDTH - 2, 3, 0);
  scene.add(blueAccentLight);

  // Caisses de couverture au centre, pour se planquer sans bloquer
  // complètement la vue d'un bout à l'autre de la salle.
  const covers = [
    { x: -6, z: -4, w: 2, d: 2, h: 1.6 },
    { x: -6, z: 4, w: 2, d: 2, h: 1.6 },
    { x: 0, z: -6, w: 3, d: 1.2, h: 1.6 },
    { x: 0, z: 6, w: 3, d: 1.2, h: 1.6 },
    { x: 6, z: -4, w: 2, d: 2, h: 1.6 },
    { x: 6, z: 4, w: 2, d: 2, h: 1.6 },
    { x: -2.5, z: 0, w: 1.5, d: 1.5, h: 1.6 },
    { x: 2.5, z: 0, w: 1.5, d: 1.5, h: 1.6 },
  ];
  covers.forEach((c) => addCoverBox(c.x, c.z, c.w, c.d, c.h));

  buildShopTable();
}

// Position de la table de la boutique — juste entre les deux caisses
// centrales (x=±2.5,z=0), pile au milieu de la salle. Réutilisée pour le
// test de proximité qui autorise (ou pas) l'ouverture avec B, voir plus bas.
const SHOP_POSITION = { x: 0, z: 0 };
const SHOP_INTERACTION_RADIUS = 2.4;

function buildShopTable() {
  const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.85 });
  const toolMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa5ad, metalness: 0.7, roughness: 0.3 });
  const handleMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
  const caseMaterial = new THREE.MeshStandardMaterial({ color: 0xc23616, roughness: 0.6 });

  const table = new THREE.Group();

  const tabletop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.2), woodMaterial);
  tabletop.position.y = 0.9;
  tabletop.castShadow = true;
  tabletop.receiveShadow = true;
  table.add(tabletop);

  const legGeometry = new THREE.BoxGeometry(0.1, 0.9, 0.1);
  [[-1.05, -0.45], [1.05, -0.45], [-1.05, 0.45], [1.05, 0.45]].forEach(([lx, lz]) => {
    const leg = new THREE.Mesh(legGeometry, woodMaterial);
    leg.position.set(lx, 0.45, lz);
    leg.castShadow = true;
    table.add(leg);
  });

  // Quelques outils posés dessus — juste assez de silhouette pour se lire
  // comme un établi, dans le même esprit low-poly que le reste du décor.
  const wrench = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.08), toolMaterial);
  wrench.position.set(-0.6, 0.98, 0.2);
  wrench.rotation.y = 0.4;
  wrench.castShadow = true;
  table.add(wrench);

  const screwdriverHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), handleMaterial);
  screwdriverHandle.position.set(0.1, 0.98, -0.25);
  screwdriverHandle.rotation.z = Math.PI / 2;
  table.add(screwdriverHandle);
  const screwdriverShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6), toolMaterial);
  screwdriverShaft.position.set(0.36, 0.98, -0.25);
  screwdriverShaft.rotation.z = Math.PI / 2;
  table.add(screwdriverShaft);

  const toolbox = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.28), caseMaterial);
  toolbox.position.set(0.7, 1.03, 0.15);
  toolbox.castShadow = true;
  table.add(toolbox);

  const boltGeometry = new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8);
  const bolt1 = new THREE.Mesh(boltGeometry, toolMaterial);
  bolt1.position.set(-0.2, 0.99, 0.32);
  table.add(bolt1);
  const bolt2 = new THREE.Mesh(boltGeometry, toolMaterial);
  bolt2.position.set(-0.05, 0.99, 0.35);
  table.add(bolt2);

  // Petit repère lumineux au-dessus — pour repérer la boutique de loin dans
  // la salle, comme pour les gilets/armes au sol.
  const beacon = new THREE.PointLight(0xffd23f, 2, 6, 2);
  beacon.position.set(0, 1.7, 0);
  table.add(beacon);

  table.position.set(SHOP_POSITION.x, 0, SHOP_POSITION.z);
  scene.add(table);
  collisionBoxes.push(
    new THREE.Box3(
      new THREE.Vector3(SHOP_POSITION.x - 1.15, 0, SHOP_POSITION.z - 0.55),
      new THREE.Vector3(SHOP_POSITION.x + 1.15, 1.0, SHOP_POSITION.z + 0.55)
    )
  );
}

if (USE_DOWNLOADED_MAP) {
  const loader = new GLTFLoader();
  loader.load(
    '/assets/map.glb',
    (gltf) => {
      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          // La texture de la Low Poly Arena est un petit atlas pixelisé —
          // le filtrage "linéaire" par défaut de Three.js la flouterait.
          // On force un filtrage au plus proche pour garder le style net,
          // comme recommandé dans les instructions d'install de l'asset.
          const material = child.material;
          const maps = [material?.map, material?.emissiveMap, material?.roughnessMap];
          maps.forEach((map) => {
            if (!map) return;
            map.magFilter = THREE.NearestFilter;
            map.minFilter = THREE.NearestFilter;
            map.needsUpdate = true;
          });
        }
      });
      scene.add(gltf.scene);
      scene.remove(fallbackGround);

      // La map devient le sol pour les collisions verticales (saut/gravité) ;
      // le sol de secours ne sert plus.
      groundObjects.length = 0;
      groundObjects.push(gltf.scene);

      loadingEl.style.display = 'none';
      playButton.disabled = false;
      playButton.textContent = 'Cliquer pour jouer';
    },
    (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        loadingEl.textContent = `Chargement de la map… ${pct}%`;
      }
    },
    (error) => {
      console.error('Erreur de chargement de la map :', error);
      loadingEl.textContent =
        "Map introuvable — dépose ton fichier .glb dans public/assets/map.glb (sol de secours actif)";
      playButton.disabled = false;
      playButton.textContent = 'Cliquer pour jouer (sans map)';
    }
  );
} else {
  buildCustomRoom();
  loadingEl.style.display = 'none';
  playButton.disabled = false;
  playButton.textContent = 'Cliquer pour jouer';
}

// ---------------------------------------------------------------------------
// Contrôles FPS (pointer lock)
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

const menuEl = document.getElementById('menu');

playButton.addEventListener('click', () => {
  controls.lock();
  startNetwork();
});
controls.addEventListener('lock', () => {
  menuEl.style.display = 'none';
});
controls.addEventListener('unlock', () => {
  // Si c'est la boutique qui vient de déverrouiller le pointeur (touche B),
  // on ne veut PAS afficher le menu "Cliquer pour jouer" par-dessus — voir
  // la section "Boutique" plus bas.
  if (isShopOpen()) return;
  menuEl.style.display = 'flex';
});

// ---------------------------------------------------------------------------
// Armes (viewmodels en primitives, à remplacer plus tard par de vrais
// modèles). La cadence doit rester identique à WEAPON_BASE dans
// mini-warzone-server/server.js — les DÉGÂTS, eux, ne sont plus fixes ici :
// ils dépendent de la rareté équipée (gris/bleu/rouge, voir shop.js) et ne
// sont calculés que côté serveur, seule autorité sur le sujet. Touches
// 1/2/3 pour changer d'arme.
// ---------------------------------------------------------------------------
const WEAPONS = [
  { id: 'pistol', name: 'Pistolet', cooldown: 0.35, autoFire: false, color: 0x2b2b2b },
  { id: 'smg', name: 'Mitraillette', cooldown: 0.09, autoFire: true, color: 0x333d47 },
  { id: 'rifle', name: 'Fusil', cooldown: 0.18, autoFire: true, color: 0x3a3226 },
];
// Couleurs des pickups au sol (bien plus vives que la couleur "réaliste" du
// modèle en main ci-dessus, pour qu'on les repère facilement à distance).
const WEAPON_PICKUP_COLORS = { smg: 0x00e5ff, rifle: 0xff9f1c };

function buildPistolModel(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.24), mat);
  group.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.12), mat);
  barrel.position.set(0, 0.01, -0.18);
  group.add(barrel);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.06), mat);
  grip.position.set(0, -0.1, 0.06);
  grip.rotation.x = 0.35;
  group.add(grip);
  return { group, material: mat };
}

function buildSmgModel(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.4), mat);
  group.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.18), mat);
  barrel.position.set(0, 0.015, -0.28);
  group.add(barrel);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.07), mat);
  magazine.position.set(0, -0.16, -0.02);
  magazine.rotation.x = -0.15;
  group.add(magazine);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.06), mat);
  grip.position.set(0, -0.09, 0.14);
  grip.rotation.x = 0.35;
  group.add(grip);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.06, 0.16), mat);
  stock.position.set(0, 0, 0.28);
  group.add(stock);
  return { group, material: mat };
}

function buildRifleModel(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.5), mat);
  group.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, 0.3), mat);
  barrel.position.set(0, 0.015, -0.38);
  group.add(barrel);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.08), mat);
  magazine.position.set(0, -0.15, -0.08);
  magazine.rotation.x = -0.2;
  group.add(magazine);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.06), mat);
  grip.position.set(0, -0.09, 0.18);
  grip.rotation.x = 0.35;
  group.add(grip);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.22), mat);
  stock.position.set(0, 0.01, 0.36);
  group.add(stock);
  return { group, material: mat };
}

const WEAPON_BUILDERS = { pistol: buildPistolModel, smg: buildSmgModel, rifle: buildRifleModel };

// Teinte appliquée au(x) matériau(x) de l'arme en main selon sa rareté —
// "grise/bleutée/rougie" comme demandé : gris = couleur d'origine (aucune
// teinte), bleu/rouge mélangent 45% de la couleur de rareté (voir shop.js)
// à la couleur de base de l'arme, avec une légère lueur assortie.
const RARITY_TINT_MIX = 0.45;

const weaponGroup = new THREE.Group();
// Un élément par TYPE d'arme (pas par rareté) : le même modèle 3D est réutilisé
// et simplement reteinté quand la rareté équipée change (voir applyRarityTint).
const weaponModels = WEAPONS.map((weapon) => {
  const { group: model, material } = WEAPON_BUILDERS[weapon.id](weapon.color);
  model.visible = false;
  weaponGroup.add(model);
  return { id: weapon.id, group: model, material, baseColor: new THREE.Color(weapon.color) };
});

function applyRarityTint(weaponId, rarity) {
  const entry = weaponModels.find((w) => w.id === weaponId);
  if (!entry) return;
  if (!rarity || rarity === 'gray') {
    entry.material.color.copy(entry.baseColor);
    entry.material.emissive.set(0x000000);
    return;
  }
  const tint = new THREE.Color(rarityColor(rarity));
  entry.material.color.copy(entry.baseColor).lerp(tint, RARITY_TINT_MIX);
  entry.material.emissive.copy(tint);
  entry.material.emissiveIntensity = 0.3;
}

// currentWeaponIndex reste l'index dans WEAPONS/weaponModels du modèle
// affiché ; currentSlot (déclaré plus loin, 0/1/2) est ce que l'UI et les
// entrées clavier/souris utilisent pour savoir quel slot du stuff est actif.
let currentWeaponIndex = 0;
weaponModels[currentWeaponIndex].group.visible = true;

// Petit flash bref au canon à chaque tir — attaché à l'arme donc suit
// automatiquement ses mouvements (recul, visée, bob).
const muzzleFlashLight = new THREE.PointLight(0xffe08a, 0, 3, 2);
muzzleFlashLight.position.set(0, 0.02, -0.5);
weaponGroup.add(muzzleFlashLight);
let muzzleFlashTimeout = null;
function showMuzzleFlash() {
  muzzleFlashLight.intensity = 6;
  clearTimeout(muzzleFlashTimeout);
  muzzleFlashTimeout = setTimeout(() => {
    muzzleFlashLight.intensity = 0;
  }, 40);
}

// Met à jour le modèle 3D visible (et sa teinte de rareté) d'après le slot
// actuellement sélectionné et le contenu réel de myWeapons — appelée aussi
// bien quand on change de slot (touches 1/2/3) que quand le contenu d'un
// slot change (ramassage au sol, achat en boutique, reset au respawn).
function refreshEquippedWeaponDisplay() {
  if (currentSlot === 2) {
    weaponGroup.visible = false;
    return;
  }
  const equipped = myWeapons[currentSlot];
  if (!equipped) {
    weaponGroup.visible = false;
    return;
  }
  const newIndex = WEAPONS.findIndex((w) => w.id === equipped.id);
  if (newIndex !== currentWeaponIndex) {
    weaponModels[currentWeaponIndex].group.visible = false;
    currentWeaponIndex = newIndex;
  }
  weaponModels[currentWeaponIndex].group.visible = true;
  weaponGroup.visible = true;
  applyRarityTint(equipped.id, equipped.rarity);
}

// Sélectionne un slot du stuff (0/1 = armes, 2 = gilets). Pour un slot
// d'arme vide (pas encore ramassée) ou en pleine mort, on ignore — on ne
// peut pas "sélectionner" une arme qu'on n'a pas.
function selectSlot(slot) {
  if (isDead || slot < 0 || slot > 2) return;
  if (slot < 2 && !myWeapons[slot]) return; // rien dans ce slot d'arme

  currentSlot = slot;
  refreshEquippedWeaponDisplay();
  updateInventoryUI();
}
document.addEventListener('keydown', (e) => {
  if (isShopOpen()) return; // pas de changement d'arme "à l'aveugle" pendant qu'on regarde la boutique
  if (e.code === 'Digit1') selectSlot(0);
  if (e.code === 'Digit2') selectSlot(1);
  if (e.code === 'Digit3') selectSlot(2);
});

const WEAPON_REST_POSITION = new THREE.Vector3(0.28, -0.25, -0.55);
const WEAPON_AIM_POSITION = new THREE.Vector3(0, -0.18, -0.35);
weaponGroup.position.copy(WEAPON_REST_POSITION);
weaponGroup.rotation.y = -0.05;
camera.add(weaponGroup);
scene.add(camera); // la caméra doit être dans la scène pour que ses enfants (l'arme) s'affichent

let recoilKick = 0; // 0 = repos, monte brièvement à chaque tir puis redescend

// ---------------------------------------------------------------------------
// Vie, mort, respawn
// ---------------------------------------------------------------------------
const MAX_HP = 100;
let localHp = MAX_HP;
let isDead = false;

// Bouclier (gilets pare-balle) — SHIELD_PER_VEST et MAX_SHIELD_VESTS_BASE
// doivent rester identiques aux valeurs équivalentes dans
// mini-warzone-server/server.js. Le plafond réel (myMaxVestSlots) n'est PAS
// une constante : il vaut 2 par défaut mais passe à 3 pour le reste de la
// partie si la capacité spéciale "3e emplacement de gilet" est achetée en
// boutique (voir handleAbilitiesUpdate et shop.js).
const SHIELD_PER_VEST = 25;
const MAX_SHIELD_VESTS_BASE = 2;
let myMaxVestSlots = MAX_SHIELD_VESTS_BASE;
let localShield = 0;
let localMoney = 0;

function currentMaxShield() {
  return SHIELD_PER_VEST * myMaxVestSlots;
}

// "Stuff" du joueur : 2 slots d'arme (le 0 est toujours le pistolet de
// départ, jamais perdu — seule sa rareté peut changer) + un compteur de
// gilets en réserve (max myMaxVestSlots, à utiliser au clic droit pour les
// convertir en bouclier). Chaque slot d'arme non vide est maintenant un
// objet { id, rarity } (et plus une simple chaîne) depuis l'introduction du
// système de rareté — voir shop.js. currentSlot vaut 0/1 pour les armes, 2
// pour les gilets — sélection via les touches 1/2/3.
let myWeapons = [{ id: 'pistol', rarity: 'gray' }, null];
let myVestCount = 0;
let currentSlot = 0;

const healthFillEl = document.getElementById('health-fill');
const healthTextEl = document.getElementById('health-text');
const shieldFillEl = document.getElementById('shield-fill');
const moneyTextEl = document.getElementById('money-text');
const damageFlashEl = document.getElementById('damage-flash');
const deathScreenEl = document.getElementById('death-screen');
const respawnCountdownEl = document.getElementById('respawn-countdown');
const crosshairEl = document.getElementById('crosshair');
const invSlotEls = [
  document.getElementById('slot-weapon1'),
  document.getElementById('slot-weapon2'),
  document.getElementById('slot-vest'),
];

function updateHealthUI(hp) {
  const clamped = Math.max(0, Math.min(MAX_HP, hp));
  healthFillEl.style.width = `${clamped}%`;
  healthTextEl.textContent = String(clamped);
}
updateHealthUI(localHp);

function updateShieldUI(shield) {
  const max = currentMaxShield();
  localShield = Math.max(0, Math.min(max, shield));
  if (shieldFillEl) shieldFillEl.style.width = `${(localShield / max) * 100}%`;
}
updateShieldUI(localShield);

function updateMoneyUI(money) {
  localMoney = money;
  if (moneyTextEl) moneyTextEl.textContent = `${money} €`;
}
updateMoneyUI(localMoney);

function weaponLabel(weaponId) {
  const weapon = WEAPONS.find((w) => w.id === weaponId);
  return weapon ? weapon.name : 'Vide';
}

// Renvoie l'état actuel du joueur au format attendu par shop.js
// (renderShop/openShop) — regroupé ici pour n'avoir qu'un seul endroit à
// mettre à jour si la boutique a besoin d'une donnée de plus un jour.
function getShopState() {
  return { money: localMoney, weapons: myWeapons, vestCount: myVestCount, maxVestSlots: myMaxVestSlots };
}

function updateInventoryUI() {
  const slotContents = [myWeapons[0], myWeapons[1], null];
  invSlotEls.forEach((el, index) => {
    if (!el) return;
    el.classList.toggle('active', index === currentSlot);
    const label = el.querySelector('.inv-label');
    const dot = el.querySelector('.inv-rarity-dot');
    if (!label) return;
    if (index < 2) {
      const weapon = slotContents[index];
      el.classList.toggle('empty', !weapon);
      label.textContent = weapon ? weaponLabel(weapon.id) : 'Vide';
      if (dot) {
        dot.style.background = weapon ? rarityColor(weapon.rarity) : 'transparent';
        dot.style.boxShadow = weapon ? `0 0 4px ${rarityColor(weapon.rarity)}` : 'none';
      }
    } else {
      el.classList.toggle('empty', myVestCount === 0);
      label.textContent = `Gilets x${myVestCount}/${myMaxVestSlots}`;
    }
  });
}
updateInventoryUI();

function handleWeaponsUpdate(weapons) {
  myWeapons = weapons;
  // Reteinte les deux modèles dès que le stuff change (achat, ramassage,
  // reset au respawn) même si le slot correspondant n'est pas affiché tout
  // de suite — la teinte sera donc déjà bonne si on rechange de slot plus tard.
  myWeapons.forEach((w) => { if (w) applyRarityTint(w.id, w.rarity); });
  // Si le slot actif vient de perdre son arme (ex: reset à la mort), on
  // retombe sur le pistolet plutôt que de rester bloqué sur un slot vide.
  if (currentSlot < 2 && !myWeapons[currentSlot]) {
    selectSlot(0);
  } else {
    refreshEquippedWeaponDisplay();
    updateInventoryUI();
  }
  if (isShopOpen()) renderShop(getShopState());
}

function handleVestCountUpdate(count) {
  myVestCount = count;
  updateInventoryUI();
  if (isShopOpen()) renderShop(getShopState());
}

// Capacité spéciale "3e emplacement de gilet" (voir shop.js) : ne se
// réinitialise jamais en cours de partie (contrairement aux armes/gilets),
// donc pas besoin de la remettre à zéro à la mort/au respawn ici.
function handleAbilitiesUpdate({ maxVestSlots } = {}) {
  if (typeof maxVestSlots === 'number') myMaxVestSlots = maxVestSlots;
  updateShieldUI(localShield); // le plafond du bouclier peut avoir changé
  updateInventoryUI();
  if (isShopOpen()) renderShop(getShopState());
}

let damageFlashTimeout = null;
function flashDamage() {
  damageFlashEl.classList.add('show');
  clearTimeout(damageFlashTimeout);
  damageFlashTimeout = setTimeout(() => damageFlashEl.classList.remove('show'), 250);
}

let hitMarkerTimeout = null;
function showHitMarker(isHeadshot) {
  crosshairEl.classList.add('hit');
  crosshairEl.classList.toggle('headshot', Boolean(isHeadshot));
  clearTimeout(hitMarkerTimeout);
  hitMarkerTimeout = setTimeout(() => {
    crosshairEl.classList.remove('hit', 'headshot');
  }, 150);
}

let respawnInterval = null;
function handleYouDied() {
  isDead = true;
  localHp = 0;
  updateHealthUI(0);
  updateShieldUI(0);
  myVestCount = 0;
  weaponGroup.visible = false;
  deathScreenEl.hidden = false;
  updateInventoryUI();

  // Cas rare mais possible : mourir pendant qu'on regarde la boutique (le
  // pointeur est alors déverrouillé). On ferme la boutique et on réaffiche
  // le menu existant (bouton "Cliquer pour jouer") comme filet de
  // sécurité pour reverrouiller le pointeur — on ne peut pas appeler
  // controls.lock() nous-mêmes ici, ce n'est pas déclenché par un geste
  // utilisateur direct (message reçu du serveur) et les navigateurs
  // refusent souvent le verrouillage du pointeur hors interaction directe.
  if (isShopOpen()) {
    closeShop();
    menuEl.style.display = 'flex';
  }

  let secondsLeft = 3;
  respawnCountdownEl.textContent = `Réapparition dans ${secondsLeft}s…`;
  clearInterval(respawnInterval);
  respawnInterval = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft > 0) {
      respawnCountdownEl.textContent = `Réapparition dans ${secondsLeft}s…`;
    }
  }, 1000);
}

function handleYouRespawned({ position }) {
  isDead = false;
  localHp = MAX_HP;
  updateHealthUI(MAX_HP);
  myWeapons = [{ id: 'pistol', rarity: 'gray' }, null];
  applyRarityTint('pistol', 'gray');
  selectSlot(0);
  deathScreenEl.hidden = true;
  clearInterval(respawnInterval);
  verticalVelocity = 0;
  if (position) {
    camera.position.set(position.x, position.y, position.z);
  }
}

function handleHpUpdate(hp) {
  if (hp < localHp) flashDamage();
  localHp = hp;
  updateHealthUI(hp);
}

function handleShieldUpdate(shield) {
  updateShieldUI(shield);
}

function handleMoneyUpdate(money) {
  updateMoneyUI(money);
  if (isShopOpen()) renderShop(getShopState());
}

// ---------------------------------------------------------------------------
// Loot au sol (déposé par les joueurs éliminés) — des cubes, à ramasser pour
// regagner de la vie (HP).
// ---------------------------------------------------------------------------
const lootMeshes = new Map(); // lootId -> mesh
const nearbyLootRequested = new Set(); // évite de spammer collect-loot chaque frame
const LOOT_COLLECT_RADIUS_CLIENT = 2.0;

function createLootMesh() {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.45, 0.45),
    new THREE.MeshStandardMaterial({
      color: 0xffd23f,
      emissive: 0xffaa00,
      emissiveIntensity: 1.2,
      metalness: 0.3,
      roughness: 0.4,
    })
  );
  mesh.castShadow = true;
  const glow = new THREE.PointLight(0xffaa00, 1.5, 4, 2);
  mesh.add(glow);
  return mesh;
}

function spawnLootMesh(id, position) {
  if (lootMeshes.has(id)) return;
  const mesh = createLootMesh();
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);
  lootMeshes.set(id, mesh);
}

function removeLootMesh(id) {
  const mesh = lootMeshes.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  lootMeshes.delete(id);
  nearbyLootRequested.delete(id);
}

// ---------------------------------------------------------------------------
// Gilets pare-balle au sol — réapparaissent à des points fixes après un
// délai (contrairement au loot, qui ne tombe que des joueurs tués). Ramassés,
// ils remplissent le bouclier par paliers de SHIELD_PER_VEST.
// ---------------------------------------------------------------------------
const vestMeshes = new Map(); // vestId -> mesh
const VEST_COLLECT_RADIUS_CLIENT = 2.0;

function createVestMesh() {
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.32, 0),
    new THREE.MeshStandardMaterial({
      color: 0x3a86ff,
      emissive: 0x1c4fbf,
      emissiveIntensity: 1.1,
      metalness: 0.35,
      roughness: 0.4,
    })
  );
  mesh.castShadow = true;
  const glow = new THREE.PointLight(0x3a86ff, 1.5, 4, 2);
  mesh.add(glow);
  return mesh;
}

function spawnVestMesh(id, position) {
  if (vestMeshes.has(id)) return;
  const mesh = createVestMesh();
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);
  vestMeshes.set(id, mesh);
}

function removeVestMesh(id) {
  const mesh = vestMeshes.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  vestMeshes.delete(id);
}

// ---------------------------------------------------------------------------
// Armes ramassables au sol — même principe que les gilets (points fixes,
// réapparition différée), mais remplissent le slot 2 du stuff au lieu du
// bouclier. Couleur = celle de l'arme réelle (voir WEAPONS plus bas).
// ---------------------------------------------------------------------------
const weaponPickupMeshes = new Map(); // pickupId -> { mesh, weaponId }
const WEAPON_PICKUP_COLLECT_RADIUS_CLIENT = 2.0;

function createWeaponPickupMesh(weaponId) {
  const color = WEAPON_PICKUP_COLORS[weaponId] || 0xffffff;
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.5, 5),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      metalness: 0.4,
      roughness: 0.35,
    })
  );
  mesh.castShadow = true;
  const glow = new THREE.PointLight(color, 1.3, 4, 2);
  mesh.add(glow);
  return mesh;
}

function spawnWeaponPickupMesh(id, weaponId, position) {
  if (weaponPickupMeshes.has(id)) return;
  const mesh = createWeaponPickupMesh(weaponId);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);
  weaponPickupMeshes.set(id, { mesh, weaponId });
}

function removeWeaponPickupMesh(id) {
  const entry = weaponPickupMeshes.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  weaponPickupMeshes.delete(id);
}

// ---------------------------------------------------------------------------
// Déplacement, saut, accroupi, visée
// ---------------------------------------------------------------------------
const move = { forward: false, backward: false, left: false, right: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const BASE_SPEED = 5.5;

const STAND_EYE_HEIGHT = 1.7;
const CROUCH_EYE_HEIGHT = 1.0;
let currentEyeHeight = STAND_EYE_HEIGHT;
let isCrouching = false;
let isAiming = false;

const GRAVITY = 18;
const JUMP_SPEED = 6.5;
let verticalVelocity = 0;
let isGrounded = true;

const downRaycaster = new THREE.Raycaster();
// On part du DERNIER sol connu (pas de la position actuelle de la caméra),
// avec une petite marge — sinon, pendant un saut près du balcon, le rayon
// partirait de trop haut et détecterait le balcon même pour quelqu'un qui
// saute juste en dessous, le faisant se téléporter dessus. En se basant sur
// le dernier sol trouvé, seul un vrai déplacement horizontal (marcher sous
// le balcon, monter une rampe) fait changer le résultat, jamais un saut.
let lastGroundY = 0;
const GROUND_RAY_MARGIN = 1.2;
function getGroundY(x, z) {
  downRaycaster.set(new THREE.Vector3(x, lastGroundY + GROUND_RAY_MARGIN, z), new THREE.Vector3(0, -1, 0));
  const hits = downRaycaster.intersectObjects(groundObjects, true);
  const y = hits.length ? hits[0].point.y : 0;
  lastGroundY = y;
  return y;
}

// Collision horizontale simple (cercle contre boîte, résolu axe par axe pour
// pouvoir glisser le long d'un mur au lieu de se bloquer net dessus).
const PLAYER_RADIUS = 0.4;

function collidesAt(x, z) {
  for (const box of collisionBoxes) {
    const closestX = THREE.MathUtils.clamp(x, box.min.x, box.max.x);
    const closestZ = THREE.MathUtils.clamp(z, box.min.z, box.max.z);
    const dx = x - closestX;
    const dz = z - closestZ;
    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

function resolveHorizontalCollisions(prevX, prevZ) {
  if (collidesAt(camera.position.x, prevZ)) {
    camera.position.x = prevX;
  }
  if (collidesAt(camera.position.x, camera.position.z)) {
    camera.position.z = prevZ;
  }
}

function onKeyChange(e, isDown) {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      move.forward = isDown;
      break;
    case 'KeyS':
    case 'ArrowDown':
      move.backward = isDown;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      move.left = isDown;
      break;
    case 'KeyD':
    case 'ArrowRight':
      move.right = isDown;
      break;
    case 'Space':
      if (isDown && isGrounded && !isDead) {
        verticalVelocity = JUMP_SPEED;
        isGrounded = false;
      }
      break;
    case 'ControlLeft':
    case 'ControlRight':
    case 'KeyC':
      isCrouching = isDown;
      break;
  }
}
document.addEventListener('keydown', (e) => onKeyChange(e, true));
document.addEventListener('keyup', (e) => onKeyChange(e, false));

// Clic droit maintenu = viser (slot arme) — zoom + arme recentrée +
// déplacement ralenti. Clic droit sur le slot gilets = consomme un gilet en
// réserve pour regagner du bouclier (action unique, pas un maintien).
// Clic gauche = tir. Maintenu, ça ne re-tire en continu que pour les armes
// automatiques (WEAPONS[].autoFire) — géré dans animate().
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
let isMouseDown = false;
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 2) {
    if (currentSlot === 2) {
      if (myVestCount > 0) sendUseVest();
    } else {
      isAiming = true;
    }
  }
  if (e.button === 0) {
    isMouseDown = true;
    tryShoot(clock.elapsedTime);
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2) isAiming = false;
  if (e.button === 0) isMouseDown = false;
});

// Touche T = ramasser l'objet au sol le plus proche (arme ou gilet), à
// portée. Un seul ramassage par appui (pas de spam en la maintenant).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyT' || isDead || isShopOpen()) return;

  let closestId = null;
  let closestType = null;
  let closestDist = Infinity;

  weaponPickupMeshes.forEach(({ mesh }, id) => {
    const dist = camera.position.distanceTo(mesh.position);
    if (dist <= WEAPON_PICKUP_COLLECT_RADIUS_CLIENT && dist < closestDist) {
      closestDist = dist;
      closestId = id;
      closestType = 'weapon';
    }
  });
  vestMeshes.forEach((mesh, id) => {
    const dist = camera.position.distanceTo(mesh.position);
    if (dist <= VEST_COLLECT_RADIUS_CLIENT && dist < closestDist) {
      closestDist = dist;
      closestId = id;
      closestType = 'vest';
    }
  });

  if (!closestId) return;
  if (closestType === 'weapon') sendCollectWeapon(closestId);
  else sendCollectVest(closestId);
});

// ---------------------------------------------------------------------------
// Boutique (voir shop.js)
// ---------------------------------------------------------------------------
// Magasin physique : une table posée au centre de la salle (voir
// buildShopTable). La touche B ouvre la boutique seulement si on est à
// portée de cette table — sinon, comme avant, elle ne fait rien à
// l'ouverture (fermer reste possible depuis n'importe où, une fois dedans).
initShop({
  onBuy: (itemId) => sendBuyItem(itemId),
  onClose: () => controls.lock(),
});

const shopPromptEl = document.getElementById('shop-prompt');
function isNearShopTable() {
  const dx = camera.position.x - SHOP_POSITION.x;
  const dz = camera.position.z - SHOP_POSITION.z;
  return Math.sqrt(dx * dx + dz * dz) <= SHOP_INTERACTION_RADIUS;
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyB' || isDead || !networkStarted) return;
  if (isShopOpen()) {
    closeShop();
    controls.lock(); // touche B pressée = geste utilisateur direct, le verrouillage du pointeur est autorisé
  } else if (isNearShopTable()) {
    controls.unlock(); // affiche le curseur pour pouvoir cliquer sur les boutons de la boutique
    openShop(getShopState());
  }
});

// ---------------------------------------------------------------------------
// Multijoueur temps réel — voir le projet séparé mini-warzone-server/
// ---------------------------------------------------------------------------
const EYE_HEIGHT = STAND_EYE_HEIGHT; // référence utilisée pour repositionner les AUTRES joueurs

const otherPlayers = new Map(); // socket id -> { mesh, targetPosition, targetRotationY }

const TEAM_BODY_COLORS = { red: 0xe63946, blue: 0x3a86ff };
// Facteur de luminosité du corps selon le nombre de gilets portés (0 à 3) —
// chaque gilet assombrit un peu plus, jusqu'à très sombre à 3 gilets.
const SHIELD_DARKEN_FACTORS = [1, 0.72, 0.48, 0.28];

function getTintedBodyColor(team, steps) {
  const base = TEAM_BODY_COLORS[team] ?? TEAM_BODY_COLORS.red;
  const factor = SHIELD_DARKEN_FACTORS[Math.max(0, Math.min(3, steps))];
  return new THREE.Color(base).multiplyScalar(factor);
}

function createPlayerMesh(team, steps = 0) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: getTintedBodyColor(team, steps) })
  );
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffd6a5 })
  );
  head.position.y = 1.65;
  head.castShadow = true;
  group.add(head);

  return { group, bodyMaterial: body.material };
}

function addOtherPlayer({ id, position, rotationY, team, shieldSteps }) {
  if (otherPlayers.has(id)) return;
  const { group: mesh, bodyMaterial } = createPlayerMesh(team, shieldSteps || 0);
  if (position) {
    mesh.position.set(position.x, position.y - EYE_HEIGHT, position.z);
  }
  mesh.rotation.y = rotationY || 0;
  scene.add(mesh);
  otherPlayers.set(id, {
    mesh,
    bodyMaterial,
    team,
    targetPosition: mesh.position.clone(),
    targetRotationY: mesh.rotation.y,
  });
}

function updatePlayerShieldSteps({ id, steps }) {
  const entry = otherPlayers.get(id);
  if (!entry) return;
  entry.bodyMaterial.color.copy(getTintedBodyColor(entry.team, steps));
}

function updateOtherPlayer({ id, position, rotationY }) {
  const entry = otherPlayers.get(id);
  if (!entry || !position) return;
  entry.targetPosition.set(position.x, position.y - EYE_HEIGHT, position.z);
  entry.targetRotationY = rotationY || 0;
}

function removeOtherPlayer(id) {
  const entry = otherPlayers.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  otherPlayers.delete(id);
}

function setOtherPlayerVisible(id, visible) {
  const entry = otherPlayers.get(id);
  if (!entry) return;
  entry.mesh.visible = visible;
}

function snapOtherPlayer(id, position) {
  const entry = otherPlayers.get(id);
  if (!entry || !position) return;
  const p = new THREE.Vector3(position.x, position.y - EYE_HEIGHT, position.z);
  entry.mesh.position.copy(p);
  entry.targetPosition.copy(p);
}

// Effet visuel de tir : un trait bref, pour soi comme pour les autres joueurs
// Traceur en petit cylindre fin plutôt qu'une THREE.Line (les lignes WebGL
// restent à 1px quelle que soit leur "épaisseur" demandée) — géométrie et
// matériau réutilisés pour chaque tir, seule une nouvelle Mesh est créée.
const tracerGeometry = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
tracerGeometry.translate(0, 0.5, 0);
tracerGeometry.rotateX(Math.PI / 2); // aligné le long de +Z local
const tracerMaterial = new THREE.MeshBasicMaterial({
  color: 0xfff6b0,
  transparent: true,
  opacity: 0.9,
});

function showShotTracer(origin, direction, length = 40) {
  const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
  const mesh = new THREE.Mesh(tracerGeometry, tracerMaterial);
  mesh.scale.set(1, 1, length);
  mesh.position.set(origin.x, origin.y, origin.z);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  scene.add(mesh);
  setTimeout(() => scene.remove(mesh), 80);
}

const shotRaycaster = new THREE.Raycaster();
const tmpVec3 = new THREE.Vector3();
function nearestObstacleDistance(origin, direction) {
  shotRaycaster.set(origin, direction);
  let nearest = Infinity;
  for (const box of collisionBoxes) {
    const hitPoint = shotRaycaster.ray.intersectBox(box, tmpVec3);
    if (hitPoint) {
      const dist = origin.distanceTo(hitPoint);
      if (dist < nearest) nearest = dist;
    }
  }
  return nearest;
}

let lastShotAt = -Infinity;

function tryShoot(now) {
  if (isDead || currentSlot === 2 || isShopOpen()) return;
  const weapon = WEAPONS[currentWeaponIndex];
  if (now - lastShotAt < weapon.cooldown) return;
  lastShotAt = now;

  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const maxLength = Math.min(nearestObstacleDistance(origin, dir), 60);
  showShotTracer(origin, dir, maxLength);
  showMuzzleFlash();
  // On envoie le SLOT actif (0/1), jamais l'id d'arme ni les dégâts : le
  // serveur retrouve lui-même l'arme + la rareté réellement équipées dans
  // ce slot (voir server.js) — impossible de tricher en prétendant avoir
  // une meilleure arme/rareté que celle réellement achetée.
  sendShoot({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z }, currentSlot);
  recoilKick = 1; // déclenche l'animation de recul de l'arme, gérée dans animate()
}

let networkStarted = false;
let localTeam = null;
const teamLabelEl = document.getElementById('team-label');

function handleTeamAssigned({ team, spawn }) {
  localTeam = team;
  if (spawn) {
    camera.position.set(spawn.x, spawn.y, spawn.z);
  }
  if (teamLabelEl) {
    teamLabelEl.textContent = team === 'blue' ? 'Équipe Bleue' : 'Équipe Rouge';
    teamLabelEl.classList.remove('team-red', 'team-blue');
    teamLabelEl.classList.add(team === 'blue' ? 'team-blue' : 'team-red');
  }
}

function startNetwork() {
  if (networkStarted) return;
  networkStarted = true;

  const pseudo = auth.currentUser?.displayName || 'Joueur';

  connectToServer(pseudo, {
    onTeamAssigned: handleTeamAssigned,
    onPlayerJoined: addOtherPlayer,
    onPlayerMoved: updateOtherPlayer,
    onPlayerShoot: ({ origin, direction, maxLength }) =>
      showShotTracer(origin, direction, Number.isFinite(maxLength) ? maxLength : 40),
    onPlayerLeft: removeOtherPlayer,
    onConnectError: () => {
      loadingEl.style.display = 'block';
      loadingEl.textContent =
        'Serveur temps réel injoignable — vérifie que mini-warzone-server tourne bien';
    },
    onYourHp: handleHpUpdate,
    onYouDied: handleYouDied,
    onPlayerDied: ({ id }) => setOtherPlayerVisible(id, false),
    onYouRespawned: handleYouRespawned,
    onPlayerRespawned: ({ id, position }) => {
      setOtherPlayerVisible(id, true);
      snapOtherPlayer(id, position);
    },
    onCurrentLoot: (items) => items.forEach((item) => spawnLootMesh(item.id, item.position)),
    onLootSpawned: ({ id, position }) => spawnLootMesh(id, position),
    onLootRemoved: ({ id }) => removeLootMesh(id),
    onHitConfirmed: ({ headshot }) => showHitMarker(headshot),
    onYourShield: handleShieldUpdate,
    onPlayerShieldSteps: updatePlayerShieldSteps,
    onYourMoney: handleMoneyUpdate,
    onCurrentVests: (items) => items.forEach((item) => spawnVestMesh(item.id, item.position)),
    onVestSpawned: ({ id, position }) => spawnVestMesh(id, position),
    onVestRemoved: ({ id }) => removeVestMesh(id),
    onYourVestCount: handleVestCountUpdate,
    onCurrentWeaponPickups: (items) =>
      items.forEach((item) => spawnWeaponPickupMesh(item.id, item.weaponId, item.position)),
    onWeaponPickupSpawned: ({ id, weaponId, position }) => spawnWeaponPickupMesh(id, weaponId, position),
    onWeaponPickupRemoved: ({ id }) => removeWeaponPickupMesh(id),
    onYourWeapons: handleWeaponsUpdate,
    onYourAbilities: handleAbilitiesUpdate,
  });
}

// ---------------------------------------------------------------------------
// Boucle de rendu
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let timeSinceLastMoveSent = 0;
const MOVE_SEND_INTERVAL = 0.05; // ~20 envois par seconde, pas à chaque frame
let bobTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);

  // Vitesse effective : ralentie en visée, encore plus accroupi
  const speedMultiplier = isCrouching ? 0.5 : isAiming ? 0.65 : 1;
  const speed = BASE_SPEED * speedMultiplier;

  // Friction
  velocity.x -= velocity.x * 10 * delta;
  velocity.z -= velocity.z * 10 * delta;

  direction.z = Number(move.forward) - Number(move.backward);
  direction.x = Number(move.right) - Number(move.left);
  direction.normalize();

  const isMoving = !isDead && !isShopOpen() && (move.forward || move.backward || move.left || move.right);
  if (!isDead && !isShopOpen()) {
    if (move.forward || move.backward) velocity.z -= direction.z * speed * 10 * delta;
    if (move.left || move.right) velocity.x -= direction.x * speed * 10 * delta;

    const prevX = camera.position.x;
    const prevZ = camera.position.z;
    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
    resolveHorizontalCollisions(prevX, prevZ);
  }

  // --- Accroupi : on lisse la hauteur d'yeux cible plutôt que de la changer d'un coup
  const targetEyeHeight = isCrouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
  currentEyeHeight += (targetEyeHeight - currentEyeHeight) * Math.min(1, 10 * delta);

  // --- Gravité / saut : on calcule le sol sous les pieds, puis on applique
  // soit un collage au sol (si posé), soit la gravité (si en l'air).
  // On coupe la gravité pendant l'écran de mort pour ne pas glisser vers le
  // dernier point de vue au sol pendant les 3s d'attente.
  if (!isDead) {
    const groundY = getGroundY(camera.position.x, camera.position.z);
    const standingY = groundY + currentEyeHeight;

    verticalVelocity -= GRAVITY * delta;
    camera.position.y += verticalVelocity * delta;

    if (camera.position.y <= standingY) {
      camera.position.y = standingY;
      verticalVelocity = 0;
      isGrounded = true;
    } else {
      isGrounded = false;
    }
  }

  // --- Visée : zoom du champ de vision + arme recentrée
  const targetFov = isAiming && !isDead ? AIM_FOV : BASE_FOV;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * delta);
    camera.updateProjectionMatrix();
  }
  const targetWeaponPos = isAiming ? WEAPON_AIM_POSITION : WEAPON_REST_POSITION;
  weaponGroup.position.lerp(targetWeaponPos, Math.min(1, 12 * delta));

  // --- Léger bob de l'arme en marchant (purement visuel)
  if (isMoving && isGrounded) {
    bobTime += delta * (isAiming ? 6 : 10);
  }
  const bobOffset = isMoving && isGrounded ? Math.sin(bobTime) * 0.012 : 0;
  weaponGroup.position.y += bobOffset;

  // --- Tir automatique : tant que le bouton est maintenu et que l'arme
  // actuelle est en rafale, on retente à chaque frame — tryShoot() se
  // charge lui-même de respecter la cadence de l'arme.
  if (isMouseDown && WEAPONS[currentWeaponIndex].autoFire) {
    tryShoot(clock.elapsedTime);
  }

  // --- Recul de l'arme au tir, amorti à chaque frame
  if (recoilKick > 0.001) {
    recoilKick *= Math.max(0, 1 - 14 * delta);
  } else {
    recoilKick = 0;
  }
  weaponGroup.rotation.x = -recoilKick * 0.35;
  weaponGroup.position.z += recoilKick * 0.06;

  // --- Loot au sol : petite rotation/flottement, et ramassage par proximité
  lootMeshes.forEach((mesh, id) => {
    mesh.rotation.y += delta * 1.6;
    mesh.position.y += Math.sin(clock.elapsedTime * 3 + mesh.id) * 0.0015;

    if (isDead) return;
    const dx = camera.position.x - mesh.position.x;
    const dz = camera.position.z - mesh.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance <= LOOT_COLLECT_RADIUS_CLIENT && !nearbyLootRequested.has(id)) {
      nearbyLootRequested.add(id);
      sendCollectLoot(id);
    } else if (distance > LOOT_COLLECT_RADIUS_CLIENT) {
      nearbyLootRequested.delete(id);
    }
  });

  // --- Gilets pare-balle au sol : juste l'animation (flottement/rotation).
  // Le ramassage se fait maintenant à la touche T, plus automatiquement.
  vestMeshes.forEach((mesh) => {
    mesh.rotation.y += delta * 1.6;
    mesh.position.y += Math.sin(clock.elapsedTime * 3 + mesh.id) * 0.0015;
  });

  // --- Armes au sol : même animation, ramassage aussi à la touche T.
  weaponPickupMeshes.forEach(({ mesh }) => {
    mesh.rotation.y += delta * 1.6;
    mesh.position.y += Math.sin(clock.elapsedTime * 3 + mesh.id) * 0.0015;
  });

  // --- Prompt "B - Boutique" quand on est près de la table.
  if (shopPromptEl) {
    shopPromptEl.style.display = !isDead && !isShopOpen() && isNearShopTable() ? 'block' : 'none';
  }

  // Autres joueurs : on lisse leur déplacement plutôt que de les téléporter
  // à chaque message reçu du serveur (ça "saccaderait" sinon).
  otherPlayers.forEach(({ mesh, targetPosition, targetRotationY }) => {
    mesh.position.lerp(targetPosition, 0.25);
    mesh.rotation.y += (targetRotationY - mesh.rotation.y) * 0.25;
  });

  // Position locale envoyée au serveur, mais pas à chaque frame (inutile et
  // ça surchargerait le réseau pour rien). On arrête d'en envoyer pendant
  // qu'on est mort (le serveur ignore de toute façon les 'move' des morts).
  if (networkStarted && !isDead) {
    timeSinceLastMoveSent += delta;
    if (timeSinceLastMoveSent >= MOVE_SEND_INTERVAL) {
      timeSinceLastMoveSent = 0;
      const facing = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      sendMove({ x: camera.position.x, y: camera.position.y, z: camera.position.z }, facing.y);
    }
  }

  composer.render();
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Note pour plus tard : murs/caisses bloquent maintenant aussi bien les
// déplacements que les tirs (portée coupée par nearestObstacleDistance côté
// client, et vérifiée en autorité côté serveur dans nearestObstacleDistance
// de server.js — les deux listes de boîtes doivent rester identiques).
