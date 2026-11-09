// ---------------------------------------------------------------------------
// Effets d'interface liés au combat : chiffres de dégâts, indicateur de la
// direction des dégâts reçus, vignette rouge quand la vie est basse.
// Que du DOM + un peu de maths : aucun lien avec le rendu 3D ni le réseau.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export function createHudFx({ camera, numbersLayerEl, indicatorLayerEl, vignetteEl }) {
  // --- Chiffres de dégâts -----------------------------------------------------
  // Un tir qui touche la même cible peu après le précédent s'additionne au
  // chiffre déjà affiché au lieu d'en créer un autre (rafale = un chiffre qui monte).
  const MERGE_WINDOW_MS = 350;
  const recentByTarget = new Map(); // targetId -> { el, total, time }
  const _p = new THREE.Vector3();

  function showDamageNumber(worldPosition, amount, headshot, targetId = null) {
    if (!numbersLayerEl || !Number.isFinite(amount) || amount <= 0) return;
    _p.copy(worldPosition).project(camera);
    if (_p.z > 1 || Math.abs(_p.x) > 1.2 || Math.abs(_p.y) > 1.2) return; // derrière nous ou hors écran
    const x = (_p.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_p.y * 0.5 + 0.5) * window.innerHeight;

    const now = performance.now();
    const previous = targetId ? recentByTarget.get(targetId) : null;
    if (previous && now - previous.time < MERGE_WINDOW_MS && previous.el.isConnected) {
      previous.total += amount;
      previous.time = now;
      previous.headshot = previous.headshot || headshot;
      setNumberStyle(previous.el, previous.total, previous.headshot);
      // relance l'animation
      previous.el.style.animation = 'none';
      void previous.el.offsetWidth;
      previous.el.style.animation = '';
      return;
    }

    const el = document.createElement('div');
    el.className = 'dmg-number';
    el.style.left = `${x + (Math.random() - 0.5) * 36}px`;
    el.style.top = `${y}px`;
    setNumberStyle(el, amount, headshot);
    numbersLayerEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    if (targetId) recentByTarget.set(targetId, { el, total: amount, time: now, headshot });
  }

  function setNumberStyle(el, amount, headshot) {
    el.textContent = String(Math.round(amount));
    el.classList.toggle('headshot', Boolean(headshot));
    el.classList.toggle('big', amount >= 60);
  }

  // --- Indicateur de direction des dégâts ---------------------------------------
  // Un arc rouge autour du viseur, orienté vers l'endroit d'où vient le coup.
  // Il continue de pointer vers la source si on tourne la tête (recalculé à
  // chaque image), puis s'estompe.
  const INDICATOR_LIFETIME_MS = 2000;
  const MAX_INDICATORS = 6;
  const indicators = []; // { el, x, z, born, power }
  const _f = new THREE.Vector3();

  function addDamageSource(x, z, amount = 20) {
    if (!indicatorLayerEl || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (indicators.length >= MAX_INDICATORS) {
      const oldest = indicators.shift();
      oldest.el.remove();
    }
    const el = document.createElement('div');
    el.className = 'dmg-indicator';
    el.appendChild(document.createElement('i'));
    indicatorLayerEl.appendChild(el);
    indicators.push({ el, x, z, born: performance.now(), power: Math.min(1, 0.45 + amount / 80) });
  }

  function updateIndicators(now) {
    if (indicators.length === 0) return;
    camera.getWorldDirection(_f);
    const fx = _f.x;
    const fz = _f.z;
    const flen = Math.hypot(fx, fz) || 1;
    const nfx = fx / flen;
    const nfz = fz / flen;
    // "droite" de l'écran dans le plan horizontal
    const rx = -nfz;
    const rz = nfx;
    const radius = Math.max(90, Math.min(window.innerWidth, window.innerHeight) * 0.2);

    for (let i = indicators.length - 1; i >= 0; i--) {
      const ind = indicators[i];
      const age = now - ind.born;
      if (age > INDICATOR_LIFETIME_MS) {
        ind.el.remove();
        indicators.splice(i, 1);
        continue;
      }
      let dx = ind.x - camera.position.x;
      let dz = ind.z - camera.position.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.3) {
        // coup reçu "sur place" (explosion juste sous nous) : on n'indique pas de direction
        ind.el.style.opacity = '0';
        continue;
      }
      dx /= len;
      dz /= len;
      const angle = Math.atan2(dx * rx + dz * rz, dx * nfx + dz * nfz); // 0 = devant, + = à droite
      const fade = 1 - Math.pow(age / INDICATOR_LIFETIME_MS, 2);
      ind.el.style.opacity = String(fade * ind.power);
      ind.el.style.transform = `translate(-50%, -50%) rotate(${angle}rad) translateY(${-radius}px)`;
    }
  }

  // --- Vignette de vie basse -------------------------------------------------------
  const LOW_HP_THRESHOLD = 45; // en dessous : la vignette apparaît
  let vignettePhase = 0;
  function updateVignette(hp, maxHp, dead, delta) {
    if (!vignetteEl) return;
    if (dead) {
      vignetteEl.style.opacity = '0';
      return;
    }
    const level = THREE.MathUtils.clamp((LOW_HP_THRESHOLD - hp) / LOW_HP_THRESHOLD, 0, 1);
    if (level <= 0) {
      vignetteEl.style.opacity = '0';
      return;
    }
    // "battement de coeur" de plus en plus rapide quand la vie baisse
    vignettePhase += delta * (3 + level * 5);
    const pulse = 0.72 + 0.28 * Math.sin(vignettePhase);
    vignetteEl.style.opacity = String(Math.min(1, (0.25 + level * 0.75) * pulse));
  }

  function update(now, hp, maxHp, dead, delta) {
    updateIndicators(now);
    updateVignette(hp, maxHp, dead, delta);
  }

  function clear() {
    indicators.forEach((i) => i.el.remove());
    indicators.length = 0;
    if (numbersLayerEl) numbersLayerEl.replaceChildren();
    recentByTarget.clear();
  }

  // --- Annonces des administrateurs ----------------------------------------------
  // Bandeau en haut de l'écran ; plusieurs annonces s'empilent et disparaissent seules.
  let announceLayer = null;
  function showAnnouncement(text, from = null, isPrivate = false) {
    if (!text) return;
    if (!announceLayer) {
      announceLayer = document.createElement('div');
      announceLayer.id = 'announce-layer';
      document.body.appendChild(announceLayer);
    }
    const banner = document.createElement('div');
    banner.className = `announce-banner${isPrivate ? ' private' : ''}`;
    const label = document.createElement('span');
    label.className = 'announce-from';
    label.textContent = isPrivate ? 'Message de l\'administrateur' : from ? `Annonce · ${from}` : 'Annonce';
    const body = document.createElement('div');
    body.textContent = text; // textContent : jamais de HTML venu du réseau
    banner.append(label, body);
    announceLayer.appendChild(banner);
    setTimeout(() => banner.classList.add('hide'), 8000);
    setTimeout(() => banner.remove(), 8600);
  }

  return { showDamageNumber, addDamageSource, showAnnouncement, update, clear };
}
