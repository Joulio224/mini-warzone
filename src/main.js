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
  sendCollectVest,
  sendUseVest,
  sendCollectWeapon,
  sendBuyItem,
} from './network.js';
import { initShop, openShop, closeShop, isShopOpen, renderShop, rarityColor } from './shop.js';
import { getAppearance, getEmojiTexture, sanitizeAppearance, DEFAULT_APPEARANCE } from './appearance.js';
// Toutes les données de la map qui ne sont pas de la géométrie visuelle pure
// (boîtes de collision, spawns d'équipe, points d'apparition des armes/gilets,
// lumières d'ambiance) — doit rester identique à
// mini-warzone-server/map-data.json. La géométrie visible, elle, vient de
// public/assets/map.glb (voir plus bas).
import mapData from './map-data.json';

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
const collisionBoxes = [];

// ---------------------------------------------------------------------------
// Map : chargée depuis un fichier .glb (public/assets/map.glb) — plus aucune
// géométrie de salle codée en dur ici. Tout ce que le rendu 3D ne peut pas
// déduire tout seul (boîtes de collision, spawns d'équipe, points
// d'apparition des armes/gilets, lumières d'ambiance) vient de mapData
// (voir l'import en haut du fichier).
// ---------------------------------------------------------------------------
const loadingEl = document.getElementById('loading');
const playButton = document.getElementById('play-button');

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
    scene.add(gltf.scene);
    scene.remove(fallbackGround);

    // Sol pour les collisions verticales (saut/gravité, marche sur le
    // balcon/les rampes) : on ne raycaste QUE les meshes "marchables" (sol,
    // rampes — repérés par leur nom), pas toute la map (murs, garde-corps,
    // décor...) à chaque frame. Sur une map simple ça ne change rien, mais
    // ça évite un vrai ralentissement le jour où ta map Fusion 360 sera
    // beaucoup plus détaillée que ce placeholder en boîtes. Nomme tes
    // surfaces marchables avec "floor" ou "ramp" quelque part dans leur nom
    // (dans Fusion 360/Blender) pour que ça continue à marcher ; si aucun
    // mesh ne correspond, on retombe sur la map entière (comportement
    // d'avant, plus lent mais jamais cassé).
    const walkableMeshes = [];
    gltf.scene.traverse((child) => {
      if (child.isMesh && /floor|ramp/i.test(child.name)) walkableMeshes.push(child);
    });
    groundObjects.length = 0;
    groundObjects.push(...(walkableMeshes.length ? walkableMeshes : [gltf.scene]));

    // Boîtes de collision horizontale (murs, caisses), voir mapData.colliders.
    // Le type "floor" (sol du balcon) ne sert que côté serveur (blocage des
    // tirs à hauteur du balcon) — côté client on marche dessus via le
    // raycast ci-dessus, il ne faut surtout pas le traiter comme un mur.
    mapData.colliders
      .filter((c) => c.type === 'wall')
      .forEach((c) => {
        collisionBoxes.push(
          new THREE.Box3(new THREE.Vector3(c.minX, c.minY, c.minZ), new THREE.Vector3(c.maxX, c.maxY, c.maxZ))
        );
      });

    // Lumières d'ambiance (voir mapData.lights) — purement décoratives,
    // aucune incidence sur le gameplay.
    (mapData.lights || []).forEach((l) => {
      const light = new THREE.PointLight(l.color, l.intensity, l.distance, l.decay);
      light.position.set(l.x, l.y, l.z);
      scene.add(light);
    });

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
const quitButton = document.getElementById('quit-button');

playButton.addEventListener('click', () => {
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
// Gilets pare-balle au sol — réapparaissent à des points fixes après un
// délai. Ramassés, ils remplissent le bouclier par paliers de SHIELD_PER_VEST.
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
// PLACEHOLDER TEMPORAIRE : pas encore de magasin physique dans la salle 3D,
// donc on ouvre/ferme la boutique avec la touche B en attendant. Le jour où
// tu places un point d'interaction "magasin" (une position dans map-data.json,
// ou un objet nommé dans le .glb repéré via gltf.scene.getObjectByName), il
// suffira de remplacer ce raccourci par un appel à openShop()/closeShop()
// depuis cette interaction de proximité (comme pour le ramassage au sol
// ci-dessus) — tout le reste (catalogue, achats, UI, sécurité serveur) est
// déjà prêt et n'a pas besoin de changer.
initShop({
  onBuy: (itemId) => sendBuyItem(itemId),
  onClose: () => controls.lock(),
});

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyB' || isDead || !networkStarted) return;
  if (isShopOpen()) {
    closeShop();
    controls.lock(); // touche B pressée = geste utilisateur direct, le verrouillage du pointeur est autorisé
  } else {
    controls.unlock(); // affiche le curseur pour pouvoir cliquer sur les boutons de la boutique
    openShop(getShopState());
  }
});

// ---------------------------------------------------------------------------
// Multijoueur temps réel — voir le projet séparé mini-warzone-server/
// ---------------------------------------------------------------------------
const EYE_HEIGHT = STAND_EYE_HEIGHT; // référence utilisée pour repositionner les AUTRES joueurs

const otherPlayers = new Map(); // socket id -> { mesh, targetPosition, targetRotationY }

// La couleur du corps est maintenant 100% libre (choisie par le joueur, voir
// appearance.js) — ce n'est donc plus elle qui indique l'équipe. À la place,
// une petite pastille colorée flotte au-dessus de la tête, toujours dans la
// couleur de l'équipe, quel que soit le skin choisi.
const TEAM_MARKER_COLORS = { red: 0xe63946, blue: 0x3a86ff };
// Facteur de luminosité du corps selon le nombre de gilets portés (0 à 3) —
// chaque gilet assombrit un peu plus, jusqu'à très sombre à 3 gilets.
const SHIELD_DARKEN_FACTORS = [1, 0.72, 0.48, 0.28];

function getTintedBodyColor(baseColor, steps) {
  const factor = SHIELD_DARKEN_FACTORS[Math.max(0, Math.min(3, steps))];
  return new THREE.Color(baseColor).multiplyScalar(factor);
}

function createPlayerMesh(team, steps = 0, appearance = DEFAULT_APPEARANCE) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: getTintedBodyColor(appearance.bodyColor, steps) })
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

function addOtherPlayer({ id, position, rotationY, team, shieldSteps, appearance }) {
  if (otherPlayers.has(id)) return;
  const safeAppearance = sanitizeAppearance(appearance);
  const { group: mesh, bodyMaterial } = createPlayerMesh(team, shieldSteps || 0, safeAppearance);
  if (position) {
    mesh.position.set(position.x, position.y - EYE_HEIGHT, position.z);
  }
  mesh.rotation.y = rotationY || 0;
  scene.add(mesh);
  otherPlayers.set(id, {
    mesh,
    bodyMaterial,
    team,
    bodyColor: safeAppearance.bodyColor,
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

  connectToServer(pseudo, getAppearance(), {
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
    onHitConfirmed: showHitMarker,
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
