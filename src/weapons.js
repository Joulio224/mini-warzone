// ---------------------------------------------------------------------------
// Armes, grenades et dispersion — source de vérité CÔTÉ CLIENT.
//
// Doit rester identique à WEAPON_DEFS / GRENADE_DEFS / SPREAD_* dans
// mini-warzone-server/server.js : le serveur reste seul juge des dégâts, des
// munitions et de la cadence, ce fichier ne sert qu'à l'affichage, aux
// prédictions locales (munitions, rechargement) et à générer la dispersion
// des tirs que le serveur vérifie ensuite (plafond de dispersion).
// ---------------------------------------------------------------------------

// spread.hip / spread.aim : rayon (sans unité, ~ tangente de l'angle) du disque
// de dispersion autour de la visée, hanche / en visant.
// recoil : coup de caméra vers le haut à chaque tir (radians).
// zoomRatio : fraction du champ de vision en visée (sinon AIM_FOV_RATIO).
export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol',
    name: 'Pistolet',
    baseDamage: 18,
    cooldown: 0.35,
    autoFire: false,
    magSize: 12,
    reloadTime: 1.2,
    pellets: 1,
    spread: { hip: 0.006, aim: 0.002 },
    recoil: 0.012,
    basePrice: 90,
    slot: 0,
    color: 0x2b2b2b,
  },
  smg: {
    id: 'smg',
    name: 'Mitraillette',
    baseDamage: 10,
    cooldown: 0.09,
    autoFire: true,
    magSize: 30,
    reloadTime: 1.7,
    pellets: 1,
    spread: { hip: 0.022, aim: 0.009 },
    recoil: 0.006,
    basePrice: 80,
    slot: 1,
    color: 0x333d47,
  },
  rifle: {
    id: 'rifle',
    name: 'Fusil',
    baseDamage: 16,
    cooldown: 0.18,
    autoFire: true,
    magSize: 25,
    reloadTime: 2.0,
    pellets: 1,
    spread: { hip: 0.014, aim: 0.003 },
    recoil: 0.009,
    basePrice: 110,
    slot: 1,
    color: 0x3a3226,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Fusil à pompe',
    baseDamage: 9, // PAR plomb
    cooldown: 0.85,
    autoFire: false,
    magSize: 6,
    reloadTime: 2.4,
    pellets: 8,
    spread: { hip: 0.055, aim: 0.04 },
    recoil: 0.035,
    basePrice: 120,
    // Les dégâts d'un plomb baissent avec la distance : 100 % jusqu'à `start`
    // mètres, puis linéairement jusqu'à `min` (fraction) à `end` mètres.
    falloff: { start: 7, end: 28, min: 0.25 },
    slot: 1,
    color: 0x4a3b2a,
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    baseDamage: 70,
    cooldown: 1.3,
    autoFire: false,
    magSize: 5,
    reloadTime: 2.8,
    pellets: 1,
    spread: { hip: 0.06, aim: 0 },
    recoil: 0.03,
    basePrice: 150,
    zoomRatio: 0.25, // lunette : le champ de vision tombe à 25 % de la normale
    slot: 1,
    color: 0x24342a,
  },
};

// Ordre = index dans WEAPONS / weaponModels (main.js).
export const WEAPON_ORDER = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper'];

// --- Dispersion ------------------------------------------------------------
export const SPREAD_MOVE_MULT = 1.6; // en mouvement
export const SPREAD_AIR_MULT = 2.2; // en l'air
export const SPREAD_CROUCH_MULT = 0.7; // accroupi, immobile
export const SPREAD_BLOOM_FACTOR = 0.8; // part de `spread.hip` ajoutée par unité de "bloom"
export const BLOOM_PER_SHOT = 0.25;
export const BLOOM_MAX = 1.5;
export const BLOOM_DECAY_PER_SEC = 2.2;

// Dispersion (rayon du disque) à appliquer à un tir, d'après l'état du joueur.
// `bloom` : 0 au repos, monte à chaque tir (surtout en rafale) puis redescend.
export function currentSpread(def, { aiming, moving, airborne, crouching, bloom = 0 }) {
  let base = aiming ? def.spread.aim : def.spread.hip;
  if (airborne) base *= SPREAD_AIR_MULT;
  else if (moving) base *= SPREAD_MOVE_MULT;
  else if (crouching) base *= SPREAD_CROUCH_MULT;
  return base + def.spread.hip * SPREAD_BLOOM_FACTOR * bloom;
}

// --- Grenades --------------------------------------------------------------
export const GRENADE_DEFS = {
  frag: {
    id: 'frag',
    name: 'Grenade',
    price: 70,
    max: 2,
    fuse: 2.4, // secondes avant l'explosion
    radius: 7, // rayon des dégâts (m)
    damage: 100, // au centre, décroît jusqu'à 0 au bord
    description: 'Explose 2,4 s après le lancer. Jusqu\'à 100 dégâts, décroissants avec la distance ; bloquée par les murs.',
  },
  smoke: {
    id: 'smoke',
    name: 'Fumigène',
    price: 40,
    max: 2,
    fuse: 1.8,
    radius: 5, // rayon visuel du nuage (m)
    duration: 14, // secondes
    description: 'Nuage de fumée de 14 s qui bloque la vue (les balles passent, mais personne ne voit où viser).',
  },
};
export const GRENADE_KINDS = Object.keys(GRENADE_DEFS);

// Physique de vol : identique côté serveur (qui décide de l'explosion) et
// côté client (qui n'affiche que le vol). Voir stepGrenade().
export const GRENADE_RADIUS = 0.12;
export const GRENADE_GRAVITY = 16;
export const GRENADE_RESTITUTION = 0.45;
export const GRENADE_THROW_SPEED = 16;
export const GRENADE_THROW_LIFT = 3;
export const GRENADE_STEP = 1 / 60;

function grenadeCollides(boxes, x, y, z) {
  const r = GRENADE_RADIUS;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (
      x > b.minX - r && x < b.maxX + r &&
      y > b.minY - r && y < b.maxY + r &&
      z > b.minZ - r && z < b.maxZ + r
    ) {
      return true;
    }
  }
  return false;
}

// Avance une grenade d'un pas de temps fixe. `boxes` : [{minX,maxX,minY,maxY,
// minZ,maxZ}]. Déplacement axe par axe : au moindre contact on annule le
// mouvement sur cet axe et on fait rebondir la vitesse correspondante.
export function stepGrenade(g, boxes, dt = GRENADE_STEP) {
  g.vel.y -= GRENADE_GRAVITY * dt;
  for (const axis of ['x', 'y', 'z']) {
    const prev = g.pos[axis];
    g.pos[axis] += g.vel[axis] * dt;
    if (grenadeCollides(boxes, g.pos.x, g.pos.y, g.pos.z)) {
      g.pos[axis] = prev;
      g.vel[axis] = -g.vel[axis] * GRENADE_RESTITUTION;
      for (const other of ['x', 'y', 'z']) {
        if (other !== axis) g.vel[other] *= 0.85;
      }
    }
  }
  if (g.pos.y < GRENADE_RADIUS) {
    g.pos.y = GRENADE_RADIUS;
    g.vel.y = Math.abs(g.vel.y) > 1.2 ? -g.vel.y * 0.4 : 0;
    g.vel.x *= 0.86;
    g.vel.z *= 0.86;
  }
}

// --- Course, glissade ------------------------------------------------------
export const SPRINT_MULT = 1.6;
export const STAMINA_MAX = 100;
export const STAMINA_DRAIN_PER_SEC = 24;
export const STAMINA_REGEN_PER_SEC = 18;
export const STAMINA_REGEN_DELAY = 1.0; // secondes sans courir avant de récupérer
export const STAMINA_MIN_TO_RESUME = 25; // après épuisement, il faut remonter à ce seuil
export const SLIDE_DURATION = 0.85;
export const SLIDE_SPEED_START = 10;
export const SLIDE_SPEED_END = 3.5;
export const SLIDE_COOLDOWN = 1.0;
export const SLIDE_EYE_HEIGHT = 0.8;
