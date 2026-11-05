import { applySanction, liftSanction } from './admin.js';

const WEAPONS = [
  ['pistol', 'Pistolet'], ['smg', 'Mitraillette'], ['shotgun', 'Fusil à pompe'],
  ['rifle', 'Fusil'], ['sniper', 'Sniper'],
];

export function initGameAdminPanel({ sendAction, refreshPlayers }) {
  let admin = false;
  let opened = false;
  let players = [];
  let selectedId = '';
  let currentUser = null;
  let resultTimer = null;

  const root = document.createElement('section');
  root.id = 'game-admin-panel';
  root.hidden = true;
  root.innerHTML = `
    <div class="game-admin-card" role="dialog" aria-modal="true" aria-labelledby="game-admin-title">
      <header><div><h2 id="game-admin-title">Administration</h2><p>Commandes en temps réel · réservé aux administrateurs</p></div><button type="button" data-close aria-label="Fermer">✕</button></header>
      <label class="game-admin-field">Joueur ciblé<select data-player><option value="">Choisir un joueur…</option></select></label>
      <div class="game-admin-grid">
        <label class="game-admin-field">Montant (€)<input data-money type="number" min="1" max="1000000" step="1" value="500"></label>
        <div class="game-admin-buttons"><button data-action="give-money">Donner argent</button><button data-action="take-money" class="secondary">Retirer argent</button></div>
        <label class="game-admin-field">Arme<select data-weapon>${WEAPONS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
        <label class="game-admin-field">Rareté<select data-rarity><option value="gray">Grise</option><option value="blue">Bleue</option><option value="red">Rouge</option></select></label>
        <label class="game-admin-field">Emplacement<select data-slot><option value="0">Emplacement 1</option><option value="1">Emplacement 2</option></select></label>
        <div class="game-admin-buttons"><button data-action="give-weapon">Donner arme</button><button data-action="remove-weapon" class="secondary">Retirer arme</button></div>
        <div class="game-admin-buttons"><button data-action="kill" class="danger">Tuer le joueur</button><button data-action="godmode" class="secondary">Invincibilité : basculer</button><button data-action="noclip" class="secondary">Traverser les murs : basculer</button></div>
        <div class="game-admin-buttons"><button data-action="ban" class="danger">Bannir</button><button data-action="suspend" class="secondary">Suspendre 1 heure</button><button data-action="lift-sanction" class="secondary">Lever la sanction</button></div>
      </div>
      <p class="game-admin-status" data-status aria-live="polite"></p>
      <footer><button type="button" data-refresh class="secondary">Actualiser les joueurs</button><button type="button" data-close class="secondary">Fermer</button></footer>
    </div>`;
  document.body.appendChild(root);

  const playerSelect = root.querySelector('[data-player]');
  const status = root.querySelector('[data-status]');
  const moneyInput = root.querySelector('[data-money]');
  const weaponSelect = root.querySelector('[data-weapon]');
  const raritySelect = root.querySelector('[data-rarity]');
  const slotSelect = root.querySelector('[data-slot]');

  const style = document.createElement('style');
  style.textContent = `
    #game-admin-panel{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.78);font-family:system-ui,sans-serif;color:#fff}
    #game-admin-panel[hidden]{display:none}.game-admin-card{width:min(620px,96vw);max-height:90vh;overflow:auto;background:#111827;border:1px solid #475569;border-radius:14px;padding:20px;box-shadow:0 20px 80px #000}
    .game-admin-card header,.game-admin-card footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.game-admin-card h2{margin:0 0 4px}.game-admin-card p{margin:0;color:#aab4c5;font-size:13px}.game-admin-card header>button{background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer}
    .game-admin-field{display:flex;flex-direction:column;gap:6px;margin:16px 0;font-size:13px;color:#cbd5e1}.game-admin-field input,.game-admin-field select{width:100%;box-sizing:border-box;padding:10px;border-radius:7px;border:1px solid #475569;background:#0b1220;color:white}
    .game-admin-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px}.game-admin-buttons{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.game-admin-buttons button,.game-admin-card footer button{padding:9px 12px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}.game-admin-buttons .secondary,.game-admin-card footer .secondary{background:#374151}.game-admin-buttons .danger{background:#b91c1c}.game-admin-status{min-height:20px;margin:12px 0!important;color:#fbbf24!important}.game-admin-card footer{margin-top:12px}
    @media(max-width:560px){.game-admin-grid{grid-template-columns:1fr}.game-admin-card{padding:14px}}
  `;
  document.head.appendChild(style);

  function selectedPlayer() { return players.find((p) => p.id === selectedId) || null; }
  function renderPlayers() {
    const previous = selectedId;
    playerSelect.innerHTML = '<option value="">Choisir un joueur…</option>';
    players.forEach((player) => {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = `${player.pseudo}${player.alive ? '' : ' (éliminé)'}${player.godmode ? ' · invincible' : ''}${player.noclip ? ' · noclip' : ''} · ${player.money || 0} €`; 
      playerSelect.appendChild(option);
    });
    selectedId = players.some((p) => p.id === previous) ? previous : '';
    playerSelect.value = selectedId;
  }
  function run(action, extra = {}) {
    const target = selectedPlayer();
    if (!target) { status.textContent = 'Sélectionne un joueur.'; return; }
    sendAction({ action, targetId: target.id, ...extra });
    status.textContent = 'Commande envoyée…';
  }
  playerSelect.addEventListener('change', () => { selectedId = playerSelect.value; });
  root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
  root.querySelector('[data-refresh]').addEventListener('click', refreshPlayers);
  root.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', async () => {
    if (!admin) return;
    const action = button.dataset.action;
    const target = selectedPlayer();
    if (!target) { status.textContent = 'Sélectionne un joueur.'; return; }
    if (action === 'give-money' || action === 'take-money') {
      const amount = Number(moneyInput.value);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) { status.textContent = 'Montant invalide.'; return; }
      run(action, { amount });
    } else if (action === 'give-weapon') {
      run(action, { weaponId: weaponSelect.value, rarity: raritySelect.value, slot: Number(slotSelect.value) });
    } else if (action === 'remove-weapon') {
      run(action, { weaponId: weaponSelect.value });
    } else if (action === 'lift-sanction') {
      if (!target.uid) { status.textContent = 'Identifiant du joueur indisponible.'; return; }
      try { await liftSanction(target.uid); status.textContent = 'Sanction levée (si une sanction existait).'; }
      catch (error) { status.textContent = `Impossible de lever la sanction : ${error.message}`; }
    } else if (action === 'ban' || action === 'suspend') {
      if (!target.uid || target.isAdmin) { status.textContent = 'Ce joueur ne peut pas être sanctionné.'; return; }
      const kind = action === 'ban' ? 'ban' : 'suspend';
      if (!window.confirm(`${kind === 'ban' ? 'Bannir' : 'Suspendre pendant 1 heure'} ${target.pseudo} ?`)) return;
      try {
        await applySanction({ target: { uid: target.uid, pseudo: target.pseudo }, admin: currentUser, kind, durationMs: 60 * 60 * 1000, reason: 'Sanction appliquée depuis le jeu' });
        status.textContent = 'Sanction appliquée.';
      } catch (error) { status.textContent = `Échec de la sanction : ${error.message}`; }
    } else {
      run(action);
    }
  }));

  function open() {
    if (!admin) return;
    opened = true;
    root.hidden = false;
    status.textContent = '';
    refreshPlayers();
  }
  function close() { opened = false; root.hidden = true; }
  function setAdmin(value, user = authUser()) { admin = Boolean(value); currentUser = user; if (!admin) close(); }
  function setPlayers(list) { players = Array.isArray(list) ? list : []; renderPlayers(); }
  function showResult(result) { status.textContent = result?.message || (result?.ok ? 'Commande exécutée.' : 'Commande refusée.'); clearTimeout(resultTimer); resultTimer = setTimeout(() => { if (opened && status.textContent === (result?.message || (result?.ok ? 'Commande exécutée.' : 'Commande refusée.'))) status.textContent = ''; }, 5000); }
  return { open, close, isOpen: () => opened, setAdmin, setPlayers, showResult };
}

function authUser() { return window.__miniWarzoneAdminUser || null; }
