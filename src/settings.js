// ---------------------------------------------------------------------------
// Réglages de jeu personnalisables : sensibilité de la souris, champ de vision,
// volume et effets lumineux (bloom). Modifiables dans l'onglet Paramètres du
// lobby (voir initSettingsPicker plus bas) et stockés en local, comme les
// touches (voir keybinds.js) et le skin (voir appearance.js).
//
// Ils sont lus au chargement du jeu puis relus à chaque nouvelle partie (voir
// startNetwork dans main.js) : le lobby, où on les modifie, est masqué tant
// qu'on joue, inutile de les appliquer en direct.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'mw_settings';

// Ordre d'affichage dans les paramètres.
export const SETTING_DEFS = [
  {
    id: 'sensitivity',
    label: 'Sensibilité de la souris',
    type: 'range',
    min: 0.2,
    max: 3,
    step: 0.05,
    default: 1,
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    id: 'fov',
    label: 'Champ de vision',
    type: 'range',
    min: 60,
    max: 110,
    step: 1,
    default: 75, // valeur d'origine du jeu
    format: (v) => `${Math.round(v)}°`,
  },
  {
    id: 'volume',
    label: 'Volume',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    default: 70,
    format: (v) => `${Math.round(v)} %`,
  },
  {
    id: 'bloom',
    label: 'Effets lumineux (bloom)',
    type: 'toggle',
    default: true,
  },
];

export const DEFAULT_SETTINGS = Object.fromEntries(SETTING_DEFS.map((d) => [d.id, d.default]));

const DEF_BY_ID = new Map(SETTING_DEFS.map((d) => [d.id, d]));

// Ramène n'importe quelle valeur (lue dans le stockage local, donc modifiable
// à la main) dans la plage permise : une valeur absurde ne doit jamais
// pouvoir casser la caméra ou le son.
function sanitizeValue(def, value) {
  if (def.type === 'toggle') return typeof value === 'boolean' ? value : def.default;
  const n = Number(value);
  if (!Number.isFinite(n)) return def.default;
  return Math.min(def.max, Math.max(def.min, n));
}

function sanitizeSettings(input) {
  const safe = {};
  for (const def of SETTING_DEFS) {
    safe[def.id] = sanitizeValue(def, input && typeof input === 'object' ? input[def.id] : undefined);
  }
  return safe;
}

export function getSettings() {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSetting(id, value) {
  const def = DEF_BY_ID.get(id);
  const current = getSettings();
  if (!def) return current;
  const merged = { ...current, [id]: sanitizeValue(def, value) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // stockage local indisponible (navigation privée stricte...) : on garde la valeur pour cette page seulement
  }
  return merged;
}

export function resetSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // rien à faire
  }
  return { ...DEFAULT_SETTINGS };
}

// ---------------------------------------------------------------------------
// UI (branchée dans le lobby, onglet Paramètres — voir index.html + lobby.js)
// ---------------------------------------------------------------------------
// onChange(settings) : appelé à chaque modification.
// onVolumeCommit(settings) : appelé quand on LÂCHE le curseur de volume,
// pour que lobby.js joue un petit son d'essai.
export function initSettingsPicker({ onChange, onVolumeCommit } = {}) {
  const listEl = document.getElementById('settings-list');
  const resetButton = document.getElementById('settings-reset');
  if (!listEl) return; // markup absent (ex. tests)

  function render() {
    const settings = getSettings();
    listEl.innerHTML = '';

    SETTING_DEFS.forEach((def) => {
      const row = document.createElement('div');
      row.className = 'setting-row';

      const name = document.createElement('label');
      name.textContent = def.label;
      const inputId = `setting-${def.id}`;
      name.htmlFor = inputId;
      row.appendChild(name);

      const control = document.createElement('div');
      control.className = 'setting-control';

      const input = document.createElement('input');
      input.id = inputId;

      if (def.type === 'range') {
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(settings[def.id]);

        const valueEl = document.createElement('span');
        valueEl.className = 'setting-value';
        valueEl.textContent = def.format(settings[def.id]);

        input.addEventListener('input', () => {
          const updated = setSetting(def.id, input.value);
          valueEl.textContent = def.format(updated[def.id]);
          if (onChange) onChange(updated);
        });
        if (def.id === 'volume') {
          input.addEventListener('change', () => {
            if (onVolumeCommit) onVolumeCommit(getSettings());
          });
        }
        control.append(input, valueEl);
      } else {
        input.type = 'checkbox';
        input.checked = Boolean(settings[def.id]);
        input.addEventListener('change', () => {
          const updated = setSetting(def.id, input.checked);
          if (onChange) onChange(updated);
        });
        control.appendChild(input);
      }

      row.appendChild(control);
      listEl.appendChild(row);
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      const settings = resetSettings();
      render();
      if (onChange) onChange(settings);
      if (onVolumeCommit) onVolumeCommit(settings);
    });
  }

  render();
}
