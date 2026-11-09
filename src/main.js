import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { auth, db } from './firebase.js';
import { initSanctionScreen, listenOwnSanction } from './admin.js';
import { signOutUser } from './auth.js';
import { doc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import {
  connectToServer,
  sendMove,
  sendShoot,
  sendUseVest,
  sendBuyItem,
  sendCollectWeapon,
  sendReload,
  sendCancelReload,
  sendThrowGrenade,
  sendPlacePing,
  sendRemovePing,
  getMyId,
  sendAdminAction,
  requestAdminPlayers,
  requestAdminJournal,
  disconnectFromServer,
} from './network.js';
import { initShop, openShop, closeShop, isShopOpen, renderShop, rarityColor } from './shop.js';
import { getAppearance, getEmojiTexture, sanitizeAppearance, DEFAULT_APPEARANCE } from './appearance.js';
import { getActiveGroupId, getActiveMode, getActiveTeam } from './game-session.js';
import { getKeybinds, keyLabel, matchesAction } from './keybinds.js';
import { getSettings } from './settings.js';
import { audio } from './audio.js';
import { createScoreboard } from './scoreboard.js';
import {
  WEAPON_DEFS,
  WEAPON_ORDER,
  GRENADE_DEFS,
  GRENADE_STEP,
  stepGrenade,
  currentSpread,
  bulletOffsetY,
  BALLISTIC_STEP,
  DEFAULT_RANGE,
  BLOOM_PER_SHOT,
  BLOOM_MAX,
  BLOOM_DECAY_PER_SEC,
  SPRINT_MULT,
  STAMINA_MAX,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_REGEN_PER_SEC,
  STAMINA_REGEN_DELAY,
  STAMINA_MIN_TO_RESUME,
  SLIDE_DURATION,
  SLIDE_SPEED_START,
  SLIDE_SPEED_END,
  SLIDE_COOLDOWN,
  SLIDE_EYE_HEIGHT,
} from './weapons.js';
import { createMinimap } from './minimap.js';
import { createAmbiance } from './ambiance.js';
import { createFx } from './fx.js';
import { createHudFx } from './hudfx.js';
import { computeMapOffsetY, disableTallWallShadows } from './map-align.js';
import { initGameAdminPanel } from './game-admin.js';
// Toutes les données de la map qui ne sont pas de la géométrie visuelle pure
// (boîtes de collision, spawns d'équipe, lumières d'ambiance) — doit rester identique à
// mini-warzone-server/map-data.json. La géométrie visible, elle, vient de
// public/assets/map.glb (voir plus bas).
import mapData from './map-data.json';

// ---------------------------------------------------------------------------
// Scène, caméra, rendu
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
// Ciel, brouillard et lumières : voir ambiance.js (créé plus bas, une fois la
// caméra et le moteur de rendu prêts).

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
// Champ de vision réglable dans Paramètres (voir applySettings plus bas) : BASE_FOV
// est donc modifiable, et le zoom de visée en garde la même proportion que
// dans le jeu d'origine (50° de visée pour 75° normal).
const AIM_FOV_RATIO = 50 / 75;
let BASE_FOV = 75;
let AIM_FOV = 50;
// Sensibilité choisie dans Paramètres : la vitesse réelle de la souris en est
// déduite à chaque image selon le zoom (plus on zoome, plus on ralentit).
let baseSensitivity = 1;
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
// — gilets/armes au sol, traceurs, flash de tir), avec un seuil assez haut
// pour ne pas tout faire baver. OutputPass en dernier pour garder les bonnes
// couleurs (tone mapping + espace de couleur) une fois passé par le composer.
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
// Ambiance : cycle jour/nuit, ciel, brouillard bas + brume, ombres en cascade
// (voir ambiance.js). Les réglages sont lus au chargement de la page ; les
// ombres en cascade ne peuvent changer qu'à ce moment-là.
// ---------------------------------------------------------------------------
const initialSettings = getSettings();
const ambiance = createAmbiance({
  scene,
  camera,
  renderer,
  cycle: initialSettings.dayNight,
  mist: initialSettings.mist,
  sharpShadows: initialSettings.sharpShadows,
});

// Effets de tir (étincelles, poussière, trous, douilles, traceurs) et effets
// d'interface de combat (chiffres de dégâts, direction des coups, vie basse).
const fx = createFx({
  scene,
  camera,
  renderer,
  getDaylight: () => ambiance.getDaylight(),
  getFloorY: () => lastGroundY, // les douilles tombent au niveau du sol sous le joueur
  onShellLand: () => audio.playShellDrop(),
});
fx.setEnabled(initialSettings.impactEffects);
const hudFx = createHudFx({
  camera,
  numbersLayerEl: document.getElementById('damage-numbers'),
  indicatorLayerEl: document.getElementById('damage-indicators'),
  vignetteEl: document.getElementById('low-hp-vignette'),
});

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
// ou l'arme (enfant de la caméra, jamais concernée).
const groundObjects = [fallbackGround];

// Boîtes de collision horizontale (murs, caisses de couverture) — un
// THREE.Box3 par obstacle. Vérifiées séparément du sol (vertical).
// Collisions issues de public/assets/map-colliders.glb

const loadingEl = document.getElementById('loading');
const playButton = document.getElementById('play-button');

const collisionMeshes = [];
const collisionBoxes = [];

let mapLoaded = false;
let collidersLoaded = false;

function showMapError(message, error = null) {
  console.error(`[MAP-COLLIDERS] ${message}`, error ?? '');

  if (loadingEl) {
    loadingEl.style.display = 'block';
    loadingEl.style.whiteSpace = 'pre-wrap';
    loadingEl.textContent = `ERREUR DE CHARGEMENT\n${message}`;
  }

  if (playButton) {
    playButton.disabled = true;
    playButton.textContent = 'Chargement impossible';
  }
}

function enableGameIfReady() {
  if (!mapLoaded || !collidersLoaded) return;

  loadingEl.style.display = 'none';
  playButton.disabled = false;
  playButton.textContent = 'Cliquer pour jouer';
}

// ---------------------------------------------------------------------------
// Map : chargée depuis un fichier .glb (public/assets/map.glb) — plus aucune
// géométrie de salle codée en dur ici. Tout ce que le rendu 3D ne peut pas
// déduire tout seul (boîtes de collision, spawns d'équipe, points
// d'apparition des armes/gilets, lumières d'ambiance) vient de mapData
// (voir l'import en haut du fichier).
// ---------------------------------------------------------------------------

const mapLoader = new GLTFLoader();

mapLoader.load(
  '/assets/map.glb',
  (gltf) => {
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Le GLB est déjà orienté correctement pour le jeu (Y-up).
    // Ne pas le tourner : cela mettait la carte à la verticale.
    // On conserve uniquement le décalage vertical nécessaire pour placer
    // le sol à Y=0 et aligner la carte avec map-colliders.glb.
    gltf.scene.rotation.set(0, 0, 0);
    gltf.scene.scale.set(1, 1, 1);
    // Alignement vertical mesuré plutôt qu'écrit en dur (voir map-align.js) : le
    // sol visible doit être à Y = 0, comme celui des collisions.
    gltf.scene.position.set(0, 0, 0);
    gltf.scene.position.set(0, computeMapOffsetY(gltf.scene), 0);
    scene.add(gltf.scene);
    scene.remove(fallbackGround);
    gltf.scene.updateMatrixWorld(true);
    disableTallWallShadows(gltf.scene); // les murs d'enceinte de 100 m n'ombrent pas l'arène
    ambiance.registerObject(scene); // (ombres en cascade : tous les matériaux doivent être préparés AVANT la compilation)
    // Compile maintenant les shaders de tout ce qui est déjà dans la scène, en
    // tâche de fond, plutôt qu'au premier affichage (sinon la 1re image de
    // chaque nouveauté se fige le temps de la compilation).
    if (renderer.compileAsync) renderer.compileAsync(scene, camera).catch(() => {});
    else renderer.compile(scene, camera);

    const walkableMeshes = [];
    gltf.scene.traverse((child) => {
      if (child.isMesh && /floor|ramp/i.test(child.name)) {
        walkableMeshes.push(child);
      }
    });

    groundObjects.length = 0;
    groundObjects.push(...(walkableMeshes.length ? walkableMeshes : [gltf.scene]));

    (mapData.lights || []).forEach((l) => {
      const light = new THREE.PointLight(l.color, l.intensity, l.distance, l.decay);
      light.position.set(l.x, l.y, l.z);
      scene.add(light);
    });

    mapLoaded = true;
    console.info('[MAP-COLLIDERS] map.glb chargé correctement.');
    enableGameIfReady();
  },
  (progress) => {
    if (progress.total) {
      loadingEl.textContent =
        `Chargement de map.glb… ${Math.round(progress.loaded / progress.total * 100)}%`;
    }
  },
  (error) => {
    showMapError(
      'Impossible de charger /assets/map.glb. Vérifie le chemin, la casse du nom et les erreurs réseau.',
      error
    );
  }
);

// Chargement indépendant du fichier de collisions.
mapLoader.load(
  '/assets/map-colliders.glb',
  (gltf) => {
    gltf.scene.updateMatrixWorld(true);

    let meshCount = 0;
    let invalidCount = 0;

    gltf.scene.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;

      child.updateWorldMatrix(true, false);

      const geometry = child.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();

      const box = new THREE.Box3().setFromObject(child);

      if (
        box.isEmpty() ||
        !Number.isFinite(box.min.x) ||
        !Number.isFinite(box.max.x)
      ) {
        invalidCount++;
        console.error(
          '[MAP-COLLIDERS] Mesh invalide dans map-colliders.glb :',
          child.name || '(sans nom)',
          box
        );
        return;
      }

      // Ces meshes restent invisibles : ils servent uniquement aux collisions.
      collisionMeshes.push(child);
      // Les boîtes accélèrent les collisions de déplacement ; les meshes
      // restent disponibles pour bloquer précisément les tirs par raycast.
      collisionBoxes.push(box.clone());
      meshCount++;
    });

    if (meshCount === 0) {
      showMapError(
        'map-colliders.glb a été chargé, mais aucun mesh de collision valide n’a été trouvé. Vérifie que le fichier contient des objets 3D exportés.'
      );
      return;
    }

    collidersLoaded = true;
    console.info(
      `[MAP-COLLIDERS] Collisions chargées : ${meshCount} mesh(s), ${collisionBoxes.length} boîte(s), ${invalidCount} mesh(s) invalide(s).`
    );

    enableGameIfReady();
  },
  (progress) => {
    if (progress.total) {
      loadingEl.textContent =
        `Chargement de map-colliders.glb… ${Math.round(progress.loaded / progress.total * 100)}%`;
    }
  },
  (error) => {
    showMapError(
      'Impossible de charger /assets/map-colliders.glb. Vérifie que le fichier existe dans public/assets/ et que son nom est exactement map-colliders.glb.',
      error
    );
  }
);

// ---------------------------------------------------------------------------
// Contrôles FPS (pointer lock)
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

// Réglages de jeu (voir settings.js et l'onglet Paramètres du lobby) : lus une
// première fois ici, puis relus à chaque nouvelle partie dans startNetwork().
// Ne touche volontairement à aucune variable déclarée plus bas (isAiming...) :
// cette fonction est appelée dès le chargement du fichier.
function applySettings() {
  const settings = getSettings();
  baseSensitivity = settings.sensitivity;
  controls.pointerSpeed = baseSensitivity;
  BASE_FOV = settings.fov;
  AIM_FOV = settings.fov * AIM_FOV_RATIO;
  camera.fov = BASE_FOV; // la boucle animate() réajuste ensuite vers le zoom si on vise
  camera.updateProjectionMatrix();
  bloomPass.enabled = settings.bloom;
  ambiance.setOptions({ cycle: settings.dayNight, mist: settings.mist });
  fx.setEnabled(settings.impactEffects);
  audio.setVolume(settings.volume);
}
applySettings();

// Les navigateurs interdisent de lancer du son sans geste de l'utilisateur :
// le premier clic ou la première touche débloque l'audio (voir audio.js).
['pointerdown', 'keydown'].forEach((type) => {
  document.addEventListener(type, () => audio.unlock(), { once: true });
});

let networkStarted = false;
const menuEl = document.getElementById('menu');
const quitButton = document.getElementById('quit-button');
const resumeButton = document.getElementById('resume-button');
const adminMenuButton = document.getElementById('admin-menu-button');
const gameAdminPanel = initGameAdminPanel({
  sendAction: sendAdminAction,
  refreshPlayers: requestAdminPlayers,
  requestJournal: requestAdminJournal,
  getMyId,
});
const sanctionScreen = initSanctionScreen({
  onBlock: () => {
    disconnectFromServer();
    networkStarted = false;
    if (isShopOpen()) closeShop();
    if (minimap.isOpen()) minimap.close();
    controls.unlock();
  },
  onLogout: signOutUser,
});
let ownSanctionUnsub = null;
let isAdminUser = false;
let adminProfileUnsub = null;
onAuthStateChanged(auth, (user) => {
  window.__miniWarzoneAdminUser = user ? { uid: user.uid, pseudo: user.displayName || user.email || 'Admin' } : null;
  adminProfileUnsub?.();
  ownSanctionUnsub?.();
  adminProfileUnsub = null;
  ownSanctionUnsub = null;
  isAdminUser = false;
  gameAdminPanel.setAdmin(false);
  if (adminMenuButton) adminMenuButton.hidden = true;
  sanctionScreen.set(null);
  if (!user) return;
  ownSanctionUnsub = listenOwnSanction(user.uid, (sanction) => sanctionScreen.set(sanction));
  adminProfileUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
    isAdminUser = String(snap.data()?.admin).toLowerCase() === 'true';
    if (adminMenuButton) adminMenuButton.hidden = !isAdminUser || !networkStarted;
    gameAdminPanel.setAdmin(isAdminUser, window.__miniWarzoneAdminUser);
  }, () => { isAdminUser = false; if (adminMenuButton) adminMenuButton.hidden = true; gameAdminPanel.setAdmin(false); });
});


resumeButton?.addEventListener('click', () => {
  audio.unlock();
  controls.lock();
});
adminMenuButton?.addEventListener('click', () => {
  if (!isAdminUser) return;
  gameAdminPanel.open();
});

playButton.addEventListener('click', () => {
  audio.unlock();
  controls.lock();
  startNetwork();
});
// Quitter revient simplement au lobby via un rechargement de page : ça
// coupe la connexion au serveur et repart sur un état propre, plutôt que de
// démonter à la main toute la scène 3D, les joueurs adverses, le HUD, etc.
quitButton.addEventListener('click', () => {
  if (window.confirm('Quitter la partie et revenir au lobby ?')) {
    window.location.reload();
  }
});
controls.addEventListener('lock', () => {
  menuEl.style.display = 'none';
});
controls.addEventListener('unlock', () => {
  // Si c'est la boutique qui vient de déverrouiller le pointeur (touche B),
  // on ne veut PAS afficher le menu "Cliquer pour jouer" par-dessus — voir
  // la section "Boutique" plus bas.
  if (isShopOpen() || minimap.isOpen()) return;
  if (resumeButton) resumeButton.hidden = !networkStarted;
  if (adminMenuButton) adminMenuButton.hidden = !isAdminUser || !networkStarted;
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
// Liste dérivée de weapons.js (source de vérité : stats, chargeurs, dispersion).
const WEAPONS = WEAPON_ORDER.map((id) => ({
  id,
  name: WEAPON_DEFS[id].name,
  cooldown: WEAPON_DEFS[id].cooldown,
  autoFire: WEAPON_DEFS[id].autoFire,
  color: WEAPON_DEFS[id].color,
}));

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

function buildShotgunModel(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.42), mat);
  group.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.6), mat);
  barrel.position.set(0, 0.025, -0.48);
  group.add(barrel);
  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.5), mat);
  tube.position.set(0, -0.03, -0.43);
  group.add(tube);
  const pump = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.2), mat);
  pump.position.set(0, -0.045, -0.3);
  group.add(pump);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.06), mat);
  grip.position.set(0, -0.1, 0.12);
  grip.rotation.x = 0.35;
  group.add(grip);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.3), mat);
  stock.position.set(0, -0.01, 0.34);
  group.add(stock);
  return { group, material: mat };
}

function buildSniperModel(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.6), mat);
  group.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, 0.55), mat);
  barrel.position.set(0, 0.02, -0.55);
  group.add(barrel);
  // Lunette : un cylindre posé sur le dessus, deux anneaux aux extrémités
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 12), mat);
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0, 0.11, -0.05);
  group.add(scope);
  [-0.17, 0.07].forEach((z) => {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.03, 12), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.11, z);
    group.add(ring);
  });
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.07), mat);
  magazine.position.set(0, -0.11, -0.05);
  group.add(magazine);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.06), mat);
  grip.position.set(0, -0.09, 0.2);
  grip.rotation.x = 0.35;
  group.add(grip);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.3), mat);
  stock.position.set(0, 0, 0.42);
  group.add(stock);
  return { group, material: mat };
}

const WEAPON_BUILDERS = {
  pistol: buildPistolModel,
  smg: buildSmgModel,
  rifle: buildRifleModel,
  shotgun: buildShotgunModel,
  sniper: buildSniperModel,
};
// Position (Z local) de la bouche du canon : là où apparaît le flash de tir.
const MUZZLE_Z = { pistol: -0.3, smg: -0.42, rifle: -0.6, shotgun: -0.8, sniper: -0.98 };

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

// Factorisée pour être réutilisable sur n'importe quel matériau d'arme — en
// main (weaponModels ci-dessous) ou posée au sol (voir buildWeaponPickupMesh
// plus bas, pour le stuff qui tombe à la mort d'un joueur).
function tintMaterialForRarity(material, baseColor, rarity) {
  if (!rarity || rarity === 'gray') {
    material.color.copy(baseColor);
    material.emissive.set(0x000000);
    return;
  }
  const tint = new THREE.Color(rarityColor(rarity));
  material.color.copy(baseColor).lerp(tint, RARITY_TINT_MIX);
  material.emissive.copy(tint);
  material.emissiveIntensity = 0.3;
}

function applyRarityTint(weaponId, rarity) {
  const entry = weaponModels.find((w) => w.id === weaponId);
  if (!entry) return;
  tintMaterialForRarity(entry.material, entry.baseColor, rarity);
}

// ---------------------------------------------------------------------------
// Stuff au sol (voir dropLoot dans server.js) : armes et gilets tombés à la
// mort d'un joueur. Rien n'est semé sur la carte au hasard — tout vient
// d'une mort. Un objet tombe, reste 1 minute au sol (compté depuis son
// atterrissage, c'est le serveur qui décide : voir armLootTimer dans server.js)
// puis disparaît ; il clignote pendant les 5 dernières secondes.
// Les gilets se ramassent tout seuls en marchant dessus (le serveur s'en
// charge ; côté client, rien à faire à part afficher/retirer leur mesh). Les
// armes demandent la touche E (configurable, voir keybinds.js) à portée —
// voir findClosestGroundWeapon et la mise à jour du prompt dans animate().
// ---------------------------------------------------------------------------
const groundVestMeshes = new Map(); // vestId -> entrée de butin (voir createLootEntry)
const groundWeaponPickups = new Map(); // weaponPickupId -> { ...entrée de butin, weaponId, position }
const LOOT_BLINK_MS = 5000; // clignotement avant disparition
const LOOT_BOUNCE_MS = 300; // petit rebond à l'atterrissage (purement visuel)
const PICKUP_VERTICAL_REACH = 1.2; // doit rester identique à server.js
const WEAPON_PICKUP_INTERACT_RADIUS = 1.8; // doit rester proche de WEAPON_PICKUP_RADIUS côté serveur

// Lueur d'un objet au sol : un sprite additif, PAS une lumière. Chaque
// PointLight ajoutée ou retirée de la scène change le nombre de lumières, ce qui
// oblige three.js à recompiler les shaders de TOUS les matériaux éclairés (la
// map, les joueurs, l'arme...) : sur certaines machines, l'image se figeait
// plusieurs secondes à chaque mort. Les sprites ne touchent pas aux shaders.
let lootGlowTexture = null;
const lootGlowMaterials = new Map(); // couleur -> SpriteMaterial partagé (jamais libéré : 3-4 au total)
function createLootGlow(colorHex) {
  if (!lootGlowTexture) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d');
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    lootGlowTexture = new THREE.CanvasTexture(canvas);
  }
  let material = lootGlowMaterials.get(colorHex);
  if (!material) {
    material = new THREE.SpriteMaterial({
      map: lootGlowTexture,
      color: colorHex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    lootGlowMaterials.set(colorHex, material);
  }
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.1, 1.1, 1);
  sprite.position.y = 0.3;
  sprite.userData.sharedMaterial = true;
  return sprite;
}

// Libère la mémoire GPU d'un objet qui disparaît (butin ramassé ou expiré,
// joueur parti). Les géométries et matériaux de chaque objet sont créés pour lui
// seul ; sont épargnés les matériaux marqués `sharedMaterial` (lueurs) et les
// textures (l'emoji d'un visage est mis en cache et partagé : material.dispose()
// ne libère pas les textures).
function disposeObject3D(root) {
  root.traverse((child) => {
    if (child.userData?.sharedMaterial) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    materials.forEach((m) => m.dispose());
  });
}

function buildVestPickupMesh() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f5fa8, roughness: 0.5, metalness: 0.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 0.14), mat);
  body.position.y = 0.3;
  group.add(body);
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x1b2b3a, roughness: 0.7 });
  [-0.1, 0.1].forEach((x) => {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.05), strapMat);
    strap.position.set(x, 0.3, 0);
    group.add(strap);
  });
  group.add(createLootGlow(0x6fb3ff));
  return group;
}

// Réutilise le vrai modèle 3D de l'arme (voir WEAPON_BUILDERS plus haut),
// couché au sol et teinté selon sa rareté réelle — un fusil rouge tombé au
// sol a donc l'air d'un fusil rouge, pas d'un ramassage générique.
function buildWeaponPickupMesh(weaponId, rarity) {
  const weaponDef = WEAPONS.find((w) => w.id === weaponId) || WEAPONS[0];
  const { group, material } = WEAPON_BUILDERS[weaponDef.id](weaponDef.color);
  tintMaterialForRarity(material, new THREE.Color(weaponDef.color), rarity);
  group.rotation.x = Math.PI / 2; // à plat sur le sol plutôt qu'en position "en main"
  group.position.y = 0.12;

  const holder = new THREE.Group();
  holder.add(group, createLootGlow(rarity && rarity !== 'gray' ? rarityColor(rarity) : 0xffffff));
  return holder;
}

// Suivi d'un objet au sol : sa chute (de fromY jusqu'à position.y, durée
// fallMs, calculées par le serveur) et son échéance. `position` est la position
// FINALE, au sol. Sans infos de chute (ancien serveur), l'objet est posé direct.
function createLootEntry(mesh, position, { fromY, fallMs, expiresInMs } = {}) {
  const now = performance.now();
  return {
    mesh,
    position,
    fromY: Number.isFinite(fromY) ? fromY : position.y,
    fallMs: Number.isFinite(fallMs) ? fallMs : 0,
    spawnedAt: now,
    // échéance : sans info du serveur, aucune disparition programmée côté client
    expiresAt: Number.isFinite(expiresInMs) ? now + expiresInMs : Infinity,
    spin: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3),
  };
}

// Chute (accélérée), rebond, puis clignotement final. Appelée à chaque image.
function updateLootEntry(entry, now) {
  const elapsed = now - entry.spawnedAt;
  const baseY = entry.position.y;
  if (elapsed < entry.fallMs) {
    const k = elapsed / entry.fallMs;
    entry.mesh.position.y = baseY + (entry.fromY - baseY) * (1 - k * k);
    entry.mesh.rotation.y += entry.spin * 0.016 * (1 - k);
  } else {
    const bounce = (elapsed - entry.fallMs) / LOOT_BOUNCE_MS;
    entry.mesh.position.y = bounce < 1 ? baseY + 0.1 * Math.sin(Math.PI * bounce) * (1 - bounce) : baseY;
  }
  const left = entry.expiresAt - now;
  entry.mesh.visible = left > LOOT_BLINK_MS || Math.floor(now / 160) % 2 === 0;
}

function updateGroundLoot(now) {
  groundVestMeshes.forEach((entry, id) => {
    if (now > entry.expiresAt + 3000) removeGroundVest(id); // filet de sécurité si l'événement de retrait s'est perdu
    else updateLootEntry(entry, now);
  });
  groundWeaponPickups.forEach((entry, id) => {
    if (now > entry.expiresAt + 3000) removeGroundWeaponPickup(id);
    else updateLootEntry(entry, now);
  });
}

function addGroundVest({ id, position, fromY, fallMs, expiresInMs }) {
  if (groundVestMeshes.has(id)) return;
  const mesh = buildVestPickupMesh();
  const entry = createLootEntry(mesh, position, { fromY, fallMs, expiresInMs });
  mesh.position.set(position.x, entry.fromY, position.z);
  scene.add(mesh);
  groundVestMeshes.set(id, entry);
}
function removeGroundVest(id) {
  const entry = groundVestMeshes.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  disposeObject3D(entry.mesh);
  groundVestMeshes.delete(id);
}
function handleCurrentVests(items) {
  items.forEach(addGroundVest);
}
function handleVestRemoved({ id }) {
  removeGroundVest(id);
}

function addGroundWeaponPickup({ id, weaponId, rarity, position, fromY, fallMs, expiresInMs }) {
  if (groundWeaponPickups.has(id)) return;
  const mesh = buildWeaponPickupMesh(weaponId, rarity);
  const entry = createLootEntry(mesh, position, { fromY, fallMs, expiresInMs });
  mesh.position.set(position.x, entry.fromY, position.z);
  scene.add(mesh);
  groundWeaponPickups.set(id, { ...entry, weaponId });
}
function removeGroundWeaponPickup(id) {
  const entry = groundWeaponPickups.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  disposeObject3D(entry.mesh);
  groundWeaponPickups.delete(id);
}
function handleCurrentWeaponPickups(items) {
  items.forEach(addGroundWeaponPickup);
}
function handleWeaponPickupRemoved({ id }) {
  removeGroundWeaponPickup(id);
}

// Arme au sol la plus proche à portée de ramassage (touche E), ou null.
function findClosestGroundWeapon() {
  let closestId = null;
  let closestDist = WEAPON_PICKUP_INTERACT_RADIUS;
  groundWeaponPickups.forEach(({ position }, id) => {
    // portée horizontale + fenêtre verticale : les objets sont au sol, pas à hauteur des yeux
    const dist = Math.hypot(camera.position.x - position.x, camera.position.z - position.z);
    if (Math.abs(camera.position.y - 0.9 - position.y) > PICKUP_VERTICAL_REACH) return;
    if (dist < closestDist) {
      closestDist = dist;
      closestId = id;
    }
  });
  return closestId;
}

// currentWeaponIndex reste l'index dans WEAPONS/weaponModels du modèle
// affiché ; currentSlot (déclaré plus loin, 0/1) est ce que l'UI et les
// entrées clavier/souris utilisent pour savoir quel slot du stuff est actif.
let currentWeaponIndex = 0;
weaponModels[currentWeaponIndex].group.visible = true;

// Petit flash bref au canon à chaque tir — attaché à l'arme donc suit
// automatiquement ses mouvements (recul, visée, bob).
const muzzleFlashLight = new THREE.PointLight(0xffe08a, 0, 5, 2);
muzzleFlashLight.position.set(0, 0.02, -0.5);
weaponGroup.add(muzzleFlashLight);
// Gerbe de flamme dessinée à la bouche du canon (additive, taille et angle au
// hasard à chaque tir) : plus lisible qu'une simple lueur.
const muzzleFlashSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: fx.getFlashTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    opacity: 0,
  })
);
muzzleFlashSprite.position.set(0, 0.02, -0.5);
muzzleFlashSprite.visible = false;
weaponGroup.add(muzzleFlashSprite);
let muzzleFlashTimeout = null;
function showMuzzleFlash(weaponId) {
  // en visant, la flamme est réduite pour ne pas boucher la vue
  const size = (isAiming ? 0.22 : 0.42) * (weaponId === 'shotgun' ? 1.5 : weaponId === 'sniper' ? 1.25 : 1) * (0.85 + Math.random() * 0.4);
  muzzleFlashSprite.scale.setScalar(size);
  muzzleFlashSprite.material.rotation = Math.random() * Math.PI * 2;
  muzzleFlashSprite.material.opacity = isAiming ? 0.7 : 1;
  muzzleFlashSprite.visible = true;
  muzzleFlashLight.intensity = 14;
  clearTimeout(muzzleFlashTimeout);
  muzzleFlashTimeout = setTimeout(() => {
    muzzleFlashLight.intensity = 0;
    muzzleFlashSprite.visible = false;
  }, 55);
}

// Met à jour le modèle 3D visible (et sa teinte de rareté) d'après le slot
// actuellement sélectionné et le contenu réel de myWeapons — appelée aussi
// bien quand on change de slot (touches 1/2) que quand le contenu d'un
// slot change (achat en boutique, reset au respawn).
function refreshEquippedWeaponDisplay() {
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
  muzzleFlashLight.position.z = MUZZLE_Z[equipped.id] ?? -0.5;
  muzzleFlashSprite.position.z = MUZZLE_Z[equipped.id] ?? -0.5;
  updateAmmoUI();
}

// Sélectionne un slot d'arme (0 ou 1). Pour un slot vide (pas encore
// ramassé) ou en pleine mort, on ignore — on ne peut pas "sélectionner" une
// arme qu'on n'a pas.
function selectSlot(slot, { silent = false } = {}) {
  if (isDead || slot < 0 || slot > 1) return;
  if (!myWeapons[slot]) return; // rien dans ce slot

  const changed = slot !== currentSlot;
  if (changed) cancelReload();
  currentSlot = slot;
  refreshEquippedWeaponDisplay();
  updateInventoryUI();
  if (changed && !silent && networkStarted) audio.playSwitchWeapon();
}
document.addEventListener('keydown', (e) => {
  if (isOverlayOpen()) return; // pas de changement d'arme "à l'aveugle" pendant qu'on regarde la boutique/la carte
  if (e.code === keybinds.weaponSlot1) selectSlot(0);
  if (e.code === keybinds.weaponSlot2) selectSlot(1);
});

// Molette = change de slot (pas besoin d'assigner une touche pour ça —
// toujours actif). Un seul cran par geste de molette : sur un pavé tactile,
// un même mouvement peut déclencher plusieurs 'wheel' de suite, d'où le
// petit temps mort ci-dessous. Un seul slot vide à sauter avec seulement 2
// slots d'arme, mais la boucle reste correcte si un jour il y en a plus.
let lastWheelSwitchAt = 0;
const WHEEL_SWITCH_COOLDOWN_MS = 150;
document.addEventListener(
  'wheel',
  (e) => {
    if (isOverlayOpen() || isDead || !networkStarted) return;
    const now = performance.now();
    if (now - lastWheelSwitchAt < WHEEL_SWITCH_COOLDOWN_MS) return;
    const direction = e.deltaY > 0 ? 1 : -1;
    const total = myWeapons.length;
    for (let i = 1; i <= total; i++) {
      const next = (currentSlot + direction * i + total) % total;
      if (myWeapons[next]) {
        lastWheelSwitchAt = now;
        selectSlot(next);
        break;
      }
    }
  },
  { passive: true }
);

const _weaponTarget = new THREE.Vector3();
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
// départ au premier spawn, jamais perdu — seule sa rareté peut changer via
// la boutique) + un compteur de gilets en
// réserve (max myMaxVestSlots, à utiliser avec la touche P pour les
// convertir en bouclier). Chaque slot d'arme non vide est maintenant un
// objet { id, rarity } (et plus une simple chaîne) depuis l'introduction du
// système de rareté — voir shop.js. currentSlot vaut 0 ou 1 (armes
// uniquement) — sélection via les touches 1/2 ; les gilets n'ont plus de
// slot dédié, voir la touche P plus bas.
let myWeapons = [{ id: 'pistol', rarity: 'gray', ammo: WEAPON_DEFS.pistol.magSize }, null];
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
];
const vestStockEl = document.getElementById('vest-stock');
const pickupPromptEl = document.getElementById('pickup-prompt');

// Kill feed (en haut à droite) et tableau des scores (touche maintenue) —
// voir scoreboard.js ; les données viennent du serveur.
const scoreboard = createScoreboard({
  feedEl: document.getElementById('kill-feed'),
  boardEl: document.getElementById('scoreboard'),
  getMyId,
  weaponName: (id) => weaponLabel(id),
  rarityColor,
});
document.addEventListener('keydown', (e) => {
  if (e.code !== keybinds.scoreboard || !networkStarted) return;
  e.preventDefault(); // sinon Tab déplace le focus du navigateur
  if (!e.repeat) scoreboard.show();
});
document.addEventListener('keyup', (e) => {
  if (e.code === keybinds.scoreboard) scoreboard.hide();
});
// Si la fenêtre perd le focus touche enfoncée (Alt+Tab...), le keyup n'arrive jamais
window.addEventListener('blur', () => scoreboard.hide());

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
  if (weaponId === 'frag') return GRENADE_DEFS.frag.name;
  if (weaponId === 'admin') return 'Administrateur';
  const weapon = WEAPONS.find((w) => w.id === weaponId);
  return weapon ? weapon.name : 'Vide';
}

// Renvoie l'état actuel du joueur au format attendu par shop.js
// (renderShop/openShop) — regroupé ici pour n'avoir qu'un seul endroit à
// mettre à jour si la boutique a besoin d'une donnée de plus un jour.
function getShopState() {
  return {
    money: localMoney,
    weapons: myWeapons,
    vestCount: myVestCount,
    maxVestSlots: myMaxVestSlots,
    grenades: myGrenades,
  };
}

function updateInventoryUI() {
  invSlotEls.forEach((el, index) => {
    if (!el) return;
    el.classList.toggle('active', index === currentSlot);
    const label = el.querySelector('.inv-label');
    const dot = el.querySelector('.inv-rarity-dot');
    if (!label) return;
    const weapon = myWeapons[index];
    el.classList.toggle('empty', !weapon);
    label.textContent = weapon ? weaponLabel(weapon.id) : 'Vide';
    if (dot) {
      dot.style.background = weapon ? rarityColor(weapon.rarity) : 'transparent';
      dot.style.boxShadow = weapon ? `0 0 4px ${rarityColor(weapon.rarity)}` : 'none';
    }
  });
  updateVestStockUI();
}

// Rangée de petits carrés sous le stuff (voir #vest-stock dans index.html) :
// un carré par emplacement de gilet (myMaxVestSlots, 2 ou 3 selon la
// capacité achetée), grisé par défaut et rempli pour chaque gilet
// effectivement en réserve — le stock visible d'un coup d'œil, sans chiffre.
function updateVestStockUI() {
  if (!vestStockEl) return;
  const pips = Array.from(vestStockEl.children);
  while (pips.length < myMaxVestSlots) {
    const pip = document.createElement('div');
    pip.className = 'vest-pip';
    vestStockEl.appendChild(pip);
    pips.push(pip);
  }
  while (pips.length > myMaxVestSlots) {
    vestStockEl.removeChild(pips.pop());
  }
  pips.forEach((pip, index) => pip.classList.toggle('filled', index < myVestCount));
}
updateInventoryUI();

// Instant du dernier clic sur « Acheter » : sert à ne pas jouer le bruit de
// ramassage par-dessus le bruit d'achat quand le stuff change à cause d'un achat.
let lastBuyClickAt = -Infinity;
const isRecentBuy = () => performance.now() - lastBuyClickAt < 800;

function handleWeaponsUpdate(weapons) {
  const previousWeapons = myWeapons;
  myWeapons = weapons;
  const gainedWeapon = weapons.some(
    (w, i) => w && (!previousWeapons[i] || previousWeapons[i].id !== w.id || previousWeapons[i].rarity !== w.rarity)
  );
  if (gainedWeapon && !isRecentBuy()) audio.playWeaponPickup();
  // Reteinte les deux modèles dès que le stuff change (achat, ramassage,
  // reset au respawn) même si le slot correspondant n'est pas affiché tout
  // de suite — la teinte sera donc déjà bonne si on rechange de slot plus tard.
  myWeapons.forEach((w) => { if (w) applyRarityTint(w.id, w.rarity); });
  if (isReloading) {
    const reloaded = myWeapons[reloadSlot];
    if (!reloaded || `${reloaded.id}:${reloaded.rarity}` !== reloadWeaponKey) cancelReload({ notify: false });
  }
  // Si le slot actif vient de perdre son arme (ex: reset à la mort), on
  // retombe sur le pistolet plutôt que de rester bloqué sur un slot vide.
  if (!myWeapons[currentSlot]) {
    selectSlot(0, { silent: true });
  } else {
    refreshEquippedWeaponDisplay();
    updateInventoryUI();
  }
  updateAmmoUI();
  if (isShopOpen()) renderShop(getShopState());
}

function handleVestCountUpdate(count) {
  if (count > myVestCount && !isRecentBuy()) audio.playPickup();
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
function showHitMarker() {
  audio.playHitMarker();
  crosshairEl.classList.add('hit');
  clearTimeout(hitMarkerTimeout);
  hitMarkerTimeout = setTimeout(() => crosshairEl.classList.remove('hit'), 150);
}

// Touche confirmée par le serveur : marqueur sur le viseur + chiffre de dégâts
// flottant au-dessus de la cible (cumulé si on la touche en rafale).
const _damageNumberPos = new THREE.Vector3();
function handleHitConfirmed(data) {
  showHitMarker();
  const entry = data?.target ? otherPlayers.get(data.target) : null;
  if (!entry || !(data.damage > 0)) return;
  _damageNumberPos.set(entry.mesh.position.x, entry.mesh.position.y + 2.05, entry.mesh.position.z);
  hudFx.showDamageNumber(_damageNumberPos, data.damage, Boolean(data.headshot), data.target);
}

// Quelqu'un (ou une explosion) nous blesse : arc rouge qui pointe vers la source
function handleDamageTaken({ x, z, amount }) {
  hudFx.addDamageSource(x, z, amount);
}

// --- Effets des commandes d'administration reçues ---------------------------------
const adminStatusEl = document.createElement('div');
adminStatusEl.id = 'admin-status';
adminStatusEl.hidden = true;
document.body.appendChild(adminStatusEl);
const ADMIN_MODE_LABELS = {
  godmode: 'Invincible',
  noclip: 'Murs traversés',
  fly: 'Vol',
  invisible: 'Invisible',
  infiniteAmmo: 'Munitions illimitées',
  oneShot: 'Un tir = un mort',
  frozen: 'Immobilisé',
};

function applyAdminState(state = {}) {
  Object.keys(adminState).forEach((key) => {
    if (key in state) adminState[key] = state[key];
  });
  adminState.speed = Number(adminState.speed) || 1;
  // Petit bandeau rappelant les modes actifs sur soi (pour ne pas les oublier)
  const active = Object.entries(ADMIN_MODE_LABELS)
    .filter(([key]) => adminState[key])
    .map(([, label]) => label);
  if (adminState.speed !== 1) active.push(`Vitesse ×${adminState.speed}`);
  adminStatusEl.hidden = active.length === 0;
  adminStatusEl.textContent = active.join(' · ');
  if (!adminState.fly) verticalVelocity = 0; // plus de vol : on retombe proprement
}

// Un admin nous déplace (« amener », « aller vers », point de départ, coordonnées)
function handleAdminTeleport({ position }) {
  if (!position) return;
  endSlide();
  camera.position.set(position.x, position.y, position.z);
  velocity.set(0, 0, 0);
  verticalVelocity = 0;
  lastGroundY = position.y - STAND_EYE_HEIGHT;
}

// Expulsé de la partie par un admin : on coupe et on retourne au lobby
function handleAdminKicked({ reason } = {}) {
  disconnectFromServer();
  networkStarted = false;
  window.alert(`Tu as été expulsé de la partie par un administrateur.${reason ? `\nMotif : ${reason}` : ''}`);
  window.location.reload();
}

let respawnInterval = null;
function handleYouDied() {
  hudFx.clear();
  isDead = true;
  audio.playDeath();
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
  if (minimap.isOpen()) {
    minimap.close();
    menuEl.style.display = 'flex';
  }
  // Fin de toute action en cours
  cancelReload({ notify: false });
  isSprinting = false;
  endSlide();
  isAiming = false;
  isMouseDown = false;
  updateAmmoUI();

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
  myWeapons = [{ id: 'pistol', rarity: 'gray', ammo: WEAPON_DEFS.pistol.magSize }, null];
  applyRarityTint('pistol', 'gray');
  selectSlot(0, { silent: true });
  audio.playRespawn();
  deathScreenEl.hidden = true;
  clearInterval(respawnInterval);
  verticalVelocity = 0;
  stamina = STAMINA_MAX;
  sprintLocked = false;
  bloom = 0;
  updateAmmoUI();
  if (position) {
    camera.position.set(position.x, position.y, position.z);
  }
}

function handleHpUpdate(hp) {
  if (hp < localHp) {
    flashDamage();
    audio.playHurt();
  }
  localHp = hp;
  updateHealthUI(hp);
}

function handleShieldUpdate(shield) {
  if (shield > localShield) audio.playUseVest();
  updateShieldUI(shield);
}

function handleMoneyUpdate(money) {
  if (money < localMoney) audio.playPurchase(); // l'argent ne baisse que quand on achète
  updateMoneyUI(money);
  if (isShopOpen()) renderShop(getShopState());
}

// Quelqu'un vient d'être éliminé (voir 'kill-feed' dans server.js) : on
// l'affiche, et si c'est toi le tueur, petit « ding » de confirmation.
function handleKillFeed(data) {
  scoreboard.addKill(data);
  if (data && data.killerId && data.killerId === getMyId()) audio.playKill();
}

// ---------------------------------------------------------------------------
// Déplacement, saut, accroupi, visée
// ---------------------------------------------------------------------------
// Touches configurables (voir keybinds.js + l'onglet Paramètres du lobby) :
// lues une première fois ici, puis rafraîchies à chaque nouvelle partie dans
// startNetwork() — inutile de re-render pendant une partie en cours, la
// page du lobby (où on les modifie) est masquée tant qu'on joue.
let keybinds = getKeybinds();
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

// Sons de déplacement (voir audio.js) : distance parcourue au sol depuis le
// dernier pas, et orientation de l'« oreille » du joueur pour spatialiser les
// sons des autres.
const STEP_LENGTH = 1.7; // mètres entre deux pas (marche)
const CROUCH_STEP_LENGTH = 2.4; // accroupi : pas plus espacés (et plus discrets, voir audio.js)
let stepDistance = 0;
let prevStepX = 0;
let prevStepZ = 0;
const listenerDir = new THREE.Vector3();
const JUMP_SPEED = 6.5;
let verticalVelocity = 0;
let isGrounded = true;
// Modes administrateur appliqués à CE joueur par un admin (le serveur est la
// source de vérité et renvoie l'état complet à chaque changement : 'admin-state').
// godmode / invisible / infiniteAmmo / oneShot sont gérés par le serveur ; le
// client n'a besoin de connaître que ce qui change son propre mouvement ou son
// affichage (noclip, vol, vitesse, immobilisation).
const adminState = {
  godmode: false,
  noclip: false,
  fly: false,
  invisible: false,
  infiniteAmmo: false,
  oneShot: false,
  frozen: false,
  speed: 1,
};
let jumpHeld = false;

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
const FLAT_PLATE_MAX_THICKNESS = 0.2; // en dessous : décor plat, ignoré par les collisions
const STEP_HEIGHT = 0.35; // hauteur max franchie sans collision (les plaques de spawn font 0,3 m)

function collidesAt(x, z) {
  if (collisionBoxes.length === 0) return false;

  // Le corps va des PIEDS au sommet de la tête. Les pieds se déduisent de la
  // hauteur d'yeux ACTUELLE (1,7 m debout, 1,0 accroupi, 0,8 en glissade) : avec
  // une valeur fixe de 1,7 m, un joueur accroupi avait ses "pieds" calculés
  // 0,7 m sous terre, donc dans la boîte de collision du sol (qui couvre toute
  // la map) : il était bloqué de tous côtés, comme enfoncé dans le sol.
  const eyeY = camera.position.y;
  const playerMinY = eyeY - currentEyeHeight;
  const playerMaxY = eyeY - 0.15;

  for (const box of collisionBoxes) {
    // On ignore ce qui est entièrement au-dessus de la tête, ou qui ne dépasse
    // pas la hauteur d'une marche au-dessus des pieds : sol, plaques de spawn
    // (0,3 m), petits rebords. Ils ne sont pas des murs : le sol visible suit
    // ces reliefs (voir getGroundY) et le joueur monte dessus.
    if (box.max.y <= playerMinY + STEP_HEIGHT || box.min.y >= playerMaxY) continue;
    // Plaque plate (moins de 20 cm d'épaisseur) : un décor posé sur le sol, comme
    // les motifs des zones de départ (7 cm d'épaisseur, 7 m de côté) — pas un mur.
    // Sans ça, on apparaissait coincé au milieu de sa zone de départ.
    if (box.max.y - box.min.y < FLAT_PLATE_MAX_THICKNESS) continue;

    // Circle (player) versus axis-aligned box, in the horizontal plane.
    const closestX = THREE.MathUtils.clamp(x, box.min.x, box.max.x);
    const closestZ = THREE.MathUtils.clamp(z, box.min.z, box.max.z);
    const dx = x - closestX;
    const dz = z - closestZ;
    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }

  return false;
}

function resolveHorizontalCollisions(prevX, prevZ) {
  if (adminState.noclip) return;
  if (collidesAt(camera.position.x, prevZ)) {
    camera.position.x = prevX;
  }
  if (collidesAt(camera.position.x, camera.position.z)) {
    camera.position.z = prevZ;
  }
}

function onKeyChange(e, isDown) {
  switch (e.code) {
    case keybinds.forward:
      move.forward = isDown;
      break;
    case keybinds.backward:
      move.backward = isDown;
      break;
    case keybinds.left:
      move.left = isDown;
      break;
    case keybinds.right:
      move.right = isDown;
      break;
    case keybinds.jump:
      jumpHeld = isDown;
      if (isDown && isGrounded && !isDead && !adminState.frozen) {
        if (slideTimer > 0) {
          // Saut depuis une glissade : on garde l'élan vers l'avant
          endSlide();
          velocity.z = -BASE_SPEED * 1.5;
        }
        verticalVelocity = JUMP_SPEED;
        isGrounded = false;
        audio.playJump();
      }
      break;
    case keybinds.crouch:
      // S'accroupir EN COURANT déclenche une glissade
      if (isDown && !isCrouching && canStartSlide()) startSlide();
      isCrouching = isDown;
      break;
    case keybinds.sprint:
      sprintHeld = isDown;
      break;
  }
}
document.addEventListener('keydown', (e) => onKeyChange(e, true));
document.addEventListener('keyup', (e) => onKeyChange(e, false));

// Clic droit maintenu = viser (zoom + arme recentrée + déplacement ralenti).
// Touche P = consomme un gilet en réserve pour regagner du bouclier (action
// unique, pas un maintien) — plus besoin de sélectionner un slot dédié au
// préalable, voir la touche 3 disparue plus haut.
// Clic gauche = tir. Maintenu, ça ne re-tire en continu que pour les armes
// automatiques (WEAPONS[].autoFire) — géré dans animate().
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
let isMouseDown = false;
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 2) {
    isAiming = true;
  }
  if (e.button === 0) {
    isMouseDown = true;
    isSprinting = false; // tirer coupe la course (elle reprend toute seule au relâchement)
    tryShoot(clock.elapsedTime);
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2) isAiming = false;
  if (e.button === 0) isMouseDown = false;
});

document.addEventListener('keydown', (e) => {
  if (e.code !== keybinds.useVest || isDead || isOverlayOpen()) return;
  if (myVestCount > 0) sendUseVest();
});

// Ramasse l'arme au sol la plus proche (si une est à portée) et la met dans
// le slot sélectionné si le stuff est plein, ou dans le slot vide sinon —
// voir la logique côté serveur ('collect-weapon' dans server.js).
document.addEventListener('keydown', (e) => {
  if (e.code !== keybinds.pickupWeapon || isDead || isOverlayOpen() || !networkStarted) return;
  const closestId = findClosestGroundWeapon();
  if (closestId) sendCollectWeapon(closestId, currentSlot);
});

// ---------------------------------------------------------------------------
// Boutique (voir shop.js)
// ---------------------------------------------------------------------------
// La touche B ouvre/ferme la boutique depuis n'importe où (plus de magasin
// physique dans la salle). Le serveur reste seul juge des achats — voir
// shop.js et 'buy-item' dans mini-warzone-server/server.js.
initShop({
  onBuy: (itemId) => {
    lastBuyClickAt = performance.now();
    sendBuyItem(itemId);
  },
  onClose: () => controls.lock(),
});

document.addEventListener('keydown', (e) => {
  if (e.code !== keybinds.shop || isDead || !networkStarted || minimap.isOpen()) return;
  if (isShopOpen()) {
    closeShop();
    controls.lock(); // touche B pressée = geste utilisateur direct, le verrouillage du pointeur est autorisé
  } else {
    controls.unlock(); // affiche le curseur pour pouvoir cliquer sur les boutons de la boutique
    openShop(getShopState());
  }
});

// ---------------------------------------------------------------------------
// Gameplay étendu : munitions, rechargement, course, glissade, grenades,
// effets d'explosion/fumée, carte et pings d'équipe.
// Le serveur reste seul juge des munitions, des dégâts et des explosions
// (voir server.js) : ce qui suit est surtout de l'affichage et de la
// prédiction locale, recalée sur ce que dit le serveur.
// ---------------------------------------------------------------------------
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Boutique OU carte ouverte : le joueur ne bouge, ne tire et ne change pas d'arme.
function isOverlayOpen() {
  return isShopOpen() || minimap.isOpen();
}

// --- Munitions & rechargement ------------------------------------------------
const ammoHudEl = document.getElementById('ammo-hud');
const ammoCountEl = document.getElementById('ammo-count');
const ammoMagEl = document.getElementById('ammo-mag');
const ammoStateEl = document.getElementById('ammo-state');
const reloadFillEl = document.getElementById('reload-fill');

let isReloading = false;
let reloadStartedAt = 0;
let reloadDurationMs = 0;
let reloadSlot = -1;
let reloadWeaponKey = '';
let lastLocalShotAt = -Infinity; // performance.now() du dernier tir local
let bloom = 0; // dispersion accumulée en rafale (voir weapons.js)

function updateAmmoUI() {
  if (!ammoHudEl) return;
  const weapon = myWeapons[currentSlot];
  if (!weapon) {
    ammoHudEl.style.display = 'none';
    return;
  }
  const def = WEAPON_DEFS[weapon.id];
  const ammo = weapon.ammo ?? def.magSize;
  ammoHudEl.style.display = 'flex';
  ammoCountEl.textContent = String(ammo);
  ammoMagEl.textContent = `/ ${def.magSize}`;
  ammoHudEl.classList.toggle('empty', ammo <= 0 && !isReloading);
  ammoHudEl.classList.toggle('low', ammo > 0 && ammo <= Math.ceil(def.magSize * 0.25));
  ammoHudEl.classList.toggle('reloading', isReloading);
  ammoStateEl.textContent = isReloading
    ? 'Rechargement'
    : ammo <= 0
      ? `${keyLabel(keybinds.reload)} recharger`
      : '';
}

function startReload() {
  if (isDead || isReloading || isOverlayOpen() || !networkStarted) return;
  const weapon = myWeapons[currentSlot];
  if (!weapon) return;
  const def = WEAPON_DEFS[weapon.id];
  if ((weapon.ammo ?? def.magSize) >= def.magSize) return;

  isReloading = true;
  reloadSlot = currentSlot;
  reloadWeaponKey = `${weapon.id}:${weapon.rarity}`;
  reloadStartedAt = performance.now();
  reloadDurationMs = def.reloadTime * 1000;
  audio.playReload(def.reloadTime);
  sendReload(currentSlot);
  updateAmmoUI();
}

function cancelReload({ notify = true } = {}) {
  if (!isReloading) return;
  isReloading = false;
  if (notify) sendCancelReload();
  updateAmmoUI();
}

function finishReloadLocally() {
  const weapon = myWeapons[reloadSlot];
  isReloading = false;
  if (weapon) weapon.ammo = WEAPON_DEFS[weapon.id].magSize;
  updateAmmoUI();
}

// Le serveur envoie le nombre de balles restantes (après un tir, un tir refusé
// à vide, ou la fin d'un rechargement). En pleine rafale on ignore ses valeurs
// "trop hautes" (elles arrivent avec la latence, en retard sur notre compte local).
function handleAmmoUpdate({ slot, ammo, reloaded } = {}) {
  const weapon = myWeapons[slot];
  if (!weapon || !Number.isFinite(ammo)) return;
  if (reloaded) {
    weapon.ammo = ammo;
    if (isReloading && reloadSlot === slot) isReloading = false;
  } else if (ammo < (weapon.ammo ?? Infinity) || performance.now() - lastLocalShotAt > 350) {
    weapon.ammo = ammo;
  }
  updateAmmoUI();
}

document.addEventListener('keydown', (e) => {
  if (e.code !== keybinds.reload || e.repeat) return;
  startReload();
});

// --- Dispersion, recul de caméra ---------------------------------------------
const _shotRight = new THREE.Vector3();
const _shotUp = new THREE.Vector3();
const _recoilEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function computeCurrentSpread(def) {
  const moving = slideTimer > 0 || Math.hypot(velocity.x, velocity.z) > 0.6;
  return currentSpread(def, {
    aiming: isAiming,
    moving,
    airborne: !isGrounded,
    crouching: isCrouching,
    bloom,
  });
}

// Renvoie `base` légèrement dévié, uniformément dans un disque de rayon `spread`
function perturbDirection(base, spread, out) {
  if (spread <= 0) return out.copy(base);
  _shotRight.crossVectors(base, WORLD_UP);
  if (_shotRight.lengthSq() < 1e-6) _shotRight.set(1, 0, 0);
  _shotRight.normalize();
  _shotUp.crossVectors(_shotRight, base).normalize();
  const r = spread * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return out
    .copy(base)
    .addScaledVector(_shotRight, Math.cos(a) * r)
    .addScaledVector(_shotUp, Math.sin(a) * r)
    .normalize();
}

// Fait pivoter la vue (tangage/lacet) — sert au recul des armes et aux secousses.
function nudgeCamera(dPitch, dYaw) {
  _recoilEuler.setFromQuaternion(camera.quaternion);
  _recoilEuler.x = THREE.MathUtils.clamp(_recoilEuler.x + dPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  _recoilEuler.y += dYaw;
  camera.quaternion.setFromEuler(_recoilEuler);
}

function applyCameraRecoil(def) {
  const factor = isAiming ? 0.6 : 1;
  nudgeCamera(def.recoil * factor * (0.8 + Math.random() * 0.4), (Math.random() - 0.5) * def.recoil * 0.5);
}

// Secousse d'écran (explosions proches) : une petite série d'impulsions qui se
// compensent, pour que la vue revienne exactement où elle était.
function shakeCamera(strength) {
  const amp = 0.014 * THREE.MathUtils.clamp(strength, 0, 1);
  if (amp <= 0.0005) return;
  [1, -2, 2, -1].forEach((k, i) => {
    setTimeout(() => nudgeCamera(amp * k, -amp * k * 0.6), i * 45);
  });
}

// Zoom effectif en visée : la lunette du sniper zoome bien plus que les autres armes.
function getAimFov() {
  const weapon = myWeapons[currentSlot];
  const zoom = weapon ? WEAPON_DEFS[weapon.id].zoomRatio : null;
  return zoom ? BASE_FOV * zoom : AIM_FOV;
}

// --- Course, endurance, glissade ---------------------------------------------
const staminaBarEl = document.getElementById('stamina-bar');
const staminaFillEl = document.getElementById('stamina-fill');
let sprintHeld = false;
let isSprinting = false;
let sprintLocked = false; // vrai après épuisement, jusqu'à récupérer STAMINA_MIN_TO_RESUME
let stamina = STAMINA_MAX;
let staminaRegenTimer = 0;
let sprintBlend = 0; // 0..1 : arme baissée en courant
let reloadBlend = 0; // 0..1 : animation de rechargement
let throwKick = 0; // 0..1 : geste de lancer

let slideTimer = 0;
let slideCooldown = 0;
const slideDir = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function updateSprintState(delta) {
  const canRun =
    sprintHeld && !isDead && !isOverlayOpen() && !isAiming && !isCrouching && !isMouseDown &&
    slideTimer <= 0 && move.forward && !move.backward;

  isSprinting = canRun && !sprintLocked && stamina > 0;
  if (isSprinting) {
    stamina = Math.max(0, stamina - STAMINA_DRAIN_PER_SEC * delta);
    staminaRegenTimer = STAMINA_REGEN_DELAY;
    if (stamina <= 0) {
      sprintLocked = true;
      isSprinting = false;
      audio.playExhausted();
    }
  } else {
    staminaRegenTimer = Math.max(0, staminaRegenTimer - delta);
    if (staminaRegenTimer <= 0 && stamina < STAMINA_MAX) {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN_PER_SEC * delta);
    }
    if (sprintLocked && stamina >= STAMINA_MIN_TO_RESUME) sprintLocked = false;
  }

  if (staminaBarEl) {
    staminaBarEl.classList.toggle('show', stamina < STAMINA_MAX || isSprinting);
    staminaBarEl.classList.toggle('exhausted', sprintLocked);
    staminaFillEl.style.width = `${(stamina / STAMINA_MAX) * 100}%`;
  }
}

function canStartSlide() {
  return isSprinting && isGrounded && slideCooldown <= 0 && slideTimer <= 0 && !isDead && !isOverlayOpen() && !adminState.frozen;
}

function startSlide() {
  // Direction = là où on court (avant + éventuel côté), figée pour toute la glissade
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();
  slideDir.set(0, 0, 0);
  slideDir.addScaledVector(_fwd, Number(move.forward) - Number(move.backward));
  slideDir.x += -_fwd.z * (Number(move.right) - Number(move.left));
  slideDir.z += _fwd.x * (Number(move.right) - Number(move.left));
  if (slideDir.lengthSq() < 1e-6) slideDir.copy(_fwd);
  slideDir.normalize();
  slideTimer = SLIDE_DURATION;
  isSprinting = false;
  audio.playSlide();
}

function endSlide() {
  if (slideTimer > 0) slideCooldown = SLIDE_COOLDOWN;
  slideTimer = 0;
}

window.addEventListener('blur', () => {
  sprintHeld = false;
});

// --- Grenades & fumigènes ------------------------------------------------------
const grenadeHudChips = {
  frag: document.querySelector('.gren-chip[data-kind="frag"]'),
  smoke: document.querySelector('.gren-chip[data-kind="smoke"]'),
};
let myGrenades = { frag: 0, smoke: 0 };
let lastThrowAt = -Infinity;

function updateGrenadeUI() {
  Object.entries(grenadeHudChips).forEach(([kind, chip]) => {
    if (!chip) return;
    chip.classList.toggle('empty', !(myGrenades[kind] > 0));
    chip.querySelector('.gren-count').textContent = String(myGrenades[kind] || 0);
    const keyEl = chip.querySelector('.inv-key');
    if (keyEl) keyEl.textContent = keyLabel(kind === 'frag' ? keybinds.grenadeFrag : keybinds.grenadeSmoke);
  });
}
updateGrenadeUI();

function handleGrenadesUpdate(data = {}) {
  myGrenades = { frag: data.frag || 0, smoke: data.smoke || 0 };
  updateGrenadeUI();
  if (isShopOpen()) renderShop(getShopState());
}

document.addEventListener('keydown', (e) => {
  if (e.repeat || isDead || isOverlayOpen() || !networkStarted) return;
  const kind = e.code === keybinds.grenadeFrag ? 'frag' : e.code === keybinds.grenadeSmoke ? 'smoke' : null;
  if (!kind || !(myGrenades[kind] > 0)) return;
  const now = performance.now();
  if (now - lastThrowAt < 700) return;
  lastThrowAt = now;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  sendThrowGrenade(kind, { x: dir.x, y: dir.y, z: dir.z });
});

// Boîtes de collision au format du serveur ({minX, maxX, ...}), pour que le vol
// des grenades soit calculé exactement comme là-bas (voir stepGrenade).
let grenadeBoxCache = { boxes: [], count: -1 };
function getGrenadeBoxes() {
  if (grenadeBoxCache.count !== collisionBoxes.length) {
    grenadeBoxCache = {
      count: collisionBoxes.length,
      boxes: collisionBoxes.map((b) => ({
        minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z,
      })),
    };
  }
  return grenadeBoxCache.boxes;
}

const grenadeGeometry = new THREE.SphereGeometry(0.1, 10, 8);
const fragMaterial = new THREE.MeshStandardMaterial({ color: 0x4f6b3a, roughness: 0.6, metalness: 0.3 });
const smokeCanMaterial = new THREE.MeshStandardMaterial({ color: 0xaab4bd, roughness: 0.5, metalness: 0.4 });
const smokeCanGeometry = new THREE.CylinderGeometry(0.06, 0.06, 0.2, 10);
const activeGrenades = new Map(); // id -> { mesh, kind, pos, vel, acc, spin }

function handleGrenadeSpawned({ id, kind, owner, position, velocity }) {
  if (!position || !velocity || activeGrenades.has(id)) return;
  const mesh = new THREE.Mesh(
    kind === 'smoke' ? smokeCanGeometry : grenadeGeometry,
    kind === 'smoke' ? smokeCanMaterial : fragMaterial
  );
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);
  activeGrenades.set(id, {
    mesh,
    kind,
    pos: { x: position.x, y: position.y, z: position.z },
    vel: { x: velocity.x, y: velocity.y, z: velocity.z },
    acc: 0,
    spin: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10),
  });
  if (owner === getMyId()) {
    throwKick = 1;
    audio.playGrenadeThrow();
  }
}

function updateGrenades(delta) {
  if (activeGrenades.size === 0) return;
  const boxes = getGrenadeBoxes();
  activeGrenades.forEach((g) => {
    g.acc += delta;
    let steps = 0;
    while (g.acc >= GRENADE_STEP && steps < 6) {
      stepGrenade(g, boxes, GRENADE_STEP);
      g.acc -= GRENADE_STEP;
      steps += 1;
    }
    if (steps === 6) g.acc = 0;
    g.mesh.position.set(g.pos.x, g.pos.y, g.pos.z);
    g.mesh.rotation.x += g.spin.x * delta;
    g.mesh.rotation.y += g.spin.y * delta;
    g.mesh.rotation.z += g.spin.z * delta;
  });
}

// --- Effets visuels (explosion, fumée) ------------------------------------------
const visualEffects = []; // { update(delta) => boolean (toujours actif ?) }
const fireGeometry = new THREE.SphereGeometry(1, 16, 12);
const sparkGeometry = new THREE.BoxGeometry(0.07, 0.07, 0.07);
// Une seule lumière réutilisée (ajouter/retirer des lumières en pleine partie
// force three.js à recompiler les matériaux et fait saccader l'image).
const blastLight = new THREE.PointLight(0xffa040, 0, 26, 2);
scene.add(blastLight);
let blastLightLevel = 0;
const blastFlashEl = document.getElementById('blast-flash');
let blastFlashLevel = 0;

function spawnExplosion(p) {
  audio.playExplosion(p);

  const fireMaterial = new THREE.MeshBasicMaterial({
    color: 0xffa13a, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const fireball = new THREE.Mesh(fireGeometry, fireMaterial);
  fireball.position.set(p.x, p.y + 0.3, p.z);
  fireball.scale.setScalar(0.6);
  scene.add(fireball);

  blastLight.position.copy(fireball.position);
  blastLightLevel = 1;

  const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true });
  const sparks = [];
  for (let i = 0; i < 24; i++) {
    const mesh = new THREE.Mesh(sparkGeometry, sparkMaterial);
    mesh.position.copy(fireball.position);
    const angle = Math.random() * Math.PI * 2;
    const lift = 0.3 + Math.random() * 0.9;
    const speed = 5 + Math.random() * 9;
    scene.add(mesh);
    sparks.push({ mesh, vx: Math.cos(angle) * speed, vy: lift * speed, vz: Math.sin(angle) * speed });
  }

  const life = 0.75;
  let t = 0;
  visualEffects.push({
    update(delta) {
      t += delta;
      const k = Math.min(1, t / life);
      fireball.scale.setScalar(0.6 + k * 5);
      fireMaterial.opacity = 0.95 * (1 - k) ** 1.6;
      sparkMaterial.opacity = 1 - k;
      sparks.forEach((sp) => {
        sp.vy -= 14 * delta;
        sp.mesh.position.x += sp.vx * delta;
        sp.mesh.position.y = Math.max(0.05, sp.mesh.position.y + sp.vy * delta);
        sp.mesh.position.z += sp.vz * delta;
      });
      if (k < 1) return true;
      scene.remove(fireball);
      fireMaterial.dispose();
      sparks.forEach((sp) => scene.remove(sp.mesh));
      sparkMaterial.dispose();
      return false;
    },
  });

  // Secousse + flash blanc selon la distance
  const dist = camera.position.distanceTo(fireball.position);
  if (dist < 24) shakeCamera(1 - dist / 24);
  if (dist < 11) blastFlashLevel = Math.max(blastFlashLevel, (1 - dist / 11) * 0.85);
}

let smokeTexture = null;
function getSmokeTexture() {
  if (smokeTexture) return smokeTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  const gradient = c.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gradient;
  c.fillRect(0, 0, size, size);
  smokeTexture = new THREE.CanvasTexture(canvas);
  return smokeTexture;
}

function spawnSmoke(p) {
  audio.playSmokePop(p);
  const def = GRENADE_DEFS.smoke;
  const group = new THREE.Group();
  group.position.set(p.x, p.y, p.z);
  scene.add(group);

  const puffs = [];
  for (let i = 0; i < 18; i++) {
    const material = new THREE.SpriteMaterial({
      map: getSmokeTexture(),
      color: new THREE.Color().setHSL(0.58, 0.05, 0.62 + Math.random() * 0.15),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const r = def.radius * 0.5 * Math.cbrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    sprite.position.set(Math.cos(a) * r, 0.7 + Math.random() * def.radius * 0.55, Math.sin(a) * r);
    group.add(sprite);
    puffs.push({
      sprite,
      material,
      target: 4.5 + Math.random() * 3,
      delay: Math.random() * 0.5,
      drift: new THREE.Vector3((Math.random() - 0.5) * 0.12, 0.03 + Math.random() * 0.05, (Math.random() - 0.5) * 0.12),
      spin: (Math.random() - 0.5) * 0.25,
    });
  }

  const life = def.duration;
  let t = 0;
  visualEffects.push({
    update(delta) {
      t += delta;
      const fadeOut = THREE.MathUtils.clamp((life - t) / 3, 0, 1);
      puffs.forEach((pf) => {
        const grow = THREE.MathUtils.clamp((t - pf.delay) / 1.4, 0, 1);
        const eased = 1 - (1 - grow) ** 3;
        const size = pf.target * (0.3 + 0.7 * eased);
        pf.sprite.scale.set(size, size, 1);
        pf.sprite.position.addScaledVector(pf.drift, delta);
        pf.material.rotation += pf.spin * delta;
        pf.material.opacity = 0.92 * grow * fadeOut;
      });
      if (t < life) return true;
      scene.remove(group);
      puffs.forEach((pf) => pf.material.dispose());
      return false;
    },
  });
}

function handleGrenadeExploded({ id, kind, position }) {
  const g = activeGrenades.get(id);
  if (g) {
    scene.remove(g.mesh);
    activeGrenades.delete(id);
  }
  if (!position) return;
  if (kind === 'smoke') spawnSmoke(position);
  else spawnExplosion(position);
}

function updateVisualEffects(delta) {
  for (let i = visualEffects.length - 1; i >= 0; i--) {
    if (!visualEffects[i].update(delta)) visualEffects.splice(i, 1);
  }
  if (blastLightLevel > 0) {
    blastLightLevel = Math.max(0, blastLightLevel - delta * 3);
    blastLight.intensity = 45 * blastLightLevel * blastLightLevel;
  }
  if (blastFlashLevel > 0) {
    blastFlashLevel = Math.max(0, blastFlashLevel - delta * 1.4);
    if (blastFlashEl) blastFlashEl.style.opacity = String(blastFlashLevel);
  }
}

// --- Carte & pings d'équipe -------------------------------------------------------
const pingRaycaster = new THREE.Raycaster();
const pingRayOrigin = new THREE.Vector3();
const pingRayDown = new THREE.Vector3(0, -1, 0);
function sampleGroundY(x, z) {
  pingRayOrigin.set(x, 30, z);
  pingRaycaster.set(pingRayOrigin, pingRayDown);
  pingRaycaster.far = 60;
  const hits = pingRaycaster.intersectObjects(groundObjects, true);
  return hits.length ? hits[0].point.y : 0;
}

// Même définition que isAlly côté serveur (server.js) : même équipe et même
// mode ; en mode Solo (équipes auto-équilibrées) il faut en plus le même groupe.
function isAllyEntry(entry) {
  const myMode = getActiveMode();
  if (entry.mode !== myMode || entry.team !== localTeam) return false;
  return myMode === 'team' || (Boolean(entry.groupId) && entry.groupId === getActiveGroupId());
}

let myBodyColor = getAppearance().bodyColor;
const _selfEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const minimap = createMinimap({
  screenEl: document.getElementById('map-screen'),
  canvasEl: document.getElementById('map-canvas'),
  markerLayerEl: document.getElementById('ping-layer'),
  getBoxes: () => collisionBoxes,
  getSelf: () => {
    _selfEuler.setFromQuaternion(camera.quaternion);
    return { x: camera.position.x, z: camera.position.z, yaw: _selfEuler.y, color: myBodyColor };
  },
  getAllies: () => {
    const allies = [];
    otherPlayers.forEach((entry, id) => {
      if (!entry.mesh.visible || !isAllyEntry(entry)) return;
      allies.push({
        id,
        x: entry.mesh.position.x,
        z: entry.mesh.position.z,
        color: entry.appearance?.bodyColor,
        pseudo: entry.pseudo,
      });
    });
    return allies;
  },
  getGroundY: sampleGroundY,
  onPlacePing: (x, z) => sendPlacePing(x, z),
  onRemovePing: () => sendRemovePing(),
  getMyId,
});

document.getElementById('map-hint').textContent =
  `Clic gauche : ping d'équipe · Clic droit : retirer mon ping · ${keyLabel(keybinds.map)} : fermer`;

document.addEventListener('keydown', (e) => {
  if (e.repeat || !networkStarted) return;
  if (e.code === 'Escape' && gameAdminPanel.isOpen()) {
    gameAdminPanel.close();
    return;
  }
  // Pointeur déjà libéré : Échap n'est pas intercepté par le navigateur, on ferme
  // la carte nous-mêmes et on réaffiche le menu pour pouvoir reprendre la partie.
  if (e.code === 'Escape' && minimap.isOpen()) {
    minimap.close();
    menuEl.style.display = 'flex';
    return;
  }
  if (!matchesAction(e, 'map', keybinds) || isDead || isShopOpen()) return;
  if (minimap.isOpen()) {
    minimap.close();
    controls.lock(); // touche pressée = geste utilisateur direct, le verrouillage est autorisé
  } else {
    minimap.open();
    controls.unlock(); // affiche le curseur pour cliquer sur la carte
  }
});

function handlePingPlaced(data) {
  minimap.addPing(data);
  audio.playPing();
}

// --- Réticule : le cercle montre la dispersion réelle ----------------------------
// Viseur : point central + 4 traits fins. À la hanche l'écart point/traits
// suit la dispersion réelle de l'arme (il s'ouvre quand on court, saute ou tire
// en rafale) ; en visant, les traits se resserrent jusqu'à former un petit plus.
const scopeOverlayEl = document.getElementById('scope-overlay'); // lunette du sniper
let crosshairAim = 0; // 0 = hanche, 1 = visée (lissé pour une transition douce)
function updateCrosshair(delta = 0.016) {
  const weapon = myWeapons[currentSlot];
  const def = weapon ? WEAPON_DEFS[weapon.id] : null;
  const scoped = Boolean(def?.zoomRatio) && isAiming && !isDead && camera.fov < BASE_FOV * 0.6;
  if (scopeOverlayEl) scopeOverlayEl.classList.toggle('show', scoped);
  crosshairEl.style.display = scoped || isDead ? 'none' : '';
  if (scoped || isDead) return;

  crosshairAim += ((isAiming ? 1 : 0) - crosshairAim) * Math.min(1, 18 * delta);
  const focalPx = (window.innerHeight / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const spreadPx = def ? computeCurrentSpread(def) * focalPx : 6;
  const hipGap = THREE.MathUtils.clamp(spreadPx * 0.9, 6, 46);
  // En visée l'écart tombe à 1 px = le rayon du point (2 px) : les traits
  // touchent à peine le point, sans le traverser.
  const DOT_RADIUS_PX = 1;
  const gap = DOT_RADIUS_PX + (hipGap - DOT_RADIUS_PX) * (1 - crosshairAim);
  crosshairEl.style.setProperty('--gap', `${gap.toFixed(2)}px`);
}

// ---------------------------------------------------------------------------
// Multijoueur temps réel — voir le projet séparé mini-warzone-server/
// ---------------------------------------------------------------------------
const EYE_HEIGHT = STAND_EYE_HEIGHT; // référence utilisée pour repositionner les AUTRES joueurs

const otherPlayers = new Map(); // socket id -> { mesh, targetPosition, targetRotationY }

// En mode équipes, la couleur du corps indique l'équipe.
// En solo, le joueur retrouve sa couleur personnelle sauvegardée dans appearance
// (et dans Firestore via profiles.js). Cette couleur personnelle n'est jamais
// remplacée par la couleur temporaire de l'équipe.
const TEAM_MARKER_COLORS = { red: 0xe63946, blue: 0x3a86ff, yellow: 0xffd60a, green: 0x2dc653 };
// Facteur de luminosité du corps selon le nombre de gilets portés (0 à 3) —
// chaque gilet assombrit un peu plus, jusqu'à très sombre à 3 gilets.
const SHIELD_DARKEN_FACTORS = [1, 0.72, 0.48, 0.28];

function getTintedBodyColor(baseColor, steps) {
  const factor = SHIELD_DARKEN_FACTORS[Math.max(0, Math.min(3, steps))];
  return new THREE.Color(baseColor).multiplyScalar(factor);
}

function createPlayerMesh(team, steps = 0, appearance = DEFAULT_APPEARANCE, mode = 'solo') {
  const group = new THREE.Group();
  const bodyColor = mode === 'team'
    ? (TEAM_MARKER_COLORS[team] ?? TEAM_MARKER_COLORS.red)
    : appearance.bodyColor;

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: getTintedBodyColor(bodyColor, steps) })
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

  // Visage : un plan texturé avec l'emoji choisi (fond transparent), collé
  // devant la tête. Pas de vraie bibliothèque de modèles 3D d'emojis pour
  // Three.js (vérifié) — cette technique (canvas -> texture -> plan) est ce
  // que font même les rares packages qui existent, voir appearance.js.
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.32),
    new THREE.MeshBasicMaterial({ map: getEmojiTexture(appearance.face), transparent: true })
  );
  face.position.set(0, 1.66, -0.24);
  face.rotation.y = Math.PI; // la face avant du plan (normale +Z) doit regarder vers -Z (l'avant du perso)
  group.add(face);

  // Pastille d'équipe — repère fixe, indépendant du skin choisi.
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshStandardMaterial({
      color: TEAM_MARKER_COLORS[team] ?? TEAM_MARKER_COLORS.red,
      emissive: TEAM_MARKER_COLORS[team] ?? TEAM_MARKER_COLORS.red,
      emissiveIntensity: 0.6,
    })
  );
  marker.position.y = 2.02;
  group.add(marker);

  return { group, bodyMaterial: body.material };
}

function addOtherPlayer({ id, position, rotationY, team, mode = 'solo', shieldSteps, appearance, pseudo, groupId }) {
  if (otherPlayers.has(id)) return;
  const safeAppearance = sanitizeAppearance(appearance);
  const bodyColor = mode === 'team'
    ? (TEAM_MARKER_COLORS[team] ?? TEAM_MARKER_COLORS.red)
    : safeAppearance.bodyColor;
  const { group: mesh, bodyMaterial } = createPlayerMesh(team, shieldSteps || 0, safeAppearance, mode);
  if (position) {
    mesh.position.set(position.x, position.y - EYE_HEIGHT, position.z);
  }
  mesh.rotation.y = rotationY || 0;
  scene.add(mesh);
  otherPlayers.set(id, {
    mesh,
    bodyMaterial,
    pseudo: pseudo || '',
    groupId: groupId || null,
    appearance: safeAppearance,
    team,
    mode,
    bodyColor,
    targetPosition: mesh.position.clone(),
    targetRotationY: mesh.rotation.y,
  });
}

function updatePlayerShieldSteps({ id, steps }) {
  const entry = otherPlayers.get(id);
  if (!entry) return;
  entry.bodyMaterial.color.copy(getTintedBodyColor(entry.bodyColor, steps));
}

function updateOtherPlayer({ id, position, rotationY }) {
  const entry = otherPlayers.get(id);
  if (!entry || !position) return;
  const footY = position.y - EYE_HEIGHT;

  // Pas des autres joueurs : on cumule la distance qu'ils parcourent AU SOL
  // (pas de variation de hauteur = ni saut ni chute) et on joue un pas,
  // spatialisé à leurs pieds, tous les ~1,9 m.
  const moved = Math.hypot(position.x - entry.targetPosition.x, position.z - entry.targetPosition.z);
  const risen = Math.abs(footY - entry.targetPosition.y);
  if (entry.mesh.visible && moved > 0.01 && moved < 2 && risen < 0.15) {
    entry.stepDistance = (entry.stepDistance || 0) + moved;
    if (entry.stepDistance >= 1.9) {
      entry.stepDistance = 0;
      audio.playFootstep({ at: { x: position.x, y: footY, z: position.z } });
    }
  }

  entry.targetPosition.set(position.x, footY, position.z);
  entry.targetRotationY = rotationY || 0;
}

function removeOtherPlayer(id) {
  const entry = otherPlayers.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  disposeObject3D(entry.mesh);
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
// ---------------------------------------------------------------------------
// Trajectoire d'un tir côté client (purement visuelle : le serveur reste seul
// juge de ce qui touche). On cherche ce que la balle rencontre en premier :
// un mur/le sol (boîtes de collision, les mêmes que celles du serveur) ou un
// joueur (approximé par 3 sphères : jambes, torse, tête).
// ---------------------------------------------------------------------------
const shotRaycaster = new THREE.Raycaster();
const BODY_SPHERES = [[0.45, 0.38], [1.1, 0.4], [1.65, 0.27]]; // [hauteur depuis les pieds, rayon]
const _oc = new THREE.Vector3();
function traceStraight(origin, dir, maxDist = DEFAULT_RANGE, ignoreId = null) {
  const result = { distance: maxDist, kind: null, point: new THREE.Vector3(), normal: new THREE.Vector3() };
  if (collisionMeshes.length > 0) {
    shotRaycaster.set(origin, dir);
    shotRaycaster.near = 0;
    shotRaycaster.far = maxDist;
    const hits = shotRaycaster.intersectObjects(collisionMeshes, true);
    if (hits.length > 0) {
      const hit = hits[0];
      result.distance = hit.distance;
      result.kind = 'surface';
      result.point.copy(hit.point);
      if (hit.face) result.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      else result.normal.copy(dir).negate();
    }
  }
  otherPlayers.forEach(({ mesh }, id) => {
    if (id === ignoreId || !mesh.visible) return;
    BODY_SPHERES.forEach(([height, radius]) => {
      _oc.set(mesh.position.x - origin.x, mesh.position.y + height - origin.y, mesh.position.z - origin.z);
      const along = _oc.dot(dir);
      if (along <= 0) return;
      const miss2 = _oc.lengthSq() - along * along;
      if (miss2 > radius * radius) return;
      const t = along - Math.sqrt(radius * radius - miss2);
      if (t >= 0 && t < result.distance) {
        result.distance = t;
        result.kind = 'body';
        result.point.copy(origin).addScaledVector(dir, t);
        result.normal.copy(dir).negate();
      }
    });
  });
  return result;
}

// Trajectoire complète d'un tir. Sans balistique : une ligne droite. Avec
// (sniper) : la balle suit la courbe de bulletOffsetY, testée par segments de
// 10 m (comme le serveur). Renvoie { distance, kind, point, normal } où distance
// est mesurée le long de la visée, et `path` : points à relier pour le traceur.
const _segFrom = new THREE.Vector3();
const _segTo = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const TRACER_PATH_STEP = 40; // le traceur courbe est dessiné par segments de 40 m
function traceShot(origin, dir, maxDist = DEFAULT_RANGE, ignoreId = null, ballistics = null) {
  if (!ballistics) {
    const straight = traceStraight(origin, dir, maxDist, ignoreId);
    straight.path = null;
    return straight;
  }
  let s0 = 0;
  _segFrom.copy(origin);
  const result = { distance: maxDist, kind: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), path: null };
  while (s0 < maxDist) {
    const s1 = Math.min(maxDist, s0 + BALLISTIC_STEP);
    _segTo.set(origin.x + dir.x * s1, origin.y + dir.y * s1 + bulletOffsetY(ballistics, s1), origin.z + dir.z * s1);
    _segDir.copy(_segTo).sub(_segFrom);
    const len = _segDir.length();
    if (len < 1e-6) break;
    _segDir.multiplyScalar(1 / len);
    const hit = traceStraight(_segFrom, _segDir, len, ignoreId);
    if (hit.kind) {
      result.distance = s0 + hit.distance;
      result.kind = hit.kind;
      result.point.copy(hit.point);
      result.normal.copy(hit.normal);
      break;
    }
    _segFrom.copy(_segTo);
    s0 = s1;
  }
  // points du traceur : tous les 40 m le long de la courbe, jusqu'à l'arrivée
  const end = result.kind ? result.point.clone() : new THREE.Vector3(origin.x + dir.x * result.distance, origin.y + dir.y * result.distance + bulletOffsetY(ballistics, result.distance), origin.z + dir.z * result.distance);
  const path = [];
  for (let s = TRACER_PATH_STEP; s < result.distance - 5; s += TRACER_PATH_STEP) {
    path.push(new THREE.Vector3(origin.x + dir.x * s, origin.y + dir.y * s + bulletOffsetY(ballistics, s), origin.z + dir.z * s));
  }
  path.push(end);
  result.path = path;
  return result;
}

// Dessine le traceur d'un tir : depuis `from` (bouche) le long de `hit.path`
// (courbe du sniper) ou en ligne droite jusqu'à `fallbackEnd`.
function drawTracer(from, hit, fallbackEnd) {
  if (hit.path) {
    let a = from;
    hit.path.forEach((b) => {
      fx.tracer(a, b);
      a = b;
    });
  } else {
    fx.tracer(from, fallbackEnd);
  }
}

// Bouche du canon en main (coordonnées monde) : d'où partent les traceurs
const _muzzleLocal = new THREE.Vector3();
function getMuzzleWorldPosition(out, weaponId) {
  weaponGroup.updateWorldMatrix(true, false);
  return weaponGroup.localToWorld(out.set(0, 0.02, MUZZLE_Z[weaponId] ?? -0.5));
}

// Douilles éjectées : taille, couleur et délai (pompe/culasse manœuvrés après le tir)
const SHELL_SPECS = {
  pistol: { size: 0.028, thickness: 0.0085, color: 0xd4a64a, delay: 0 },
  smg: { size: 0.026, thickness: 0.008, color: 0xd4a64a, delay: 0 },
  rifle: { size: 0.045, thickness: 0.011, color: 0xd4a64a, delay: 0 },
  shotgun: { size: 0.06, thickness: 0.0125, color: 0xc8372d, delay: 380 },
  sniper: { size: 0.06, thickness: 0.012, color: 0xd4a64a, delay: 650 },
};
const _shellPos = new THREE.Vector3();
const _shellVel = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
function ejectShellFor(weaponId) {
  const spec = SHELL_SPECS[weaponId];
  if (!spec) return;
  const eject = () => {
    if (isDead) return;
    weaponGroup.updateWorldMatrix(true, false);
    weaponGroup.localToWorld(_shellPos.set(0.045, 0.035, -0.12));
    camera.updateMatrixWorld();
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    camera.getWorldDirection(_camFwd);
    _shellVel
      .copy(_camRight).multiplyScalar(1.5 + Math.random() * 1.3)
      .addScaledVector(_camUp, 1.1 + Math.random() * 1.1)
      .addScaledVector(_camFwd, -0.2 + Math.random() * 0.5);
    fx.ejectShell({ position: _shellPos, velocity: _shellVel, size: spec.size, thickness: spec.thickness, color: spec.color });
  };
  if (spec.delay > 0) setTimeout(eject, spec.delay);
  else eject();
}

let lastShotAt = -Infinity;

let lastDryFireClock = -Infinity;
const _shotEnd = new THREE.Vector3();
function tryShoot(now) {
  if (isDead || isOverlayOpen()) return;
  const equipped = myWeapons[currentSlot];
  if (!equipped || isReloading) return;
  const weapon = WEAPONS[currentWeaponIndex];
  const def = WEAPON_DEFS[equipped.id];
  if (now - lastShotAt < weapon.cooldown) return;

  // Chargeur vide : clic à vide, puis rechargement automatique
  if ((equipped.ammo ?? def.magSize) <= 0) {
    if (now - lastDryFireClock > 0.4) {
      lastDryFireClock = now;
      audio.playDryFire();
    }
    startReload();
    return;
  }

  lastShotAt = now;
  if (!adminState.infiniteAmmo) equipped.ammo = (equipped.ammo ?? def.magSize) - 1; // mode admin : le chargeur ne baisse pas
  lastLocalShotAt = performance.now();

  const origin = camera.position.clone();
  const base = new THREE.Vector3();
  camera.getWorldDirection(base);

  // Un plomb par `pellets` (8 pour le fusil à pompe), chacun dévié au hasard
  // dans le disque de dispersion de l'état actuel (mouvement, saut, visée,
  // rafale). Le serveur plafonne cette dispersion — voir 'shoot' dans server.js.
  const spread = computeCurrentSpread(def);
  const pelletDirs = [];
  getMuzzleWorldPosition(_muzzleLocal, equipped.id);
  for (let i = 0; i < def.pellets; i++) {
    const dir = perturbDirection(base, spread, new THREE.Vector3());
    pelletDirs.push({ x: dir.x, y: dir.y, z: dir.z });
    const hit = traceShot(origin, dir, def.range ?? DEFAULT_RANGE, null, def.ballistics);
    _shotEnd.copy(origin).addScaledVector(dir, hit.distance);
    drawTracer(_muzzleLocal, hit, _shotEnd); // traceur fin, depuis la bouche du canon
    if (hit.kind) fx.impact({ point: hit.point, normal: hit.normal, kind: hit.kind === 'body' ? 'body' : 'surface', light: def.pellets > 1 });
  }
  showMuzzleFlash(equipped.id);
  ejectShellFor(equipped.id);
  audio.playShot(weapon.id);
  // On envoie le SLOT actif (0/1), jamais l'id d'arme ni les dégâts : le
  // serveur retrouve lui-même l'arme + la rareté réellement équipées dans
  // ce slot (voir server.js) — impossible de tricher en prétendant avoir
  // une meilleure arme/rareté que celle réellement achetée.
  sendShoot(
    { x: origin.x, y: origin.y, z: origin.z },
    { x: base.x, y: base.y, z: base.z },
    currentSlot,
    pelletDirs
  );
  recoilKick = 1; // déclenche l'animation de recul de l'arme, gérée dans animate()
  bloom = Math.min(BLOOM_MAX, bloom + BLOOM_PER_SHOT);
  applyCameraRecoil(def);
  updateAmmoUI();
  if (equipped.ammo <= 0) setTimeout(startReload, 220);
}

let localTeam = null;
const teamLabelEl = document.getElementById('team-label');

function handleTeamAssigned({ team, spawn }) {
  localTeam = team;
  if (spawn) {
    camera.position.set(spawn.x, spawn.y, spawn.z);
  }
  if (teamLabelEl) {
    const teamNames = { red: 'Rouge', blue: 'Bleue', yellow: 'Jaune', green: 'Verte' };
    teamLabelEl.textContent = `Équipe ${teamNames[team] || 'Rouge'}`;
    teamLabelEl.classList.remove('team-red', 'team-blue', 'team-yellow', 'team-green');
    teamLabelEl.classList.add(`team-${teamNames[team] ? team : 'red'}`);
  }
}

async function startNetwork() {
  if (networkStarted) return;
  networkStarted = true;
  keybinds = getKeybinds(); // au cas où elles ont été changées depuis le lobby avant de rejouer
  applySettings(); // idem pour sensibilité, champ de vision, volume et bloom
  myBodyColor = getAppearance().bodyColor; // couleur de TON ping d'équipe
  updateGrenadeUI(); // touches de lancer peut-être changées dans Paramètres
  document.getElementById('map-hint').textContent =
    `Clic gauche : ping d'équipe · Clic droit : retirer mon ping · ${keyLabel(keybinds.map)} : fermer`;
  updateAmmoUI();

  const pseudo = auth.currentUser?.displayName || 'Joueur';
  const groupId = getActiveGroupId();
  let idToken = null;
  try { idToken = await auth.currentUser?.getIdToken(); }
  catch (error) { console.error('[auth] Token Firebase indisponible :', error); }
  if (!idToken) {
    networkStarted = false;
    loadingEl.style.display = 'block';
    loadingEl.textContent = 'Connexion Firebase impossible. Reconnecte-toi.';
    return;
  }

  connectToServer(pseudo, getAppearance(), groupId, getActiveMode(), getActiveTeam(), {
    onTeamAssigned: handleTeamAssigned,
    onPlayerJoined: addOtherPlayer,
    onPlayerMoved: updateOtherPlayer,
    onPlayerShoot: ({ id, origin, direction, maxLength, weaponId, shots }) => {
      if (!origin) return;
      const list = Array.isArray(shots) && shots.length > 0 ? shots : [{ direction, maxLength }];
      const from = new THREE.Vector3(origin.x, origin.y, origin.z);
      let flashed = false;
      list.forEach((shot) => {
        if (!shot.direction) return;
        const dir = new THREE.Vector3(shot.direction.x, shot.direction.y, shot.direction.z).normalize();
        // Bouche du canon estimée : devant et un peu sous les yeux du tireur
        const muzzle = from.clone().addScaledVector(dir, 0.8);
        muzzle.y -= 0.2;
        const shooterDef = WEAPON_DEFS[weaponId];
        const range = shooterDef?.range ?? DEFAULT_RANGE;
        const reach = Number.isFinite(shot.maxLength) ? Math.min(shot.maxLength + 0.05, range) : 40;
        const hit = traceShot(from, dir, reach, id, shooterDef?.ballistics ?? null);
        _shotEnd.copy(from).addScaledVector(dir, hit.distance);
        drawTracer(muzzle, hit, _shotEnd);
        if (hit.kind) fx.impact({ point: hit.point, normal: hit.normal, kind: hit.kind === 'body' ? 'body' : 'surface', light: list.length > 1 });
        if (!flashed) {
          fx.worldMuzzleFlash(muzzle, weaponId === 'shotgun' ? 0.8 : 0.5);
          flashed = true;
        }
      });
      audio.playShot(weaponId, origin); // spatialisé : on entend d'où ça tire
    },
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
    onHitConfirmed: handleHitConfirmed,
    onDamageTaken: handleDamageTaken,
    onYourShield: handleShieldUpdate,
    onPlayerShieldSteps: updatePlayerShieldSteps,
    onYourMoney: handleMoneyUpdate,
    onYourVestCount: handleVestCountUpdate,
    onYourWeapons: handleWeaponsUpdate,
    onYourAbilities: handleAbilitiesUpdate,
    onCurrentVests: handleCurrentVests,
    onVestSpawned: addGroundVest,
    onVestRemoved: handleVestRemoved,
    onCurrentWeaponPickups: handleCurrentWeaponPickups,
    onWeaponPickupSpawned: addGroundWeaponPickup,
    onWeaponPickupRemoved: handleWeaponPickupRemoved,
    onKillFeed: handleKillFeed,
    onScoreboard: (list) => scoreboard.setScores(list),
    onYourAmmo: handleAmmoUpdate,
    onYourGrenades: handleGrenadesUpdate,
    onGrenadeSpawned: handleGrenadeSpawned,
    onGrenadeExploded: handleGrenadeExploded,
    onPingPlaced: handlePingPlaced,
    onPingRemoved: ({ senderId }) => minimap.removePing(senderId),
    onAdminPlayerList: (data) => gameAdminPanel.setPlayers(data),
    onAdminActionResult: (result) => gameAdminPanel.showResult(result),
    onAdminJournal: (entries) => gameAdminPanel.setJournal(entries),
    onAdminState: applyAdminState,
    onAdminTeleport: handleAdminTeleport,
    onAdminKicked: handleAdminKicked,
    onAdminAnnounce: ({ text, from, private: isPrivate }) => hudFx.showAnnouncement(text, from, isPrivate),
    onAdminTime: ({ phase }) => ambiance.setPhaseOverride(phase), // null = retour à l'horloge normale
    onPlayerHidden: ({ id, hidden }) => setOtherPlayerVisible(id, !hidden),
  }, () => auth.currentUser?.getIdToken() ?? idToken); // jeton frais à chaque reconnexion (il expire au bout d'une heure)
}

// ---------------------------------------------------------------------------
// Boucle de rendu
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let timeSinceLastMoveSent = 0;
const MOVE_SEND_INTERVAL = 0.033; // ~30 envois par seconde (au lieu de 20) — voir HIT_REWIND_MS côté serveur
let bobTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);

  // Course (endurance) et glissade : mis à jour AVANT le calcul de vitesse
  slideCooldown = Math.max(0, slideCooldown - delta);
  updateSprintState(delta);
  bloom = Math.max(0, bloom - BLOOM_DECAY_PER_SEC * delta);

  // Vitesse effective : ralentie en visée, encore plus accroupi, accélérée en courant
  const speedMultiplier = isCrouching ? 0.5 : isAiming ? 0.65 : isSprinting ? SPRINT_MULT : 1;
  const speed = BASE_SPEED * speedMultiplier * adminState.speed;

  // Friction
  velocity.x -= velocity.x * 10 * delta;
  velocity.z -= velocity.z * 10 * delta;

  direction.z = Number(move.forward) - Number(move.backward);
  direction.x = Number(move.right) - Number(move.left);
  direction.normalize();

  const isSliding = slideTimer > 0;
  const isMoving = !isDead && !isOverlayOpen() && !adminState.frozen && (move.forward || move.backward || move.left || move.right);
  if (!isDead && !isOverlayOpen()) {
    const prevX = camera.position.x;
    const prevZ = camera.position.z;
    if (adminState.frozen) {
      // Immobilisé par un admin : on peut regarder et tirer, pas bouger
      velocity.x = 0;
      velocity.z = 0;
      if (isSliding) endSlide();
    } else if (isSliding) {
      // Glissade : élan dans une direction figée, qui ralentit jusqu'à la fin
      const t = 1 - slideTimer / SLIDE_DURATION;
      const slideSpeed = THREE.MathUtils.lerp(SLIDE_SPEED_START, SLIDE_SPEED_END, t);
      camera.position.x += slideDir.x * slideSpeed * delta;
      camera.position.z += slideDir.z * slideSpeed * delta;
      velocity.x = 0;
      velocity.z = 0;
      resolveHorizontalCollisions(prevX, prevZ);
      slideTimer -= delta;
      if (slideTimer <= 0) endSlide();
    } else {
      if (move.forward || move.backward) velocity.z -= direction.z * speed * 10 * delta;
      if (move.left || move.right) velocity.x -= direction.x * speed * 10 * delta;

      controls.moveRight(-velocity.x * delta);
      controls.moveForward(-velocity.z * delta);
      resolveHorizontalCollisions(prevX, prevZ);
    }
  }

  // --- Accroupi : on lisse la hauteur d'yeux cible plutôt que de la changer d'un coup
  const targetEyeHeight = slideTimer > 0 ? SLIDE_EYE_HEIGHT : isCrouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
  currentEyeHeight += (targetEyeHeight - currentEyeHeight) * Math.min(1, 10 * delta);

  // --- Gravité / saut : on calcule le sol sous les pieds, puis on applique
  // soit un collage au sol (si posé), soit la gravité (si en l'air).
  // On coupe la gravité pendant l'écran de mort pour ne pas glisser vers le
  // dernier point de vue au sol pendant les 3s d'attente.
  if (!isDead) {
    const groundY = getGroundY(camera.position.x, camera.position.z);
    const standingY = groundY + currentEyeHeight;

    if (adminState.fly) {
      // Mode vol : pas de gravité, saut = monter, accroupi = descendre
      const climb = (jumpHeld ? 1 : 0) - (isCrouching ? 1 : 0);
      verticalVelocity = 0;
      camera.position.y = Math.max(standingY, camera.position.y + climb * 9 * adminState.speed * delta);
    } else {
      verticalVelocity -= GRAVITY * delta;
      camera.position.y += verticalVelocity * delta;
    }

    if (adminState.fly && camera.position.y > standingY + 0.05) {
      isGrounded = false;
    } else if (camera.position.y <= standingY) {
      const fallSpeed = -verticalVelocity; // vitesse d'impact, avant remise à zéro
      camera.position.y = standingY;
      verticalVelocity = 0;
      // isGrounded vaut encore la valeur de la frame précédente : on n'a donc un
      // atterrissage que si on était en l'air juste avant.
      if (!isGrounded && fallSpeed > 4) audio.playLand(Math.min(1, fallSpeed / 14));
      isGrounded = true;
    } else {
      isGrounded = false;
    }
  }

  // --- Sons : pas (un tous les STEP_LENGTH mètres parcourus au sol) et oreille
  // du joueur (position + direction du regard) pour les sons spatialisés.
  const stepDelta = Math.hypot(camera.position.x - prevStepX, camera.position.z - prevStepZ);
  prevStepX = camera.position.x;
  prevStepZ = camera.position.z;
  if (!isDead && isGrounded && isMoving && !isSliding && stepDelta < 1.5) {
    // (stepDelta >= 1.5 = téléportation : respawn, pas un vrai déplacement)
    stepDistance += stepDelta;
    const stepLength = isCrouching ? CROUCH_STEP_LENGTH : isSprinting ? STEP_LENGTH * 1.2 : STEP_LENGTH;
    if (stepDistance >= stepLength) {
      stepDistance = 0;
      audio.playFootstep({ crouching: isCrouching, sprinting: isSprinting });
    }
  }
  camera.getWorldDirection(listenerDir);
  audio.setListener(camera.position.x, camera.position.y, camera.position.z, listenerDir.x, listenerDir.z);

  // --- Visée : zoom du champ de vision + arme recentrée
  const targetFov = isDead ? BASE_FOV : isAiming ? getAimFov() : isSprinting ? BASE_FOV + 6 : BASE_FOV;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * delta);
    camera.updateProjectionMatrix();
  }
  // Plus on zoome, plus la souris ralentit (visée précise à la lunette)
  controls.pointerSpeed = baseSensitivity * Math.max(0.25, camera.fov / BASE_FOV);

  // Fin du rechargement local (le serveur confirme avec 'your-ammo')
  if (isReloading && performance.now() - reloadStartedAt >= reloadDurationMs) finishReloadLocally();
  if (reloadFillEl) {
    reloadFillEl.style.width = isReloading
      ? `${Math.min(100, ((performance.now() - reloadStartedAt) / reloadDurationMs) * 100)}%`
      : '0%';
  }

  // Animations de l'arme : baissée en courant, inclinée pendant un rechargement,
  // abaissée brièvement au lancer d'une grenade
  sprintBlend += ((isSprinting ? 1 : 0) - sprintBlend) * Math.min(1, 8 * delta);
  reloadBlend += ((isReloading ? Math.sin(Math.min(1, (performance.now() - reloadStartedAt) / reloadDurationMs) * Math.PI) : 0) - reloadBlend) * Math.min(1, 14 * delta);
  throwKick = Math.max(0, throwKick - delta * 3);
  _weaponTarget.copy(isAiming && !isSprinting ? WEAPON_AIM_POSITION : WEAPON_REST_POSITION);
  _weaponTarget.x -= sprintBlend * 0.08;
  _weaponTarget.y += -sprintBlend * 0.1 - reloadBlend * 0.22 - throwKick * 0.25;
  _weaponTarget.z += sprintBlend * 0.05 + reloadBlend * 0.06;
  weaponGroup.position.lerp(_weaponTarget, Math.min(1, 12 * delta));

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
  weaponGroup.rotation.x = -recoilKick * 0.35 - sprintBlend * 0.45 + reloadBlend * 0.5;
  weaponGroup.rotation.z = sprintBlend * 0.25 - reloadBlend * 0.45;
  weaponGroup.position.z += recoilKick * 0.06;
  // En visant à la lunette (sniper), on ne voit plus l'arme : on regarde dans la lunette
  const hasWeapon = Boolean(myWeapons[currentSlot]);
  const scopedNow = isAiming && Boolean(WEAPON_DEFS[myWeapons[currentSlot]?.id]?.zoomRatio) && camera.fov < BASE_FOV * 0.6;
  weaponGroup.visible = hasWeapon && !isDead && !scopedNow;
  updateCrosshair(delta);

  // Autres joueurs : on lisse leur déplacement plutôt que de les téléporter
  // à chaque message reçu du serveur (ça "saccaderait" sinon) — mais pas
  // trop lentement non plus : plus ce lissage traîne, plus on les VOIT en
  // retard sur leur vraie position, ce qui fait viser (et donc tirer) un peu
  // derrière une cible qui bouge vite. Facteur dépendant de delta (comme le
  // recul de l'arme un peu plus haut) plutôt qu'un taux fixe par frame, pour
  // rattraper la cible en un temps à peu près constant quel que soit le
  // framerate. Le serveur compense malgré tout le retard réseau restant côté
  // tir (voir HIT_REWIND_MS dans server.js) — ce réglage-ci ne joue que sur
  // le confort visuel, pas sur l'équité des tirs.
  otherPlayers.forEach(({ mesh, targetPosition, targetRotationY }) => {
    const followFactor = Math.min(1, 25 * delta);
    mesh.position.lerp(targetPosition, followFactor);
    mesh.rotation.y += (targetRotationY - mesh.rotation.y) * followFactor;
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

  // Prompt "E — Ramasser [arme]" : visible seulement à portée d'une arme au
  // sol, mort et boutique ouverte exclues (comme pour la boutique).
  if (pickupPromptEl) {
    const nearbyId = !isDead && !isOverlayOpen() ? findClosestGroundWeapon() : null;
    if (nearbyId) {
      const entry = groundWeaponPickups.get(nearbyId);
      pickupPromptEl.textContent = `${keyLabel(keybinds.pickupWeapon)} — Ramasser ${weaponLabel(entry.weaponId)}`;
      pickupPromptEl.style.display = 'block';
    } else {
      pickupPromptEl.style.display = 'none';
    }
  }

  // Grenades en vol, explosions/fumées, marqueurs de ping et carte ouverte
  updateGrenades(delta);
  updateVisualEffects(delta);
  minimap.updateMarkers(camera);
  minimap.draw();

  ambiance.update(delta, clock.elapsedTime); // ciel, lumières, brume, ombres : après le déplacement de la caméra
  fx.update(delta);
  updateGroundLoot(performance.now());
  hudFx.update(performance.now(), localHp, MAX_HP, isDead, delta);
  composer.render();
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Rappel : murs et caisses bloquent aussi bien les déplacements que les tirs
// (traceShot côté client pour l'affichage, nearestObstacleDistance /
// traceShotPath dans server.js pour les vrais dégâts). Les boîtes de collision
// côté client et côté serveur doivent rester identiques (map-colliders.glb).

// Outils de test : uniquement avec `npm run dev` (retirés du build de production).
// Dans la console du navigateur : __mw.fx.impact(...), __mw.hudFx.showDamageNumber(...), etc.
if (import.meta.env.DEV) {
  window.__mw = {
    fx, hudFx, ambiance, camera, scene, renderer, THREE,
    otherPlayers, collisionMeshes, groundVestMeshes, groundWeaponPickups,
    showMuzzleFlash, ejectShellFor, traceShot, drawTracer, addGroundVest, addGroundWeaponPickup,
    collidesAt, minimap, setEyeHeight: (v) => { currentEyeHeight = v; },
    setNetworkStarted: (v) => { networkStarted = v; },
    applyAdminState, handleAdminTeleport, adminState, gameAdminPanel,
  };
}
