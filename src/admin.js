// ---------------------------------------------------------------------------
// Administration : bannir / suspendre des joueurs
// ---------------------------------------------------------------------------
// Qui est admin ? Le doc users/{uid} contient un champ `admin` ("true", en
// texte, comme posé à la main dans la console Firebase — le vrai booléen true
// est accepté aussi). Il ne peut être posé QUE depuis la console : les règles
// Firestore interdisent à un joueur de modifier ce champ sur son propre
// profil (voir firestore.rules), sinon n'importe qui se ferait admin.
//
// Les sanctions vivent dans sanctions/{uid} (un seul doc par joueur sanctionné) :
//   { type: 'ban' | 'suspend', durationMs (suspension seulement), reason,
//     targetPseudo, byUid, byPseudo, createdAt }
// La fin d'une suspension = createdAt (horloge du SERVEUR) + durationMs — pas
// une date calculée sur l'ordinateur de l'admin, qui pourrait être décalé.
// Lever une sanction = supprimer le doc.
//
// Ce que ça garantit vraiment : l'interface du joueur sanctionné est bloquée
// (écran plein écran, déconnexion de la partie) et il ne peut plus écrire de
// messages (règles Firestore). Ce que ça NE garantit PAS : quelqu'un qui
// modifierait lui-même le code de son navigateur pourrait contourner l'écran,
// et le serveur de jeu (Socket.io) ne connaît pas Firebase, donc ne peut pas
// refuser une connexion directe. Pour un bannissement vraiment étanche, il
// faudrait que le serveur de jeu vérifie le compte avec Firebase Admin.
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from './firebase.js';

const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000; // même plafond que firestore.rules
const MAX_USERS_LISTED = 300;

// --- Données ---------------------------------------------------------------------
export function isAdminData(data) {
  return String(data?.admin).toLowerCase() === 'true';
}

export function listenIsAdmin(uid, callback) {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => callback(isAdminData(snap.data())),
    () => callback(false)
  );
}

// Un doc de sanction -> objet simple, ou null. `endsAt` vaut Infinity pour un ban.
function readSanction(snap) {
  if (!snap.exists()) return null;
  const d = snap.data({ serverTimestamps: 'estimate' });
  if (d.type !== 'ban' && d.type !== 'suspend') return null;
  const createdMs = d.createdAt?.toMillis?.() ?? Date.now();
  const durationMs = Number(d.durationMs) || 0;
  return {
    uid: snap.id,
    type: d.type,
    reason: typeof d.reason === 'string' ? d.reason : '',
    targetPseudo: d.targetPseudo || '?',
    byPseudo: d.byPseudo || '?',
    createdMs,
    durationMs,
    endsAt: d.type === 'ban' ? Infinity : createdMs + durationMs,
  };
}

export function isSanctionActive(sanction, now = Date.now()) {
  return Boolean(sanction) && sanction.endsAt > now;
}

export function listenOwnSanction(uid, callback) {
  return onSnapshot(
    doc(db, 'sanctions', uid),
    (snap) => callback(readSanction(snap)),
    () => callback(null)
  );
}

// Réservé aux admins (les règles refusent la lecture des autres sinon).
export function listenAllSanctions(callback) {
  return onSnapshot(
    collection(db, 'sanctions'),
    (snap) => {
      const map = new Map();
      snap.docs.forEach((d) => {
        const s = readSanction(d);
        if (s) map.set(s.uid, s);
      });
      callback(map);
    },
    () => callback(new Map())
  );
}

export async function loadAllUsers() {
  const snap = await getDocs(query(collection(db, 'users'), limit(MAX_USERS_LISTED)));
  return snap.docs
    .map((d) => ({ uid: d.id, pseudo: d.data().pseudo || '?', admin: isAdminData(d.data()) }))
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr'));
}

// kind : 'ban' ou 'suspend' (+ durationMs en ms pour une suspension).
export async function applySanction({ target, admin, kind, durationMs, reason }) {
  const data = {
    type: kind,
    targetPseudo: String(target.pseudo || '?').slice(0, 40),
    reason: String(reason || '').trim().slice(0, 200),
    byUid: admin.uid,
    byPseudo: String(admin.pseudo || '?').slice(0, 40),
    createdAt: serverTimestamp(),
  };
  if (kind === 'suspend') {
    const ms = Math.round(durationMs);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_DURATION_MS) {
      throw new Error('Durée invalide (de 1 seconde à 366 jours).');
    }
    data.durationMs = ms;
  }
  await setDoc(doc(db, 'sanctions', target.uid), data);
}

export async function liftSanction(uid) {
  await deleteDoc(doc(db, 'sanctions', uid));
}

// --- Texte ------------------------------------------------------------------------
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d} j ${h} h ${pad(m)} min`;
  if (h > 0) return `${h} h ${pad(m)} min ${pad(s)} s`;
  return `${pad(m)} min ${pad(s)} s`;
}

function formatEnd(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${time}`;
}

// --- Écran de blocage pour le joueur sanctionné ----------------------------------
// onBlock() est appelé quand le blocage démarre (lobby.js s'en sert pour couper
// la partie en cours). Quand la sanction prend fin (expirée ou levée par un
// admin), on recharge la page : état propre, retour au lobby.
export function initSanctionScreen({ onBlock, onLogout } = {}) {
  const screen = document.getElementById('sanction-screen');
  const titleEl = document.getElementById('sanction-title');
  const messageEl = document.getElementById('sanction-message');
  const countdownEl = document.getElementById('sanction-countdown');
  const logoutButton = document.getElementById('sanction-logout');
  if (!screen) return { set() {} };

  let current = null;
  let blocking = false;
  let tick = null;

  logoutButton?.addEventListener('click', () => onLogout?.());

  function stopTick() {
    clearInterval(tick);
    tick = null;
  }

  function render() {
    if (!current) return;
    const now = Date.now();
    if (!isSanctionActive(current, now)) {
      evaluate();
      return;
    }
    if (current.type === 'ban') {
      titleEl.textContent = 'Compte banni';
      messageEl.textContent = current.reason
        ? `Tu as été banni par un administrateur. Motif : ${current.reason}`
        : 'Tu as été banni par un administrateur.';
      countdownEl.textContent = '';
    } else {
      titleEl.textContent = 'Compte suspendu';
      messageEl.textContent = current.reason
        ? `Tu as été suspendu par un administrateur. Motif : ${current.reason}`
        : 'Tu as été suspendu par un administrateur.';
      countdownEl.textContent = `Retour possible dans ${formatRemaining(current.endsAt - now)}`;
    }
  }

  function evaluate() {
    const active = isSanctionActive(current);
    if (active) {
      if (!blocking) {
        blocking = true;
        screen.hidden = false;
        onBlock?.();
      }
      render();
      if (!tick) tick = setInterval(render, 1000);
      return;
    }
    stopTick();
    screen.hidden = true;
    if (blocking) {
      blocking = false;
      window.location.reload();
    }
  }

  return {
    // sanction = objet de listenOwnSanction, ou null (aucune / déconnexion)
    set(sanction) {
      current = sanction;
      evaluate();
    },
  };
}

// --- Panneau d'administration (onglet Paramètres, visible aux admins seulement) ---
export function initAdminPanel() {
  const section = document.getElementById('admin-section');
  const filterEl = document.getElementById('admin-user-filter');
  const refreshButton = document.getElementById('admin-refresh');
  const listEl = document.getElementById('admin-user-list');
  const formEl = document.getElementById('admin-sanction-form');
  const targetEl = document.getElementById('admin-sanction-target');
  const kindEl = document.getElementById('admin-sanction-kind');
  const customRow = document.getElementById('admin-custom-row');
  const customAmount = document.getElementById('admin-custom-amount');
  const customUnit = document.getElementById('admin-custom-unit');
  const reasonEl = document.getElementById('admin-reason');
  const cancelButton = document.getElementById('admin-cancel');
  const errorEl = document.getElementById('admin-error');
  if (!section || !listEl || !formEl) return { setAdmin() {}, setUser() {} };

  let me = null; // { uid, pseudo }
  let isAdmin = false;
  let users = [];
  let sanctions = new Map();
  let selected = null;
  let sanctionsUnsub = null;
  let tick = null;

  const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

  function setError(text) {
    errorEl.textContent = text || '';
  }

  function statusOf(uid) {
    const s = sanctions.get(uid);
    return isSanctionActive(s) ? s : null;
  }

  function renderList() {
    listEl.innerHTML = '';
    const needle = filterEl.value.trim().toLowerCase();
    const shown = users.filter((u) => u.pseudo.toLowerCase().includes(needle));
    if (shown.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = users.length === 0 ? 'Chargement…' : 'Aucun joueur trouvé.';
      listEl.appendChild(empty);
      return;
    }
    shown.forEach((user) => {
      const li = document.createElement('li');
      li.className = 'admin-user';

      const name = document.createElement('span');
      name.className = 'admin-user-name';
      name.textContent = user.pseudo;
      li.appendChild(name);

      const sanction = statusOf(user.uid);
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      if (user.admin) {
        badge.textContent = 'admin';
        badge.classList.add('admin-badge-admin');
      } else if (sanction?.type === 'ban') {
        badge.textContent = 'banni';
        badge.classList.add('admin-badge-ban');
      } else if (sanction) {
        badge.textContent = `suspendu · ${formatRemaining(sanction.endsAt - Date.now())}`;
        badge.classList.add('admin-badge-suspend');
      }
      if (badge.textContent) li.appendChild(badge);

      // Un admin ne se sanctionne pas lui-même ni un autre admin (les règles
      // Firestore le refusent aussi).
      if (!user.admin && user.uid !== me?.uid) {
        const actions = document.createElement('span');
        actions.className = 'admin-user-actions';
        const sanctionButton = document.createElement('button');
        sanctionButton.type = 'button';
        sanctionButton.textContent = 'Sanctionner';
        sanctionButton.addEventListener('click', () => selectUser(user));
        actions.appendChild(sanctionButton);
        if (sanction) {
          const liftButton = document.createElement('button');
          liftButton.type = 'button';
          liftButton.className = 'secondary';
          liftButton.textContent = 'Lever';
          liftButton.addEventListener('click', async () => {
            setError('');
            try {
              await liftSanction(user.uid);
            } catch (error) {
              setError(`Impossible de lever la sanction (${error.code || error.message}).`);
            }
          });
          actions.appendChild(liftButton);
        }
        li.appendChild(actions);
      }
      listEl.appendChild(li);
    });
  }

  function selectUser(user) {
    selected = user;
    setError('');
    targetEl.textContent = `Sanctionner : ${user.pseudo}`;
    formEl.hidden = false;
    reasonEl.value = '';
    updateCustomRow();
  }

  function closeForm() {
    selected = null;
    formEl.hidden = true;
    setError('');
  }

  function updateCustomRow() {
    customRow.hidden = kindEl.value !== 'custom';
  }

  async function loadUsers() {
    setError('');
    try {
      users = await loadAllUsers();
    } catch (error) {
      users = [];
      setError(`Impossible de charger les joueurs (${error.code || error.message}).`);
    }
    renderList();
  }

  kindEl.addEventListener('change', updateCustomRow);
  filterEl.addEventListener('input', renderList);
  refreshButton?.addEventListener('click', loadUsers);
  cancelButton?.addEventListener('click', closeForm);

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected || !me || !isAdmin) return;
    setError('');

    const kind = kindEl.value;
    let payload;
    if (kind === 'ban') {
      payload = { kind: 'ban' };
    } else if (kind === 'custom') {
      const amount = Number(customAmount.value);
      const ms = amount * (UNIT_MS[customUnit.value] || 0);
      if (!Number.isFinite(amount) || amount <= 0 || ms < 1000 || ms > MAX_DURATION_MS) {
        setError('Durée personnalisée invalide (maximum 366 jours).');
        return;
      }
      payload = { kind: 'suspend', durationMs: ms };
    } else {
      payload = { kind: 'suspend', durationMs: Number(kind) };
    }

    try {
      await applySanction({ target: selected, admin: me, reason: reasonEl.value, ...payload });
      closeForm();
    } catch (error) {
      setError(
        error.code === 'permission-denied'
          ? 'Refusé : règles Firestore à mettre à jour, ou ce compte n\u2019est pas admin.'
          : error.message || 'Sanction non appliquée.'
      );
    }
  });

  function stopWatching() {
    sanctionsUnsub?.();
    sanctionsUnsub = null;
    clearInterval(tick);
    tick = null;
  }

  return {
    setUser(user) {
      me = user ? { uid: user.uid, pseudo: user.pseudo } : null;
      if (!user) this.setAdmin(false);
    },
    setAdmin(value) {
      isAdmin = Boolean(value) && Boolean(me);
      section.hidden = !isAdmin;
      stopWatching();
      if (!isAdmin) {
        users = [];
        sanctions = new Map();
        closeForm();
        listEl.innerHTML = '';
        return;
      }
      sanctionsUnsub = listenAllSanctions((map) => {
        sanctions = map;
        renderList();
      });
      // Recompte des durées restantes affichées dans la liste.
      tick = setInterval(renderList, 15000);
      loadUsers();
    },
  };
}
