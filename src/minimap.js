// ---------------------------------------------------------------------------
// Carte du jeu + pings d'équipe
// ---------------------------------------------------------------------------
// Une touche (M par défaut, réglable dans Paramètres — voir keybinds.js) ouvre
// la carte en plein écran ; le jeu continue derrière. Clic gauche = pose un ping
// à cet endroit, dans la couleur de TON skin, visible de tes alliés (le serveur
// décide qui, voir 'place-ping' dans server.js) ; clic droit = retire ton ping.
//
// Ce module ne parle ni à la 3D ni au réseau : main.js lui donne les boîtes de
// collision (pour dessiner le plan), la position/orientation du joueur et de ses
// alliés, et reçoit les clics via onPlacePing / onRemovePing. Les pings eux-mêmes
// (un par joueur, qui expirent seuls) vivent ici.
//
// Aucun fichier d'image : le plan est dessiné d'après les boîtes de collision,
// les mêmes que celles qui bloquent réellement les joueurs et les balles.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// Les murs d'enceinte de la map sont à ±75 m (voir map-data.json).
export const MAP_BOUNDS = { minX: -78, maxX: 78, minZ: -78, maxZ: 78 };

const PING_COLOR_FALLBACK = '#ffd23f';

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// `hexColor` doit être "#rrggbb" ; sinon couleur de secours (le serveur filtre
// déjà, c'est une ceinture de sécurité avant de s'en servir dans du CSS/canvas).
function safeColor(hexColor) {
  return /^#[0-9a-f]{6}$/i.test(hexColor) ? hexColor : PING_COLOR_FALLBACK;
}

export function createMinimap({
  screenEl, // conteneur plein écran (#map-screen)
  canvasEl, // <canvas> de la carte
  markerLayerEl, // calque des marqueurs de ping en surimpression du jeu
  getBoxes, // () => THREE.Box3[] (collisions)
  getSelf, // () => { x, z, yaw, color }
  getAllies, // () => [{ id, x, z, color, pseudo }]
  getGroundY, // (x, z) => hauteur du sol (pour poser le marqueur dans le monde)
  onPlacePing, // (x, z) => void
  onRemovePing, // () => void
  getMyId, // () => id socket du joueur local
  onOpenChange = () => {},
}) {
  const ctx = canvasEl.getContext('2d');
  let open = false;
  let size = 600; // côté (px CSS) du carré de la carte
  let dpr = 1;
  let base = null; // plan pré-dessiné (canvas hors écran)
  let baseBoxCount = -1;

  // senderId -> { senderId, pseudo, color, x, z, y, createdAt, ttl, el }
  const pings = new Map();

  // --- Conversions monde <-> canvas ----------------------------------------
  const spanX = MAP_BOUNDS.maxX - MAP_BOUNDS.minX;
  const spanZ = MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ;
  function toCanvas(x, z) {
    return [((x - MAP_BOUNDS.minX) / spanX) * size, ((z - MAP_BOUNDS.minZ) / spanZ) * size];
  }
  function toWorld(px, py) {
    return [
      MAP_BOUNDS.minX + (px / size) * spanX,
      MAP_BOUNDS.minZ + (py / size) * spanZ,
    ];
  }

  // --- Taille du canvas ----------------------------------------------------
  function resize() {
    size = Math.floor(Math.min(window.innerHeight * 0.8, window.innerWidth * 0.94));
    size = Math.max(240, size);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvasEl.style.width = `${size}px`;
    canvasEl.style.height = `${size}px`;
    canvasEl.width = Math.round(size * dpr);
    canvasEl.height = Math.round(size * dpr);
    base = null; // à redessiner à la prochaine ouverture
  }

  // --- Plan de la map (dessiné une fois, puis recopié à chaque image) ------
  function renderBase() {
    const boxes = getBoxes();
    base = document.createElement('canvas');
    base.width = canvasEl.width;
    base.height = canvasEl.height;
    baseBoxCount = boxes.length;
    const g = base.getContext('2d');
    g.scale(dpr, dpr);

    // Fond (sol)
    const bg = g.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, '#1a2430');
    bg.addColorStop(1, '#131a23');
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);

    // Quadrillage tous les 15 m
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    g.beginPath();
    for (let m = Math.ceil(MAP_BOUNDS.minX / 15) * 15; m <= MAP_BOUNDS.maxX; m += 15) {
      const [px] = toCanvas(m, 0);
      g.moveTo(px, 0);
      g.lineTo(px, size);
    }
    for (let m = Math.ceil(MAP_BOUNDS.minZ / 15) * 15; m <= MAP_BOUNDS.maxZ; m += 15) {
      const [, py] = toCanvas(0, m);
      g.moveTo(0, py);
      g.lineTo(size, py);
    }
    g.stroke();

    // Obstacles : on ignore ce qui n'a pas de sens sur un plan (sols immenses,
    // éléments en hauteur au-dessus des têtes, décors plats).
    const walls = [];
    const covers = [];
    boxes.forEach((b) => {
      const w = b.max.x - b.min.x;
      const d = b.max.z - b.min.z;
      const h = b.max.y - b.min.y;
      if (w > 140 && d > 140) return; // sol / plafond géant
      if (h < 0.3) return; // décor plat
      if (b.min.y > 4) return; // au-dessus du joueur
      (b.max.y > 2.6 ? walls : covers).push(b);
    });
    const fillBoxes = (list, fill, stroke) => {
      g.fillStyle = fill;
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      list.forEach((b) => {
        const [x0, y0] = toCanvas(b.min.x, b.min.z);
        const [x1, y1] = toCanvas(b.max.x, b.max.z);
        const w = Math.max(1.5, x1 - x0);
        const h = Math.max(1.5, y1 - y0);
        g.fillRect(x0, y0, w, h);
        g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      });
    };
    fillBoxes(covers, 'rgba(110,134,160,0.75)', 'rgba(20,28,38,0.7)'); // caisses, murets
    fillBoxes(walls, 'rgba(170,190,212,0.95)', 'rgba(20,28,38,0.85)'); // murs

    // Cadre de la zone de jeu
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, size - 2, size - 2);

    // Repères de direction
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('N', size / 2, 16);
    g.fillText('S', size / 2, size - 6);
    g.textAlign = 'left';
    g.fillText('O', 6, size / 2 + 4);
    g.textAlign = 'right';
    g.fillText('E', size - 6, size / 2 + 4);
  }

  // --- Dessin d'une image --------------------------------------------------
  function drawDiamond(x, y, r, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 2;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }

  function draw(now = performance.now()) {
    if (!open) return;
    if (!base || baseBoxCount !== getBoxes().length) renderBase();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.drawImage(base, 0, 0);
    ctx.scale(dpr, dpr);

    // Alliés
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    getAllies().forEach((ally) => {
      const [px, py] = toCanvas(ally.x, ally.z);
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = safeColor(ally.color);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(ally.pseudo || '', px + 1, py - 10 + 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ally.pseudo || '', px, py - 10);
    });

    // Pings (avec une onde qui pulse)
    pings.forEach((ping) => {
      const age = now - ping.createdAt;
      const left = ping.ttl - age;
      if (left <= 0) return;
      const [px, py] = toCanvas(ping.x, ping.z);
      const color = safeColor(ping.color);
      const phase = (age % 1400) / 1400;
      ctx.beginPath();
      ctx.arc(px, py, 8 + phase * 22, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = (1 - phase) * 0.8;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawDiamond(px, py, 7, color, left < 2000 ? 0.5 + 0.5 * Math.sin(age / 90) : 1);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.textAlign = 'center';
      ctx.strokeText(ping.pseudo || '', px, py - 16);
      ctx.fillText(ping.pseudo || '', px, py - 16);
    });

    // Toi : flèche orientée dans le sens du regard (nord = haut de la carte)
    const me = getSelf();
    if (me) {
      const [px, py] = toCanvas(me.x, me.z);
      ctx.save();
      ctx.translate(px, py);
      // yaw caméra : 0 = regarde vers -Z (haut de la carte) ; positif = tourne vers la gauche
      ctx.rotate(-me.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(7, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-7, 8);
      ctx.closePath();
      ctx.fillStyle = safeColor(me.color);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- Interaction ---------------------------------------------------------
  function eventToWorld(e) {
    const rect = canvasEl.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * size;
    const py = ((e.clientY - rect.top) / rect.height) * size;
    const [x, z] = toWorld(px, py);
    return [clamp(x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX), clamp(z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ)];
  }

  canvasEl.addEventListener('mousedown', (e) => {
    if (!open) return;
    e.preventDefault();
    if (e.button === 0) {
      const [x, z] = eventToWorld(e);
      onPlacePing(x, z);
    } else if (e.button === 2) {
      onRemovePing();
    }
  });
  canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => {
    if (open) {
      resize();
    } else {
      base = null;
    }
  });

  function setOpen(value) {
    if (open === value) return;
    open = value;
    screenEl.hidden = !open;
    if (open) resize();
    onOpenChange(open);
  }

  // --- Pings ---------------------------------------------------------------
  function makeMarkerEl() {
    const el = document.createElement('div');
    el.className = 'ping-marker';
    const icon = document.createElement('div');
    icon.className = 'ping-marker-icon';
    const label = document.createElement('div');
    label.className = 'ping-marker-label';
    el.append(icon, label);
    markerLayerEl.appendChild(el);
    return el;
  }

  function addPing({ senderId, pseudo, color, x, z, ttl }) {
    if (!senderId || !Number.isFinite(x) || !Number.isFinite(z)) return;
    removePing(senderId);
    const ping = {
      senderId,
      pseudo: String(pseudo || '').slice(0, 20),
      color: safeColor(color),
      x,
      z,
      y: getGroundY ? getGroundY(x, z) : 0,
      createdAt: performance.now(),
      ttl: Number.isFinite(ttl) ? clamp(ttl, 1000, 60000) : 15000,
      el: makeMarkerEl(),
    };
    ping.el.style.setProperty('--ping-color', ping.color);
    pings.set(senderId, ping);
  }

  function removePing(senderId) {
    const ping = pings.get(senderId);
    if (!ping) return;
    ping.el.remove();
    pings.delete(senderId);
  }

  function hasPing(senderId) {
    return pings.has(senderId);
  }

  // Marqueurs en surimpression du jeu : pour chaque ping, un losange coloré +
  // pseudo + distance, visible même à travers les murs, collé au bord de
  // l'écran quand le ping est hors du champ de vision.
  const tmp = new THREE.Vector3();
  function updateMarkers(camera, now = performance.now()) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const margin = 36;
    pings.forEach((ping, senderId) => {
      if (now - ping.createdAt >= ping.ttl) {
        removePing(senderId);
        return;
      }
      tmp.set(ping.x, ping.y + 1.4, ping.z);
      const dist = Math.round(camera.position.distanceTo(tmp));
      tmp.project(camera);

      let nx = tmp.x;
      let ny = tmp.y;
      const behind = tmp.z > 1;
      if (behind) {
        nx = -nx;
        ny = -ny;
      }
      let sx = (nx * 0.5 + 0.5) * w;
      let sy = (-ny * 0.5 + 0.5) * h;
      const offscreen = behind || sx < margin || sx > w - margin || sy < margin || sy > h - margin;
      if (offscreen) {
        // Ramène le point sur le bord de l'écran, dans la même direction depuis le centre
        const cx = w / 2;
        const cy = h / 2;
        const dx = sx - cx || 0.0001;
        const dy = sy - cy || 0.0001;
        const k = Math.min((cx - margin) / Math.abs(dx), (cy - margin) / Math.abs(dy));
        sx = cx + dx * k;
        sy = cy + dy * k;
      }
      const left = ping.ttl - (now - ping.createdAt);
      ping.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      ping.el.classList.toggle('offscreen', offscreen);
      ping.el.classList.toggle('fading', left < 2000);
      ping.el.lastChild.textContent = `${ping.pseudo} · ${dist} m`;
    });
  }

  function clearPings() {
    Array.from(pings.keys()).forEach(removePing);
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    draw,
    addPing,
    removePing,
    hasPing,
    clearPings,
    updateMarkers,
    getMyPing: () => pings.get(getMyId?.()) || null,
  };
}
