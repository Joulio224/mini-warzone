import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { auth } from './firebase.js';
import { connectToServer, sendMove, sendShoot } from './network.js';

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
// ou l'arme (qui est enfant de la caméra, donc jamais concernée de toute
// façon).
const groundObjects = [fallbackGround];

// ---------------------------------------------------------------------------
// Chargement de la map (glTF/GLB) — dépose ton fichier dans public/assets/map.glb
// ---------------------------------------------------------------------------
const loadingEl = document.getElementById('loading');
const playButton = document.getElementById('play-button');

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
      if (isDown && isGrounded) {
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

function createPlayerMesh() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0xe63946 })
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

function addOtherPlayer({ id, position, rotationY }) {
  if (otherPlayers.has(id)) return;
  const mesh = createPlayerMesh();
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
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  showShotTracer(origin, dir);
  sendShoot({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
  recoilKick = 1; // déclenche l'animation de recul de l'arme, gérée dans animate()
}

let networkStarted = false;

function startNetwork() {
  if (networkStarted) return;
  networkStarted = true;

  const pseudo = auth.currentUser?.displayName || 'Joueur';

  connectToServer(pseudo, {
    onPlayerJoined: addOtherPlayer,
    onPlayerMoved: updateOtherPlayer,
    onPlayerShoot: ({ origin, direction }) => showShotTracer(origin, direction),
    onPlayerLeft: removeOtherPlayer,
    onConnectError: () => {
      loadingEl.style.display = 'block';
      loadingEl.textContent =
        'Serveur temps réel injoignable — vérifie que mini-warzone-server tourne bien';
    },
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

  const isMoving = move.forward || move.backward || move.left || move.right;
  if (move.forward || move.backward) velocity.z -= direction.z * speed * 10 * delta;
  if (move.left || move.right) velocity.x -= direction.x * speed * 10 * delta;

  controls.moveRight(-velocity.x * delta);
  controls.moveForward(-velocity.z * delta);

  // --- Accroupi : on lisse la hauteur d'yeux cible plutôt que de la changer d'un coup
  const targetEyeHeight = isCrouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
  currentEyeHeight += (targetEyeHeight - currentEyeHeight) * Math.min(1, 10 * delta);

  // --- Gravité / saut : on calcule le sol sous les pieds, puis on applique
  // soit un collage au sol (si posé), soit la gravité (si en l'air).
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

  // --- Visée : zoom du champ de vision + arme recentrée
  const targetFov = isAiming ? AIM_FOV : BASE_FOV;
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

  // Autres joueurs : on lisse leur déplacement plutôt que de les téléporter
  // à chaque message reçu du serveur (ça "saccaderait" sinon).
  otherPlayers.forEach(({ mesh, targetPosition, targetRotationY }) => {
    mesh.position.lerp(targetPosition, 0.25);
    mesh.rotation.y += (targetRotationY - mesh.rotation.y) * 0.25;
  });

  // Position locale envoyée au serveur, mais pas à chaque frame (inutile et
  // ça surchargerait le réseau pour rien).
  if (networkStarted) {
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

// Note pour plus tard : les collisions horizontales (murs/décors) ne sont
// toujours pas gérées — seule la verticale (sol/saut) l'est via raycast.
// Prochaine étape logique une fois la nouvelle map en place.
