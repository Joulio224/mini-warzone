import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Personnalisation du skin — couleur du corps (libre) + visage (un emoji au
// choix, qui sert à la fois d'identité ET d'expression : 😀 n'est pas 😡).
// ---------------------------------------------------------------------------
// Il n'existe pas vraiment de bibliothèque de VRAIS modèles 3D d'emojis pour
// Three.js (vérifié) — les rares packages qui existent (ex. "emoji-3d" sur
// npm) font tous la même chose : dessiner l'emoji avec la police système sur
// un <canvas> 2D, puis plaquer ça comme texture sur un plan 3D. C'est ce
// qu'on fait ici, en natif, sans dépendance supplémentaire.
//
// Le corps reste par ailleurs teinté par l'équipe via une petite pastille
// séparée au-dessus de la tête (voir main.js, createPlayerMesh) — sinon,
// avec une couleur de corps 100% libre, on ne pourrait plus distinguer
// alliés et ennemis d'un coup d'œil.

// Choix d'emoji proposés — doit rester identique à la liste de validation
// dans mini-warzone-server/server.js (le serveur rejette tout emoji hors de
// cette liste pour éviter qu'un client modifié envoie n'importe quel texte).
export const EMOJI_FACES = ['😀', '😎', '😡', '😱', '🤖', '👽', '💀', '🥶', '🤠', '🤡', '😈', '🥵'];

const STORAGE_KEY = 'mw_appearance';
export const DEFAULT_APPEARANCE = { bodyColor: '#8a8f98', face: EMOJI_FACES[0] };

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function sanitizeAppearance(input) {
  const bodyColor = HEX_COLOR_RE.test(input?.bodyColor) ? input.bodyColor : DEFAULT_APPEARANCE.bodyColor;
  const face = EMOJI_FACES.includes(input?.face) ? input.face : DEFAULT_APPEARANCE.face;
  return { bodyColor, face };
}

export function getAppearance() {
  try {
    return sanitizeAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function setAppearance(partial) {
  const merged = sanitizeAppearance({ ...getAppearance(), ...partial });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

// Cache par emoji : évite de redessiner/recréer une texture pour chaque
// joueur qui partage le même visage (souvent plusieurs, vu le choix limité).
const textureCache = new Map();

export function getEmojiTexture(emoji) {
  const cached = textureCache.get(emoji);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Fond transparent : seul le glyphe de l'emoji est dessiné, pour que la
  // couleur du matériau de la tête reste visible tout autour.
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.round(size * 0.78)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(emoji, texture);
  return texture;
}

// ---------------------------------------------------------------------------
// UI du sélecteur (branchée dans le lobby, voir index.html + lobby.js)
// ---------------------------------------------------------------------------
export function initAppearancePicker() {
  const colorInput = document.getElementById('appearance-body-color');
  const faceGrid = document.getElementById('appearance-face-grid');
  const previewFace = document.getElementById('appearance-preview-face');
  const previewBody = document.getElementById('appearance-preview-body');
  if (!colorInput || !faceGrid) return; // markup absent (ex. tests) : on n'échoue pas silencieusement pour autant

  const current = getAppearance();

  function renderPreview(appearance) {
    if (previewBody) previewBody.style.background = appearance.bodyColor;
    if (previewFace) previewFace.textContent = appearance.face;
  }

  colorInput.value = current.bodyColor;
  faceGrid.innerHTML = '';
  EMOJI_FACES.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'face-option';
    button.textContent = emoji;
    button.classList.toggle('selected', emoji === current.face);
    button.addEventListener('click', () => {
      const updated = setAppearance({ face: emoji });
      faceGrid.querySelectorAll('.face-option').forEach((el) => el.classList.remove('selected'));
      button.classList.add('selected');
      renderPreview(updated);
    });
    faceGrid.appendChild(button);
  });

  colorInput.addEventListener('input', () => {
    renderPreview(setAppearance({ bodyColor: colorInput.value }));
  });

  renderPreview(current);
}
