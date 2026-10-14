// ---------------------------------------------------------------------------
// Sons du jeu — entièrement synthétisés avec la Web Audio API (bruit filtré +
// oscillateurs), donc AUCUN fichier audio à ajouter au projet. Si un jour tu
// préfères de vrais enregistrements, il suffira de remplacer le corps des
// fonctions play* ci-dessous par la lecture d'un fichier : le reste du jeu
// n'appelle que ces fonctions.
//
// Les sons des AUTRES joueurs (tirs, pas) sont spatialisés : balance gauche /
// droite selon leur position par rapport à où tu regardes, volume qui baisse
// avec la distance, son plus sourd s'ils sont derrière toi. Les tiens sont
// joués au centre.
//
// Les navigateurs interdisent de démarrer du son avant un geste de
// l'utilisateur : unlock() doit donc être appelé depuis un clic ou une touche
// (voir main.js et lobby.js). Avant ça, tous les play* ne font simplement rien.
// ---------------------------------------------------------------------------

const MAX_VOICES = 28; // au-delà, les nouveaux sons sont ignorés plutôt que de saturer
const DISTANCE_REF = 10; // à cette distance (m), un son spatialisé est à moitié moins fort

export function createAudioEngine({
  getContextClass = () => globalThis.AudioContext || globalThis.webkitAudioContext,
  random = Math.random,
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let voices = 0;
  let volume = 0.7; // 0..1
  let warned = false;

  // Position et orientation de l'auditeur (la caméra du joueur), à plat sur le sol
  const listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1, rx: 1, rz: 0 };

  // Courbe de volume : plus naturelle qu'un gain linéaire (l'oreille est logarithmique)
  const gainForVolume = (v) => v * v * 0.9;

  function unlock() {
    if (!ctx) {
      const Ctx = getContextClass();
      if (!Ctx) return false;
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = gainForVolume(volume);
      const limiter = ctx.createDynamicsCompressor(); // évite la saturation quand plusieurs sons se superposent
      master.connect(limiter);
      limiter.connect(ctx.destination);

      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
    return true;
  }

  function setVolume(percent) {
    const p = Number(percent);
    volume = Math.min(1, Math.max(0, (Number.isFinite(p) ? p : 70) / 100));
    if (master) master.gain.value = gainForVolume(volume);
  }

  // fx/fz : direction dans laquelle regarde la caméra (plan horizontal)
  function setListener(x, y, z, fx, fz) {
    listener.x = x;
    listener.y = y;
    listener.z = z;
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) {
      listener.fx = fx / len;
      listener.fz = fz / len;
      listener.rx = -listener.fz; // droite = avant tourné de 90° (voir three.js : avant = -Z, droite = +X)
      listener.rz = listener.fx;
    }
  }

  // Calcule volume / balance / "sourdine" d'un son situé à `at` ({x,y,z}),
  // ou null s'il est trop loin pour être entendu.
  function spatialize(at, maxDistance) {
    const dx = at.x - listener.x;
    const dy = at.y - listener.y;
    const dz = at.z - listener.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxDistance) return null;

    const gain = 1 / (1 + (dist / DISTANCE_REF) ** 2);
    const h = Math.hypot(dx, dz);
    let pan = 0;
    let front = 1;
    if (h > 0.5) {
      const nx = dx / h;
      const nz = dz / h;
      // De près, on adoucit la balance (un son à 1 m ne doit pas sortir d'une seule enceinte)
      pan = (nx * listener.rx + nz * listener.rz) * Math.min(1, h / 3);
      front = nx * listener.fx + nz * listener.fz;
    }
    const cutoff = 2500 + 9500 * ((front + 1) / 2); // derrière toi : plus sourd
    return { gain, pan: Math.max(-1, Math.min(1, pan)), cutoff, dist };
  }

  // Construit la chaîne de sortie d'un son et renvoie son point d'entrée.
  function makeOutput(level, spatial) {
    const g = ctx.createGain();
    g.gain.value = level * (spatial ? spatial.gain : 1);
    if (!spatial) {
      g.connect(master);
      return g;
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = spatial.cutoff;
    g.connect(lp);
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = spatial.pan;
      lp.connect(panner);
      panner.connect(master);
    } else {
      lp.connect(master);
    }
    return g;
  }

  // Enveloppe : attaque quasi instantanée puis décroissance exponentielle
  function envelope(param, t0, peak, dur, attack = 0.002) {
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(peak, t0 + attack);
    param.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, attack + 0.01));
  }

  function tone(dest, { type = 'sine', f0, f1 = f0, dur, gain = 1, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain, dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(dest, { filter = 'lowpass', f0, f1 = f0, q = 0.7, dur, gain = 1, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain, dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t0, random() * 0.5); // départ à un endroit aléatoire du bruit : chaque tir sonne un peu différemment
    src.stop(t0 + dur + 0.05);
  }

  // Point d'entrée commun : vérifie que le son est audible et qu'il reste de
  // la place, construit la sortie, puis laisse `build` assembler le son.
  function play({ level = 1, at = null, maxDistance = Infinity, duration, build }) {
    if (!ctx || ctx.state === 'closed' || volume <= 0) return;
    if (voices >= MAX_VOICES) return;
    let spatial = null;
    if (at) {
      spatial = spatialize(at, maxDistance);
      if (!spatial) return;
    }
    try {
      build(makeOutput(level, spatial));
      voices += 1;
      schedule(() => {
        voices = Math.max(0, voices - 1);
      }, duration * 1000 + 100);
    } catch (error) {
      // Un souci audio ne doit JAMAIS casser le jeu : on le signale une fois, puis on se tait.
      if (!warned) {
        warned = true;
        console.warn('[audio] son ignoré :', error);
      }
    }
  }

  // --- Sons ------------------------------------------------------------

  const SHOTS = {
    pistol: (out) => {
      noise(out, { filter: 'highpass', f0: 1500, f1: 600, dur: 0.08, gain: 0.9 });
      tone(out, { type: 'triangle', f0: 230, f1: 70, dur: 0.1, gain: 0.8 });
    },
    smg: (out) => {
      noise(out, { filter: 'bandpass', f0: 2600, f1: 1200, q: 0.9, dur: 0.05, gain: 0.7 });
      tone(out, { type: 'triangle', f0: 280, f1: 110, dur: 0.055, gain: 0.5 });
    },
    rifle: (out) => {
      noise(out, { filter: 'highpass', f0: 900, f1: 300, dur: 0.13, gain: 1 });
      tone(out, { type: 'sine', f0: 150, f1: 45, dur: 0.17, gain: 1 });
      noise(out, { filter: 'lowpass', f0: 700, f1: 200, dur: 0.28, gain: 0.25, delay: 0.03 });
    },
  };

  function playShot(weaponId, at = null) {
    const build = SHOTS[weaponId] || SHOTS.pistol;
    play({ level: at ? 0.9 : 0.8, at, maxDistance: 90, duration: 0.35, build });
  }

  function playHitMarker() {
    play({
      level: 0.6,
      duration: 0.15,
      build: (out) => {
        tone(out, { f0: 1900, f1: 1300, dur: 0.05, gain: 0.5 });
        tone(out, { f0: 2500, f1: 2100, dur: 0.05, gain: 0.35, delay: 0.045 });
      },
    });
  }

  // Petit "ding" de confirmation quand C'EST TOI qui élimines quelqu'un
  function playKill() {
    play({
      level: 0.7,
      duration: 0.5,
      build: (out) => {
        tone(out, { f0: 880, dur: 0.14, gain: 0.5 });
        tone(out, { f0: 1320, dur: 0.3, gain: 0.45, delay: 0.09 });
      },
    });
  }

  function playHurt() {
    play({
      level: 0.8,
      duration: 0.25,
      build: (out) => {
        tone(out, { f0: 170, f1: 70, dur: 0.17, gain: 0.8 });
        noise(out, { filter: 'lowpass', f0: 900, f1: 300, dur: 0.13, gain: 0.5 });
      },
    });
  }

  function playDeath() {
    play({
      level: 0.8,
      duration: 0.8,
      build: (out) => {
        tone(out, { type: 'sawtooth', f0: 320, f1: 50, dur: 0.7, gain: 0.4 });
        noise(out, { filter: 'lowpass', f0: 1200, f1: 150, dur: 0.6, gain: 0.5 });
      },
    });
  }

  function playRespawn() {
    play({
      level: 0.6,
      duration: 0.45,
      build: (out) => {
        tone(out, { f0: 300, f1: 720, dur: 0.22, gain: 0.45 });
        tone(out, { f0: 720, f1: 900, dur: 0.2, gain: 0.35, delay: 0.12 });
      },
    });
  }

  function playPickup() {
    play({
      level: 0.7,
      duration: 0.25,
      build: (out) => {
        tone(out, { type: 'triangle', f0: 700, f1: 900, dur: 0.07, gain: 0.5 });
        tone(out, { type: 'triangle', f0: 1000, f1: 1300, dur: 0.09, gain: 0.5, delay: 0.06 });
      },
    });
  }

  function playWeaponPickup() {
    play({
      level: 0.8,
      duration: 0.3,
      build: (out) => {
        noise(out, { filter: 'highpass', f0: 2500, dur: 0.035, gain: 0.6 });
        tone(out, { type: 'square', f0: 520, f1: 330, dur: 0.08, gain: 0.25 });
        noise(out, { filter: 'highpass', f0: 2000, dur: 0.03, gain: 0.5, delay: 0.08 });
      },
    });
  }

  function playPurchase() {
    play({
      level: 0.7,
      duration: 0.4,
      build: (out) => {
        tone(out, { f0: 1100, dur: 0.08, gain: 0.45 });
        tone(out, { f0: 1650, dur: 0.12, gain: 0.45, delay: 0.08 });
        noise(out, { filter: 'highpass', f0: 6000, dur: 0.14, gain: 0.12, delay: 0.08 });
      },
    });
  }

  function playUseVest() {
    play({
      level: 0.8,
      duration: 0.4,
      build: (out) => {
        noise(out, { filter: 'bandpass', f0: 400, f1: 1600, q: 1.2, dur: 0.28, gain: 0.5 });
        tone(out, { f0: 200, f1: 260, dur: 0.2, gain: 0.25 });
      },
    });
  }

  function playSwitchWeapon() {
    play({
      level: 0.6,
      duration: 0.15,
      build: (out) => {
        noise(out, { filter: 'highpass', f0: 2500, dur: 0.025, gain: 0.5 });
        tone(out, { type: 'triangle', f0: 420, f1: 300, dur: 0.045, gain: 0.3 });
      },
    });
  }

  // at : position des pieds de l'autre joueur (omise pour tes propres pas)
  function playFootstep({ at = null, crouching = false } = {}) {
    play({
      level: (at ? 0.5 : 0.35) * (crouching ? 0.45 : 1),
      at,
      maxDistance: 24,
      duration: 0.12,
      build: (out) => {
        noise(out, { filter: 'lowpass', f0: 500 + random() * 400, f1: 220, dur: 0.07, gain: 0.7 });
        tone(out, { f0: 70 + random() * 25, f1: 48, dur: 0.06, gain: 0.45 });
      },
    });
  }

  function playJump() {
    play({
      level: 0.4,
      duration: 0.2,
      build: (out) => {
        noise(out, { filter: 'bandpass', f0: 500, f1: 900, q: 0.8, dur: 0.12, gain: 0.35 });
      },
    });
  }

  // strength : 0..1, selon la vitesse de chute
  function playLand(strength = 1) {
    const s = Math.min(1, Math.max(0, strength));
    play({
      level: 0.3 + 0.6 * s,
      duration: 0.25,
      build: (out) => {
        tone(out, { f0: 115, f1: 45, dur: 0.13, gain: 0.8 });
        noise(out, { filter: 'lowpass', f0: 800, f1: 200, dur: 0.1, gain: 0.4 });
      },
    });
  }

  return {
    unlock,
    setVolume,
    setListener,
    playShot,
    playHitMarker,
    playKill,
    playHurt,
    playDeath,
    playRespawn,
    playPickup,
    playWeaponPickup,
    playPurchase,
    playUseVest,
    playSwitchWeapon,
    playFootstep,
    playJump,
    playLand,
    // Réservé aux tests
    _internals: { spatialize, listener, getVoices: () => voices, isReady: () => Boolean(ctx) },
  };
}

// Moteur unique partagé par tout le jeu
export const audio = createAudioEngine();
