import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { auth } from './firebase.js';
import { connectToServer, sendMove, sendShoot, sendCollectLoot } from './network.js';

// ---------------------------------------------------------------------------
// Scène, caméra, rendu
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 20, 150);

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
document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// Lumières
// ---------------------------------------------------------------------------
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x445566, 1.1);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
sunLight.position.set(30, 40, 10);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -50;
sunLight.shadow.camera.right = 50;
sunLight.shadow.camera.top = 50;
sunLight.shadow.camera.bottom = -50;
scene.add(sunLight);

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
const ROOM_HALF_WIDTH = 15; // étendue en X
const ROOM_HALF_DEPTH = 10; // étendue en Z
const WALL_HEIGHT = 5;
const WALL_THICKNESS = 0.6;

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x555b66 });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3a3a });
const coverMaterial = new THREE.MeshStandardMaterial({ color: 0x8a6d3b });
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
  menuEl.style.display = 'flex';
});

// ---------------------------------------------------------------------------
// Arme (viewmodel) — placeholder en primitives, à remplacer plus tard par un
// vrai modèle quand on aura une meilleure map/des assets plus poussés.
// ---------------------------------------------------------------------------
const weaponGroup = new THREE.Group();
const weaponMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2b });

const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.32), weaponMaterial);
gunBody.position.set(0, 0, 0);
weaponGroup.add(gunBody);

const gunBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.22), weaponMaterial);
gunBarrel.position.set(0, 0.01, -0.27);
weaponGroup.add(gunBarrel);

const gunGrip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), weaponMaterial);
gunGrip.position.set(0, -0.11, 0.08);
gunGrip.rotation.x = 0.35;
weaponGroup.add(gunGrip);

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

const healthFillEl = document.getElementById('health-fill');
const healthTextEl = document.getElementById('health-text');
const damageFlashEl = document.getElementById('damage-flash');
const deathScreenEl = document.getElementById('death-screen');
const respawnCountdownEl = document.getElementById('respawn-countdown');
const crosshairEl = document.getElementById('crosshair');

function updateHealthUI(hp) {
  const clamped = Math.max(0, Math.min(MAX_HP, hp));
  healthFillEl.style.width = `${clamped}%`;
  healthTextEl.textContent = String(clamped);
}
updateHealthUI(localHp);

let damageFlashTimeout = null;
function flashDamage() {
  damageFlashEl.classList.add('show');
  clearTimeout(damageFlashTimeout);
  damageFlashTimeout = setTimeout(() => damageFlashEl.classList.remove('show'), 250);
}

let hitMarkerTimeout = null;
function showHitMarker() {
  crosshairEl.classList.add('hit');
  clearTimeout(hitMarkerTimeout);
  hitMarkerTimeout = setTimeout(() => crosshairEl.classList.remove('hit'), 150);
}

let respawnInterval = null;
function handleYouDied() {
  isDead = true;
  localHp = 0;
  updateHealthUI(0);
  weaponGroup.visible = false;
  deathScreenEl.hidden = false;

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
  weaponGroup.visible = true;
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

// ---------------------------------------------------------------------------
// Loot au sol (déposé par les joueurs éliminés)
// ---------------------------------------------------------------------------
const lootMeshes = new Map(); // lootId -> mesh
const nearbyLootRequested = new Set(); // évite de spammer collect-loot chaque frame
const LOOT_COLLECT_RADIUS_CLIENT = 2.0;

function createLootMesh() {
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.3, 0),
    new THREE.MeshStandardMaterial({
      color: 0xffd23f,
      emissive: 0x554400,
      metalness: 0.3,
      roughness: 0.4,
    })
  );
  mesh.castShadow = true;
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
function getGroundY(x, z) {
  downRaycaster.set(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0));
  const hits = downRaycaster.intersectObjects(groundObjects, true);
  return hits.length ? hits[0].point.y : 0;
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

// Clic droit maintenu = visée (zoom + arme recentrée + déplacement ralenti)
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 2) isAiming = true;
  if (e.button === 0) shootLocal();
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2) isAiming = false;
});

// ---------------------------------------------------------------------------
// Multijoueur temps réel — voir le projet séparé mini-warzone-server/
// ---------------------------------------------------------------------------
const EYE_HEIGHT = STAND_EYE_HEIGHT; // référence utilisée pour repositionner les AUTRES joueurs

const otherPlayers = new Map(); // socket id -> { mesh, targetPosition, targetRotationY }

function createPlayerMesh(team) {
  const group = new THREE.Group();
  const bodyColor = team === 'blue' ? 0x3a86ff : 0xe63946; // rouge par défaut

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: bodyColor })
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

  return group;
}

function addOtherPlayer({ id, position, rotationY, team }) {
  if (otherPlayers.has(id)) return;
  const mesh = createPlayerMesh(team);
  if (position) {
    mesh.position.set(position.x, position.y - EYE_HEIGHT, position.z);
  }
  mesh.rotation.y = rotationY || 0;
  scene.add(mesh);
  otherPlayers.set(id, {
    mesh,
    targetPosition: mesh.position.clone(),
    targetRotationY: mesh.rotation.y,
  });
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
function showShotTracer(origin, direction, length = 40) {
  const points = [
    new THREE.Vector3(origin.x, origin.y, origin.z),
    new THREE.Vector3(
      origin.x + direction.x * length,
      origin.y + direction.y * length,
      origin.z + direction.z * length
    ),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0xfff275 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  setTimeout(() => scene.remove(line), 80);
}

function shootLocal() {
  if (isDead) return;
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  showShotTracer(origin, dir);
  sendShoot({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
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
    onPlayerShoot: ({ origin, direction }) => showShotTracer(origin, direction),
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
    onHitConfirmed: showHitMarker,
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

  const isMoving = !isDead && (move.forward || move.backward || move.left || move.right);
  if (!isDead) {
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

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Note pour plus tard : les caisses/murs bloquent les déplacements mais pas
// encore les tirs (on peut tirer à travers) — pour l'instant on ne teste que
// la collision des balles avec les joueurs, pas avec le décor.
