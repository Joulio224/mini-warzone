// ---------------------------------------------------------------------------
// Panneau d'administration en jeu (ouvert depuis le menu Échap, réservé aux admins)
// ---------------------------------------------------------------------------
// Ce fichier ne fait QU'AFFICHER et envoyer des demandes : le serveur (voir
// admin-tools.js) revérifie à chaque commande que le compte est administrateur,
// donc masquer ou modifier ce panneau dans le navigateur ne donne aucun pouvoir.
//
// Sanctions : elles s'écrivent directement dans Firestore avec admin.js, comme
// dans les paramètres (seuls les admins ont le droit, voir firestore.rules). Le
// joueur sanctionné est déconnecté tout de suite par son propre écran de sanction
// ET par le serveur (expulsion envoyée en même temps).
// ---------------------------------------------------------------------------
import { WEAPON_DEFS, WEAPON_ORDER } from './weapons.js';
import {
  applySanction,
  liftSanction,
  listenAllSanctions,
  loadAllUsers,
  isSanctionActive,
  formatRemaining,
} from './admin.js';

const RARITIES = [
  { id: 'gray', label: 'Gris' },
  { id: 'blue', label: 'Bleu' },
  { id: 'red', label: 'Rouge' },
];

// Modes activables sur un joueur (nom envoyé au serveur -> libellé)
const MODES = [
  ['godmode', 'Insensible aux balles', 'Aucun dégât, balles, grenades et explosions comprises.'],
  ['noclip', 'Traverser les murs', 'Passe à travers murs et caisses (reste au sol).'],
  ['fly', 'Vol', 'Pas de gravité : Espace monte, la touche accroupi descend.'],
  ['invisible', 'Invisible', 'Les autres ne le voient plus et leurs balles passent à travers.'],
  ['infiniteAmmo', 'Munitions illimitées', 'Le chargeur ne se vide jamais.'],
  ['oneShot', 'Tue en un tir', 'Chaque balle touchée tue, bouclier compris.'],
  ['frozen', 'Immobilisé', 'Le joueur ne peut plus bouger.'],
];

const TIME_PRESETS = [
  ['Aube', 0.01],
  ['Matin', 0.12],
  ['Midi', 0.31],
  ['Après-midi', 0.5],
  ['Coucher', 0.6],
  ['Crépuscule', 0.67],
  ['Nuit', 0.8],
  ['Cycle normal', null],
];

const STYLE = `
#game-admin-panel{position:fixed;inset:0;z-index:1800;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);font-family:system-ui,sans-serif;color:#eceef2}
#game-admin-panel[hidden]{display:none}
#game-admin-panel *{box-sizing:border-box}
.ga-window{width:min(1120px,96vw);height:min(760px,92vh);background:#14151a;border:1px solid rgba(255,255,255,.14);border-radius:12px;display:grid;grid-template-rows:auto 1fr;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.ga-header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.1);background:#1b1c23}
.ga-header h2{margin:0;font-size:1.05rem;letter-spacing:.5px}
.ga-badge{background:#e63946;color:#fff;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:999px;letter-spacing:1px}
.ga-toast{flex:1;font-size:.85rem;min-height:1.2em;opacity:0;transition:opacity .2s}
.ga-toast.show{opacity:1}.ga-toast.ok{color:#7fe08a}.ga-toast.err{color:#ff7b7b}
.ga-close{background:none;border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}
.ga-body{display:grid;grid-template-columns:270px 1fr;min-height:0}
.ga-side{border-right:1px solid rgba(255,255,255,.1);display:flex;flex-direction:column;min-height:0}
.ga-side input{margin:10px;padding:7px 9px;background:#0e0f13;border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:6px}
.ga-players{overflow:auto;flex:1;padding:0 6px 8px}
.ga-player{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;color:#fff;border-radius:7px;padding:7px 9px;cursor:pointer;margin-bottom:2px}
.ga-player:hover{background:rgba(255,255,255,.06)}
.ga-player.sel{background:rgba(230,57,70,.18);border-color:rgba(230,57,70,.6)}
.ga-player.dead .ga-name{opacity:.55;text-decoration:line-through}
.ga-name{font-weight:600}.ga-sub{font-size:.72rem;opacity:.65;margin-top:2px}
.ga-tag{display:inline-block;font-size:.62rem;padding:1px 5px;border-radius:4px;margin-left:5px;background:rgba(255,255,255,.14);vertical-align:middle}
.ga-tag.admin{background:#e63946}.ga-tag.mode{background:#3a6ea5}
.ga-main{display:flex;flex-direction:column;min-height:0}
.ga-tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid rgba(255,255,255,.1);flex-wrap:wrap}
.ga-tab{background:none;border:none;color:#aeb3bd;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;font-size:.88rem}
.ga-tab.active{color:#fff;border-bottom-color:#e63946}
.ga-content{overflow:auto;padding:14px 16px;flex:1}
.ga-section{margin-bottom:16px;padding-bottom:14px;border-bottom:1px dashed rgba(255,255,255,.1)}
.ga-section:last-child{border:none}
.ga-section h3{margin:0 0 8px;font-size:.78rem;text-transform:uppercase;letter-spacing:1px;color:#9aa0ac}
.ga-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.ga-content input,.ga-content select{background:#0e0f13;border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:6px;padding:6px 8px;font:inherit;font-size:.88rem}
.ga-content input[type=number]{width:110px}.ga-content input.wide{flex:1;min-width:160px}
.ga-btn{background:#262833;border:1px solid rgba(255,255,255,.14);color:#fff;border-radius:6px;padding:6px 11px;cursor:pointer;font:inherit;font-size:.86rem}
.ga-btn:hover{background:#31343f}.ga-btn.danger{background:#6b1d24;border-color:#a8333d}.ga-btn.danger:hover{background:#852630}
.ga-btn.good{background:#1f5a32;border-color:#2f8a4c}.ga-btn:disabled{opacity:.4;cursor:not-allowed}
.ga-info{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-bottom:12px}
.ga-info div{background:#0e0f13;border-radius:6px;padding:6px 9px;font-size:.82rem}.ga-info b{display:block;font-size:.68rem;color:#8e94a0;font-weight:600;text-transform:uppercase}
.ga-modes{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.ga-mode{display:flex;gap:10px;align-items:flex-start;background:#0e0f13;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:9px 11px;cursor:pointer}
.ga-mode.on{border-color:#2f8a4c;background:#12261a}.ga-mode small{display:block;opacity:.6;font-size:.72rem;margin-top:2px}
.ga-warn{background:#3a2a10;border:1px solid #8a6a20;color:#ffd98a;border-radius:7px;padding:8px 11px;font-size:.84rem;margin-bottom:12px}
.ga-empty{opacity:.55;padding:18px 4px}
.ga-table{width:100%;border-collapse:collapse;font-size:.82rem}.ga-table td,.ga-table th{padding:5px 7px;border-bottom:1px solid rgba(255,255,255,.07);text-align:left}
.ga-table th{color:#8e94a0;font-size:.7rem;text-transform:uppercase}.ga-ko{color:#ff7b7b}
.ga-list{max-height:240px;overflow:auto;border:1px solid rgba(255,255,255,.1);border-radius:7px}
.ga-list .ga-player{border-radius:0;margin:0}
@media(max-width:760px){.ga-body{grid-template-columns:1fr;grid-template-rows:200px 1fr}.ga-side{border-right:none;border-bottom:1px solid rgba(255,255,255,.1)}}
`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

export function initGameAdminPanel({ sendAction, refreshPlayers, requestJournal, getMyId = () => null } = {}) {
  // --- État ----------------------------------------------------------------
  let isAdmin = false;
  let me = null; // { uid, pseudo } du compte connecté
  let players = [];
  let selectedId = null;
  let timeOverride = null;
  let activeTab = 'player';
  let poll = null;
  let journal = [];
  let toastTimer = null;
  // Sanctions (Firestore)
  let sanctions = new Map();
  let sanctionsUnsub = null;
  let accounts = [];
  let accountsLoaded = false;
  let sanctionTarget = null; // { uid, pseudo, isAdmin }
  let tick = null;

  // --- Squelette -------------------------------------------------------------
  const style = el('style', { text: STYLE });
  const toast = el('div', { class: 'ga-toast' });
  const closeButton = el('button', { class: 'ga-close', text: 'Fermer (Échap)', onclick: () => close() });
  const search = el('input', { type: 'search', placeholder: 'Chercher un joueur…', oninput: () => renderList() });
  const listEl = el('div', { class: 'ga-players' });
  const tabsEl = el('div', { class: 'ga-tabs' });
  const contentEl = el('div', { class: 'ga-content' });
  const root = el(
    'div',
    { id: 'game-admin-panel', hidden: true },
    el(
      'div',
      { class: 'ga-window', role: 'dialog', 'aria-label': 'Panneau administrateur' },
      el('div', { class: 'ga-header' }, el('h2', { text: 'Panneau administrateur' }), el('span', { class: 'ga-badge', text: 'ADMIN' }), toast, closeButton),
      el(
        'div',
        { class: 'ga-body' },
        el('div', { class: 'ga-side' }, search, listEl, el('div', { style: 'padding:0 10px 10px' }, el('button', { class: 'ga-btn', text: 'Actualiser', onclick: () => refreshPlayers?.() }))),
        el('div', { class: 'ga-main' }, tabsEl, contentEl)
      )
    )
  );
  document.head.appendChild(style);
  document.body.appendChild(root);

  // Taper dans un champ du panneau ne doit JAMAIS déclencher les touches du jeu
  // (M = carte, B = boutique, ZQSD...). Échap reste transmis pour fermer le panneau.
  ['keydown', 'keyup', 'keypress'].forEach((type) => {
    root.addEventListener(type, (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
  });

  // --- Utilitaires -------------------------------------------------------------
  const selected = () => players.find((p) => p.id === selectedId) || null;
  const isSelf = (p) => p && p.id === getMyId();
  const locked = (p) => Boolean(p && p.isAdmin && !isSelf(p)); // un autre admin : intouchable

  function showResult(result) {
    if (!result) return;
    toast.textContent = result.message || '';
    toast.className = `ga-toast show ${result.ok ? 'ok' : 'err'}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
  }

  function act(action, extra = {}, { target = true, confirmText = null } = {}) {
    if (confirmText && !window.confirm(confirmText)) return;
    const payload = { action, ...extra };
    if (target) {
      if (!selectedId) {
        showResult({ ok: false, message: 'Choisis d\'abord un joueur dans la liste.' });
        return;
      }
      payload.targetId = selectedId;
    }
    sendAction?.(payload);
  }

  const button = (label, onclick, cls = '') => el('button', { class: `ga-btn ${cls}`.trim(), text: label, onclick });
  const num = (value, extra = {}) => el('input', { type: 'number', value, ...extra });

  // --- Liste des joueurs --------------------------------------------------------
  function renderList() {
    const needle = search.value.trim().toLowerCase();
    listEl.replaceChildren();
    const shown = players.filter((p) => p.pseudo.toLowerCase().includes(needle));
    if (shown.length === 0) listEl.append(el('div', { class: 'ga-empty', text: players.length ? 'Aucun résultat.' : 'Aucun joueur connecté.' }));
    shown.forEach((p) => {
      const activeModes = Object.entries(p.flags || {}).filter(([k, v]) => k !== 'speed' && v).length;
      listEl.append(
        el(
          'button',
          { class: `ga-player${p.id === selectedId ? ' sel' : ''}${p.alive ? '' : ' dead'}`, onclick: () => selectPlayer(p.id) },
          el('div', {}, el('span', { class: 'ga-name', text: p.pseudo }), isSelf(p) ? el('span', { class: 'ga-tag', text: 'toi' }) : null, p.isAdmin ? el('span', { class: 'ga-tag admin', text: 'admin' }) : null, activeModes ? el('span', { class: 'ga-tag mode', text: `${activeModes} mode${activeModes > 1 ? 's' : ''}` }) : null),
          el('div', { class: 'ga-sub', text: `${p.alive ? `${Math.round(p.hp)} PV` : 'mort'} · ${p.money} € · ${p.kills}/${p.deaths}` })
        )
      );
    });
  }

  function selectPlayer(id) {
    selectedId = id;
    renderList();
    buildTab();
  }

  // --- Onglets --------------------------------------------------------------------
  const TABS = [
    ['player', 'Joueur'],
    ['gear', 'Armes & équipement'],
    ['modes', 'Modes'],
    ['sanctions', 'Sanctions'],
    ['game', 'Toute la partie'],
    ['journal', 'Journal'],
  ];

  function renderTabs() {
    tabsEl.replaceChildren(
      ...TABS.map(([id, label]) =>
        el('button', {
          class: `ga-tab${id === activeTab ? ' active' : ''}`,
          text: label,
          onclick: () => {
            activeTab = id;
            renderTabs();
            buildTab();
          },
        })
      )
    );
  }

  // Chaque constructeur d'onglet renvoie une fonction `update` rappelée à chaque
  // rafraîchissement de la liste : elle met à jour les valeurs affichées SANS
  // reconstruire les champs (sinon on perdrait ce que l'admin est en train de taper).
  let updateTab = () => {};
  let builtKey = null; // ce pour quoi le contenu affiché a été construit (voir tabKey)

  const TABS_NEEDING_PLAYER = ['player', 'gear', 'modes'];
  // Le contenu doit être reconstruit quand l'onglet, le joueur choisi, ou le fait
  // qu'il existe / soit intouchable change ; sinon on se contente de le mettre à jour.
  function tabKey() {
    if (!TABS_NEEDING_PLAYER.includes(activeTab)) return activeTab;
    const p = selected();
    return `${activeTab}:${selectedId}:${p ? (locked(p) ? 'locked' : 'ok') : 'none'}`;
  }

  function buildTab() {
    contentEl.replaceChildren();
    updateTab = () => {};
    builtKey = tabKey();
    const needsPlayer = TABS_NEEDING_PLAYER.includes(activeTab);
    const p = selected();
    if (needsPlayer && !p) {
      contentEl.append(el('div', { class: 'ga-empty', text: 'Choisis un joueur dans la liste de gauche.' }));
      return;
    }
    if (needsPlayer && locked(p)) {
      contentEl.append(el('div', { class: 'ga-warn', text: `${p.pseudo} est administrateur : on ne peut pas agir sur lui (seulement sur toi-même).` }));
      return;
    }
    const builders = { player: buildPlayerTab, gear: buildGearTab, modes: buildModesTab, sanctions: buildSanctionsTab, game: buildGameTab, journal: buildJournalTab };
    updateTab = builders[activeTab]?.() || (() => {});
    updateTab();
  }

  // --- Onglet Joueur --------------------------------------------------------------
  function buildPlayerTab() {
    const cells = {};
    const info = el('div', { class: 'ga-info' });
    [['uid', 'Compte'], ['team', 'Équipe'], ['hp', 'Vie'], ['money', 'Argent'], ['score', 'Éliminations / morts'], ['pos', 'Position']].forEach(([key, label]) => {
      cells[key] = el('div', {}, el('b', { text: label }), el('span'));
      info.append(cells[key]);
    });
    const money = num(100, { min: 0, step: 50 });
    const hp = num(100, { min: 1, max: 100 });
    const tx = num(0, { placeholder: 'x', min: -80, max: 80, step: 1 });
    const tz = num(0, { placeholder: 'z', min: -80, max: 80, step: 1 });
    const msg = el('input', { class: 'wide', placeholder: 'Message privé au joueur…', maxlength: 200 });
    const reason = el('input', { class: 'wide', placeholder: 'Motif (affiché au joueur)…', maxlength: 120 });

    contentEl.append(
      info,
      el('div', { class: 'ga-section' }, el('h3', { text: 'Argent' }), el('div', { class: 'ga-row' }, money, button('Donner', () => act('give-money', { amount: Number(money.value) }), 'good'), button('Retirer', () => act('take-money', { amount: Number(money.value) })), button('Fixer à', () => act('set-money', { amount: Number(money.value) })))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Santé et vie' }), el('div', { class: 'ga-row' }, button('Soigner', () => act('heal'), 'good'), button('Bouclier plein', () => act('set-shield'), 'good'), hp, button('Fixer les PV', () => act('set-hp', { value: Number(hp.value) }))), el('div', { class: 'ga-row' }, button('Éliminer', () => act('kill', {}, { confirmText: `Éliminer ${selected()?.pseudo} ?` }), 'danger'), button('Ressusciter', () => act('revive'), 'good'), button('Remettre son score à zéro', () => act('reset-stats')))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Téléportation' }), el('div', { class: 'ga-row' }, button('Amener à moi', () => act('bring')), button('Aller vers lui', () => act('goto')), button('Point de départ', () => act('tp-spawn'))), el('div', { class: 'ga-row' }, tx, tz, button('Téléporter ici (x, z)', () => act('tp-coords', { x: Number(tx.value), z: Number(tz.value) })))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Message et expulsion' }), el('div', { class: 'ga-row' }, msg, button('Envoyer', () => { act('message', { text: msg.value }); msg.value = ''; })), el('div', { class: 'ga-row' }, reason, button('Expulser de la partie', () => act('kick', { reason: reason.value }, { confirmText: `Expulser ${selected()?.pseudo} de la partie ?` }), 'danger')))
    );

    return () => {
      const p = selected();
      if (!p) return;
      cells.uid.lastChild.textContent = p.uid || '—';
      cells.team.lastChild.textContent = `${p.team || '—'} (${p.mode || '—'})`;
      cells.hp.lastChild.textContent = p.alive ? `${Math.round(p.hp)} PV · bouclier ${Math.round(p.shield)}` : 'mort';
      cells.money.lastChild.textContent = `${p.money} €`;
      cells.score.lastChild.textContent = `${p.kills} / ${p.deaths}`;
      cells.pos.lastChild.textContent = p.position ? `x ${p.position.x.toFixed(0)} · z ${p.position.z.toFixed(0)}` : '—';
    };
  }

  // --- Onglet Armes & équipement -----------------------------------------------------
  function buildGearTab() {
    const weapon = el('select', {}, ...WEAPON_ORDER.map((id) => el('option', { value: id, text: WEAPON_DEFS[id].name })));
    const rarity = el('select', {}, ...RARITIES.map((r) => el('option', { value: r.id, text: r.label })));
    const slots = el('div', { class: 'ga-info' });
    const vests = num(2, { min: 0, max: 5 });
    const vestSlots = num(3, { min: 2, max: 5 });
    const nades = el('select', {}, el('option', { value: 'frag', text: 'Grenades' }), el('option', { value: 'smoke', text: 'Fumigènes' }));
    const nadesCount = num(2, { min: 0, max: 9 });
    const status = el('div', { class: 'ga-sub' });

    contentEl.append(
      el('div', { class: 'ga-section' }, el('h3', { text: 'Armes' }), slots, el('div', { class: 'ga-row' }, weapon, rarity, button('Donner', () => act('give-weapon', { weaponId: weapon.value, rarity: rarity.value }), 'good'), button('Déposer au sol près de lui', () => act('spawn-pickup', { weaponId: weapon.value, rarity: rarity.value }))), el('div', { class: 'ga-row' }, button('Recharger tous ses chargeurs', () => act('refill-ammo'), 'good'), button('Retirer l\'arme choisie', () => act('remove-weapon', { weaponId: weapon.value })))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Gilets et bouclier' }), status, el('div', { class: 'ga-row' }, vests, button('Fixer le stock de gilets', () => act('give-vests', { count: Number(vests.value) })), vestSlots, button('Fixer les emplacements', () => act('unlock-vest-slot', { slots: Number(vestSlots.value) })), button('Bouclier plein', () => act('set-shield'), 'good'))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Grenades' }), el('div', { class: 'ga-row' }, nades, nadesCount, button('Fixer le stock', () => act('give-grenades', { kind: nades.value, count: Number(nadesCount.value) }))))
    );

    return () => {
      const p = selected();
      if (!p) return;
      slots.replaceChildren(
        ...[0, 1].map((slot) => {
          const w = p.weapons?.[slot];
          return el('div', {}, el('b', { text: `Emplacement ${slot + 1}` }), w ? `${WEAPON_DEFS[w.id]?.name || w.id} · ${w.rarity} · ${w.ammo}/${WEAPON_DEFS[w.id]?.magSize}` : 'vide', el('div', { style: 'margin-top:5px' }, w ? button('Retirer', () => act('remove-weapon', { slot })) : null));
        })
      );
      status.textContent = `Gilets en stock : ${p.vestCount}/${p.maxVestSlots} · bouclier ${Math.round(p.shield)} · grenades ${p.grenades?.frag ?? 0} · fumigènes ${p.grenades?.smoke ?? 0}`;
    };
  }

  // --- Onglet Modes --------------------------------------------------------------------
  function buildModesTab() {
    const boxes = {};
    const grid = el('div', { class: 'ga-modes' });
    MODES.forEach(([flag, label, hint]) => {
      const box = el('input', { type: 'checkbox' });
      box.addEventListener('change', () => act('set-flag', { flag, value: box.checked }));
      boxes[flag] = box;
      const card = el('label', { class: 'ga-mode' }, box, el('span', {}, el('b', { text: label }), el('small', { text: hint })));
      boxes[flag].card = card;
      grid.append(card);
    });
    const speed = el('select', {}, ...[0.5, 1, 1.5, 2, 3, 4, 5].map((v) => el('option', { value: v, text: `×${v}` })));
    speed.addEventListener('change', () => act('set-speed', { value: Number(speed.value) }));

    contentEl.append(
      el('div', { class: 'ga-section' }, el('h3', { text: 'Modes' }), grid),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Vitesse de déplacement' }), el('div', { class: 'ga-row' }, speed)),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Raccourcis' }), el('div', { class: 'ga-row' }, button('Tout activer', () => MODES.filter(([f]) => f !== 'frozen').forEach(([flag]) => act('set-flag', { flag, value: true })), 'good'), button('Tout désactiver', () => { MODES.forEach(([flag]) => act('set-flag', { flag, value: false })); act('set-speed', { value: 1 }); })))
    );

    return () => {
      const p = selected();
      if (!p) return;
      MODES.forEach(([flag]) => {
        boxes[flag].checked = Boolean(p.flags?.[flag]);
        boxes[flag].card.classList.toggle('on', Boolean(p.flags?.[flag]));
      });
      if (document.activeElement !== speed) speed.value = String(p.flags?.speed ?? 1);
    };
  }

  // --- Onglet Sanctions ------------------------------------------------------------------
  function ensureSanctionData() {
    if (!sanctionsUnsub) {
      sanctionsUnsub = listenAllSanctions((map) => {
        sanctions = map;
        if (activeTab === 'sanctions') updateTab();
      });
    }
    if (!accountsLoaded) {
      accountsLoaded = true;
      loadAllUsers()
        .then((list) => {
          accounts = list;
          if (activeTab === 'sanctions') updateTab();
        })
        .catch(() => {
          accountsLoaded = false;
        });
    }
  }

  function buildSanctionsTab() {
    ensureSanctionData();
    const filter = el('input', { class: 'wide', placeholder: 'Chercher un compte (connecté ou non)…', oninput: () => updateList() });
    const list = el('div', { class: 'ga-list' });
    const targetLine = el('div', { class: 'ga-row' });
    const kind = el('select', {}, el('option', { value: 'suspend', text: 'Suspension (temporaire)' }), el('option', { value: 'ban', text: 'Bannissement (définitif)' }));
    const amount = num(1, { min: 1, step: 1 });
    const unit = el('select', {}, el('option', { value: 60000, text: 'minutes' }), el('option', { value: 3600000, text: 'heures', selected: true }), el('option', { value: 86400000, text: 'jours' }));
    const reason = el('input', { class: 'wide', placeholder: 'Motif (affiché au joueur)…', maxlength: 200 });
    const durationRow = el('div', { class: 'ga-row' }, 'Durée :', amount, unit);
    const apply = button('Appliquer la sanction', async () => {
      if (!sanctionTarget) return showResult({ ok: false, message: 'Choisis un compte.' });
      if (sanctionTarget.isAdmin) return showResult({ ok: false, message: 'On ne sanctionne pas un administrateur.' });
      const isBan = kind.value === 'ban';
      const durationMs = Number(amount.value) * Number(unit.value);
      const label = isBan ? 'BANNIR définitivement' : `suspendre ${amount.value} ${unit.selectedOptions[0].text}`;
      if (!window.confirm(`${label} ${sanctionTarget.pseudo} ?`)) return;
      try {
        await applySanction({ target: sanctionTarget, admin: me, kind: kind.value, durationMs, reason: reason.value });
        showResult({ ok: true, message: `${sanctionTarget.pseudo} sanctionné.` });
        // Expulsion immédiate si le joueur est en ligne (son écran de sanction le coupera aussi)
        const online = players.find((p) => p.uid === sanctionTarget.uid);
        if (online) sendAction?.({ action: 'kick', targetId: online.id, reason: isBan ? 'Compte banni.' : 'Compte suspendu.' });
        reason.value = '';
      } catch (error) {
        showResult({ ok: false, message: error.message || 'Sanction impossible (droits insuffisants ?).' });
      }
    }, 'danger');
    const lift = button('Lever la sanction', async () => {
      if (!sanctionTarget) return;
      try {
        await liftSanction(sanctionTarget.uid);
        showResult({ ok: true, message: `Sanction de ${sanctionTarget.pseudo} levée.` });
      } catch (error) {
        showResult({ ok: false, message: error.message || 'Impossible de lever la sanction.' });
      }
    }, 'good');
    const current = el('div', { class: 'ga-sub' });
    const activeList = el('div');

    function candidates() {
      // Joueurs connectés d'abord (avec leur compte), puis tous les comptes
      const seen = new Set();
      const out = [];
      players.forEach((p) => {
        if (!p.uid) return;
        seen.add(p.uid);
        out.push({ uid: p.uid, pseudo: p.pseudo, isAdmin: p.isAdmin, online: true });
      });
      accounts.forEach((a) => {
        if (!seen.has(a.uid)) out.push({ uid: a.uid, pseudo: a.pseudo, isAdmin: a.admin, online: false });
      });
      return out;
    }

    function updateList() {
      const needle = filter.value.trim().toLowerCase();
      const rows = candidates().filter((c) => c.pseudo.toLowerCase().includes(needle)).slice(0, 80);
      list.replaceChildren(
        ...(rows.length
          ? rows.map((c) => {
              const s = sanctions.get(c.uid);
              const active = isSanctionActive(s);
              return el('button', { class: `ga-player${sanctionTarget?.uid === c.uid ? ' sel' : ''}`, onclick: () => { sanctionTarget = c; updateTab(); } }, el('span', { class: 'ga-name', text: c.pseudo }), c.online ? el('span', { class: 'ga-tag mode', text: 'en ligne' }) : null, c.isAdmin ? el('span', { class: 'ga-tag admin', text: 'admin' }) : null, active ? el('span', { class: 'ga-tag admin', text: s.type === 'ban' ? 'banni' : 'suspendu' }) : null);
            })
          : [el('div', { class: 'ga-empty', text: accountsLoaded ? 'Aucun compte trouvé.' : 'Chargement…' })])
      );
    }

    function updateActive() {
      const rows = Array.from(sanctions.values()).filter((s) => isSanctionActive(s));
      activeList.replaceChildren(
        rows.length
          ? el('table', { class: 'ga-table' }, el('tr', {}, el('th', { text: 'Joueur' }), el('th', { text: 'Type' }), el('th', { text: 'Reste' }), el('th', { text: 'Motif' }), el('th')), ...rows.map((s) => el('tr', {}, el('td', { text: s.targetPseudo }), el('td', { text: s.type === 'ban' ? 'Ban' : 'Suspension' }), el('td', { text: s.type === 'ban' ? 'définitif' : formatRemaining(s.endsAt - Date.now()) }), el('td', { text: s.reason || '—' }), el('td', {}, button('Lever', () => liftSanction(s.uid).then(() => showResult({ ok: true, message: 'Sanction levée.' })).catch((e) => showResult({ ok: false, message: e.message })))))))
          : el('div', { class: 'ga-empty', text: 'Aucune sanction en cours.' })
      );
    }

    contentEl.append(
      el('div', { class: 'ga-section' }, el('h3', { text: '1. Choisir le compte' }), el('div', { class: 'ga-row' }, filter, button('Joueur sélectionné', () => { const p = selected(); if (p?.uid) { sanctionTarget = { uid: p.uid, pseudo: p.pseudo, isAdmin: p.isAdmin }; updateTab(); } })), list),
      el('div', { class: 'ga-section' }, el('h3', { text: '2. Sanction' }), targetLine, current, el('div', { class: 'ga-row' }, kind), durationRow, el('div', { class: 'ga-row' }, reason), el('div', { class: 'ga-row' }, apply, lift)),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Sanctions en cours' }), activeList)
    );
    kind.addEventListener('change', () => { durationRow.style.display = kind.value === 'ban' ? 'none' : ''; });

    return () => {
      // Un compte sélectionné dans la liste des joueurs devient la cible par défaut
      if (!sanctionTarget) {
        const p = selected();
        if (p?.uid) sanctionTarget = { uid: p.uid, pseudo: p.pseudo, isAdmin: p.isAdmin };
      }
      targetLine.replaceChildren(sanctionTarget ? el('b', { text: sanctionTarget.pseudo }) : el('span', { class: 'ga-empty', text: 'Aucun compte choisi.' }));
      const s = sanctionTarget ? sanctions.get(sanctionTarget.uid) : null;
      current.textContent = s && isSanctionActive(s) ? `Sanction en cours : ${s.type === 'ban' ? 'bannissement' : `suspension (reste ${formatRemaining(s.endsAt - Date.now())})`}${s.reason ? ` — ${s.reason}` : ''}` : sanctionTarget ? 'Aucune sanction en cours sur ce compte.' : '';
      apply.disabled = !sanctionTarget || sanctionTarget.isAdmin;
      lift.disabled = !s || !isSanctionActive(s);
      updateList();
      updateActive();
    };
  }

  // --- Onglet Toute la partie --------------------------------------------------------------
  function buildGameTab() {
    const text = el('input', { class: 'wide', placeholder: 'Annonce affichée à tous les joueurs…', maxlength: 200 });
    const phase = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.31, style: 'width:220px' });
    const phaseLabel = el('span', { class: 'ga-sub', text: '0.31' });
    phase.addEventListener('input', () => { phaseLabel.textContent = Number(phase.value).toFixed(2); });
    const money = num(100, { min: 1, step: 50 });
    const reason = el('input', { class: 'wide', placeholder: 'Motif de l\'expulsion générale…', maxlength: 120 });
    const timeStatus = el('div', { class: 'ga-sub' });
    const g = (action, extra, confirmText) => () => act(action, extra, { target: false, confirmText });

    contentEl.append(
      el('div', { class: 'ga-section' }, el('h3', { text: 'Annonce' }), el('div', { class: 'ga-row' }, text, button('Annoncer', () => { act('announce', { text: text.value }, { target: false }); text.value = ''; }, 'good'))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Heure du jour (pour tout le monde)' }), timeStatus, el('div', { class: 'ga-row' }, ...TIME_PRESETS.map(([label, value]) => button(label, g('set-time', { phase: value })))), el('div', { class: 'ga-row' }, phase, phaseLabel, button('Imposer cette heure', () => act('set-time', { phase: Number(phase.value) }, { target: false })))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Joueurs' }), el('div', { class: 'ga-row' }, button('Soigner tout le monde', g('heal-all'), 'good'), button('Ressusciter tout le monde', g('revive-all'), 'good'), button('Recharger toutes les armes', g('refill-ammo-all'), 'good')), el('div', { class: 'ga-row' }, money, button('Donner cet argent à tous', () => act('money-all', { amount: Number(money.value) }, { target: false }), 'good')), el('div', { class: 'ga-row' }, button('Immobiliser tous les joueurs', g('freeze-all', { value: true })), button('Libérer tous les joueurs', g('freeze-all', { value: false })))),
      el('div', { class: 'ga-section' }, el('h3', { text: 'Zone de danger (les admins ne sont jamais touchés)' }), el('div', { class: 'ga-row' }, button('Éliminer tous les joueurs', g('kill-all', {}, 'Éliminer TOUS les joueurs ?'), 'danger'), button('Supprimer tous les objets au sol', g('clear-loot', {}, 'Supprimer tous les objets au sol ?'), 'danger'), button('Remettre les scores à zéro', g('reset-scores', {}, 'Remettre tous les scores à zéro ?'), 'danger')), el('div', { class: 'ga-row' }, reason, button('Expulser tous les joueurs', () => act('kick-all', { reason: reason.value }, { target: false, confirmText: 'Expulser TOUS les joueurs de la partie ?' }), 'danger')))
    );

    return () => {
      timeStatus.textContent = timeOverride === null ? 'Heure actuelle : cycle normal.' : `Heure imposée : ${Number(timeOverride).toFixed(2)} (0 = aube, 0,31 = midi, 0,62 = coucher, 0,8 = nuit).`;
    };
  }

  // --- Onglet Journal -------------------------------------------------------------------------
  function buildJournalTab() {
    const body = el('div');
    contentEl.append(el('div', { class: 'ga-row' }, button('Actualiser', () => requestJournal?.()), el('span', { class: 'ga-sub', text: 'Les 100 dernières commandes admin (effacé au redémarrage du serveur).' })), body);
    requestJournal?.();
    return () => {
      body.replaceChildren(
        journal.length
          ? el('table', { class: 'ga-table' }, el('tr', {}, el('th', { text: 'Heure' }), el('th', { text: 'Admin' }), el('th', { text: 'Commande' }), el('th', { text: 'Cible' }), el('th', { text: 'Détail' })), ...journal.map((e) => el('tr', {}, el('td', { text: new Date(e.t).toLocaleTimeString('fr-FR') }), el('td', { text: e.admin }), el('td', { class: e.ok ? '' : 'ga-ko', text: e.ok ? e.action : `${e.action} (refusé)` }), el('td', { text: e.target || '—' }), el('td', { text: String(e.detail ?? '') }))))
          : el('div', { class: 'ga-empty', text: 'Aucune commande pour le moment.' })
      );
    };
  }

  // --- Ouverture / fermeture --------------------------------------------------------------------
  function open() {
    if (!isAdmin) return;
    root.hidden = false;
    if (!selectedId) selectedId = getMyId();
    renderTabs();
    renderList();
    buildTab();
    refreshPlayers?.();
    clearInterval(poll);
    poll = setInterval(() => refreshPlayers?.(), 1500);
    clearInterval(tick);
    tick = setInterval(() => { if (activeTab === 'sanctions') updateTab(); }, 1000);
  }

  function close() {
    root.hidden = true;
    clearInterval(poll);
    clearInterval(tick);
    poll = null;
    tick = null;
  }

  return {
    // Appelé à chaque changement du compte connecté / de son droit admin
    setAdmin(value, user = null) {
      isAdmin = Boolean(value);
      me = user;
      if (!isAdmin) {
        close();
        players = [];
        selectedId = null;
        sanctionsUnsub?.();
        sanctionsUnsub = null;
        accountsLoaded = false;
        accounts = [];
        sanctionTarget = null;
      }
    },
    open,
    close,
    isOpen: () => !root.hidden,
    // data : { players, timeOverride } envoyé par le serveur
    setPlayers(data) {
      const list = Array.isArray(data) ? data : data?.players || [];
      players = list;
      if (!Array.isArray(data) && data && 'timeOverride' in data) timeOverride = data.timeOverride;
      if (selectedId && !players.some((p) => p.id === selectedId)) selectedId = null;
      if (root.hidden) return;
      renderList();
      if (tabKey() !== builtKey) buildTab();
      else updateTab();
    },
    showResult,
    setJournal(entries) {
      journal = Array.isArray(entries) ? entries : [];
      if (activeTab === 'journal' && !root.hidden) updateTab();
    },
  };
}
