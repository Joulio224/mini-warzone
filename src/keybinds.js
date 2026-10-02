// ---------------------------------------------------------------------------
// Touches personnalisables — chaque action clavier du jeu (se déplacer,
// sauter, s'accroupir, changer d'arme, utiliser un gilet, ouvrir la
// boutique) est associée à UNE touche (KeyboardEvent.code), modifiable dans
// l'onglet Paramètres du lobby (voir initKeybindsPicker plus bas) et stockée
// en local, comme le skin (voir STORAGE_KEY dans appearance.js).
//
// Volontairement absents d'ici : viser/tirer (boutons de souris, pas des
// "touches") et le changement d'arme à la molette (toujours actif, pas
// besoin d'être assigné). Voir main.js.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'mw_keybinds';

// Ordre d'affichage dans les paramètres.
export const KEYBIND_ACTIONS = [
  { id: 'forward', label: 'Avancer' },
  { id: 'backward', label: 'Reculer' },
  { id: 'left', label: 'Aller à gauche' },
  { id: 'right', label: 'Aller à droite' },
  { id: 'jump', label: 'Sauter' },
  { id: 'crouch', label: "S'accroupir" },
  { id: 'weaponSlot1', label: 'Arme 1' },
  { id: 'weaponSlot2', label: 'Arme 2' },
  { id: 'useVest', label: 'Utiliser un gilet' },
  { id: 'shop', label: 'Ouvrir/fermer la boutique' },
];
const ACTION_IDS = new Set(KEYBIND_ACTIONS.map((a) => a.id));

export const DEFAULT_KEYBINDS = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  crouch: 'KeyC',
  weaponSlot1: 'Digit1',
  weaponSlot2: 'Digit2',
  useVest: 'KeyP',
  shop: 'KeyB',
};

// Échap est réservé par le navigateur (sortie du pointer lock) : jamais
// assignable à une action, même si l'utilisateur essaie.
const RESERVED_CODES = new Set(['Escape']);

function sanitizeKeybinds(input) {
  const safe = { ...DEFAULT_KEYBINDS };
  if (input && typeof input === 'object') {
    for (const id of ACTION_IDS) {
      const code = input[id];
      if (typeof code === 'string' && code.length > 0 && code.length < 40 && !RESERVED_CODES.has(code)) {
        safe[id] = code;
      }
    }
  }
  return safe;
}

export function getKeybinds() {
  try {
    return sanitizeKeybinds(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_KEYBINDS };
  }
}

// Renvoie { ok: true, keybinds } ou { ok: false, reason, keybinds (inchangés) }.
export function setKeybind(actionId, code) {
  const current = getKeybinds();
  if (!ACTION_IDS.has(actionId)) return { ok: false, reason: 'Action inconnue.', keybinds: current };
  if (RESERVED_CODES.has(code)) {
    return { ok: false, reason: 'Échap est réservé, choisis une autre touche.', keybinds: current };
  }
  const conflict = KEYBIND_ACTIONS.find((a) => a.id !== actionId && current[a.id] === code);
  if (conflict) {
    return { ok: false, reason: `Déjà utilisée pour « ${conflict.label} ».`, keybinds: current };
  }
  const merged = sanitizeKeybinds({ ...current, [actionId]: code });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return { ok: true, keybinds: merged };
}

export function resetKeybinds() {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_KEYBINDS };
}

// Nom court affiché pour une touche (KeyboardEvent.code -> libellé), utilisé
// aussi bien dans les paramètres que dans l'aide du menu de jeu (main.js).
const CODE_LABELS = {
  Space: 'Espace',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  ShiftLeft: 'Maj',
  ShiftRight: 'Maj',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};
export function keyLabel(code) {
  if (!code) return '—';
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

// "ZQSD/WASD" quand les 4 touches de déplacement sont encore par défaut (vrai
// pour la quasi-totalité des joueurs) — sinon les touches choisies telles
// quelles. Le clavier physique ZQSD (AZERTY) envoie bien les codes
// KeyW/KeyA/KeyS/KeyD (le code suit la position physique, pas le symbole
// imprimé), d'où le rappel utile entre parenthèses côté aide du menu.
export function describeMovementKeys(keybinds) {
  const isDefault =
    keybinds.forward === DEFAULT_KEYBINDS.forward &&
    keybinds.backward === DEFAULT_KEYBINDS.backward &&
    keybinds.left === DEFAULT_KEYBINDS.left &&
    keybinds.right === DEFAULT_KEYBINDS.right;
  if (isDefault) return 'ZQSD/WASD';
  return `${keyLabel(keybinds.forward)}/${keyLabel(keybinds.left)}/${keyLabel(keybinds.backward)}/${keyLabel(keybinds.right)}`;
}

// ---------------------------------------------------------------------------
// UI du sélecteur (branchée dans le lobby, onglet Paramètres — voir
// index.html + lobby.js)
// ---------------------------------------------------------------------------
// onChange(keybinds) est appelé à chaque modification (lobby.js s'en sert
// pour rafraîchir l'aide du menu de jeu).
export function initKeybindsPicker({ onChange } = {}) {
  const listEl = document.getElementById('keybind-list');
  const resetButton = document.getElementById('keybind-reset');
  const errorEl = document.getElementById('keybind-error');
  if (!listEl) return; // markup absent (ex. tests) : on n'échoue pas silencieusement pour autant

  let listeningActionId = null;

  function render() {
    const keybinds = getKeybinds();
    listEl.innerHTML = '';
    KEYBIND_ACTIONS.forEach(({ id, label }) => {
      const row = document.createElement('div');
      row.className = 'keybind-row';

      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);

      const keyButton = document.createElement('button');
      keyButton.type = 'button';
      keyButton.className = 'keybind-key';
      const isListening = listeningActionId === id;
      keyButton.classList.toggle('listening', isListening);
      keyButton.textContent = isListening ? '...' : keyLabel(keybinds[id]);
      keyButton.addEventListener('click', () => {
        if (errorEl) errorEl.textContent = '';
        listeningActionId = id;
        render();
      });
      row.appendChild(keyButton);

      listEl.appendChild(row);
    });
  }

  // Capture la PROCHAINE touche pressée n'importe où (capture: true, avant
  // tout autre gestionnaire) pendant qu'on écoute un ré-assignement, pour ne
  // jamais laisser cette touche atteindre le jeu ou le reste de la page —
  // Échap annule sans rien changer.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!listeningActionId) return;
      e.preventDefault();
      e.stopPropagation();
      const actionId = listeningActionId;
      listeningActionId = null;

      if (e.code === 'Escape') {
        render();
        return;
      }
      const result = setKeybind(actionId, e.code);
      if (errorEl) errorEl.textContent = result.ok ? '' : result.reason;
      render();
      if (result.ok && onChange) onChange(result.keybinds);
    },
    true
  );

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      listeningActionId = null;
      if (errorEl) errorEl.textContent = '';
      const keybinds = resetKeybinds();
      render();
      if (onChange) onChange(keybinds);
    });
  }

  render();
}
