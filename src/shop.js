// ---------------------------------------------------------------------------
// Boutique — catalogue + écran d'achat
// ---------------------------------------------------------------------------
// Ce module NE VALIDE AUCUN ACHAT : il se contente d'afficher le catalogue et
// de prévenir main.js quand le joueur clique "Acheter" (voir onBuy dans
// initShop). C'est le serveur (mini-warzone-server/server.js) qui reste seul
// juge de ce qui est réellement débité/accordé — tout ce qui est calculé ici
// (dégâts, prix) sert uniquement à l'affichage.
//
// Pas encore de magasin physique dans la salle 3D : l'écran s'ouvre pour
// l'instant avec la touche B (voir main.js, section "Boutique"). Le jour où
// un point d'interaction est posé dans buildCustomRoom(), il suffira
// d'appeler openShop()/closeShop() depuis cette interaction de proximité à
// la place de la touche B — tout le reste (catalogue, achats, UI) est déjà
// prêt.

// 3 paliers de rareté, du plus faible au plus fort. `color` sert à la fois
// à la pastille de rareté dans l'inventaire (voir main.js) et à la teinte
// appliquée au modèle d'arme en main.
export const RARITIES = [
  { id: 'gray', label: 'Gris', color: '#9ca3af' },
  { id: 'blue', label: 'Bleu', color: '#3a86ff' },
  { id: 'red', label: 'Rouge', color: '#e63946' },
];

// Chaque palier multiplie les dégâts par 1.15 PAR RAPPORT AU PALIER
// PRÉCÉDENT (cumulatif) : gris ×1, bleu ×1.15, rouge ×1.3225 (~+32% vs gris).
// Doit rester identique à RARITY_DAMAGE_STEP dans mini-warzone-server/server.js.
const RARITY_DAMAGE_STEP = 1.15;
function rarityDamageMultiplier(rarityId) {
  const index = RARITIES.findIndex((r) => r.id === rarityId);
  return RARITY_DAMAGE_STEP ** Math.max(0, index);
}

export function rarityColor(rarityId) {
  return RARITIES.find((r) => r.id === rarityId)?.color || '#9ca3af';
}
export function rarityLabel(rarityId) {
  return RARITIES.find((r) => r.id === rarityId)?.label || 'Gris';
}

// Dégâts/prix de base (palier gris) par type d'arme. `slot` indique où
// l'achat range l'arme dans le stuff (0 = toujours le pistolet, 1 = l'unique
// emplacement partagé mitraillette/fusil). Doit rester identique à
// WEAPON_BASE / WEAPON_BASE_PRICE dans mini-warzone-server/server.js.
const WEAPON_BASE = {
  pistol: { name: 'Pistolet', baseDamage: 18, basePrice: 90, slot: 0 },
  smg: { name: 'Mitraillette', baseDamage: 10, basePrice: 80, slot: 1 },
  rifle: { name: 'Fusil', baseDamage: 16, basePrice: 110, slot: 1 },
};
// Monte plus vite que les dégâts (voir RARITY_DAMAGE_STEP) pour que le rouge
// reste un achat de fin de partie. Doit rester identique à
// RARITY_PRICE_MULTIPLIER dans mini-warzone-server/server.js.
const RARITY_PRICE_MULTIPLIER = { gray: 1, blue: 2, red: 3.5 };

const VEST_PRICE = 60;
const ABILITY_EXTRA_VEST_PRICE = 300;
// Doit rester identique à MAX_SHIELD_VESTS dans mini-warzone-server/server.js
// — c'est la limite de base, avant achat de la capacité spéciale.
export const BASE_MAX_VEST_SLOTS = 2;

function buildCatalog() {
  const items = [];

  items.push({
    id: 'vest',
    category: 'vest',
    name: 'Gilet pare-balle',
    description: "Ajoute un gilet en réserve. Clic droit sur le slot 3 en jeu pour l'activer et regagner du bouclier.",
    price: VEST_PRICE,
  });

  Object.entries(WEAPON_BASE).forEach(([weaponId, weapon]) => {
    RARITIES.forEach((rarity) => {
      // Le pistolet gris est déjà l'arme de départ gratuite : inutile de le
      // vendre, seules ses améliorations de rareté ont un intérêt.
      if (weaponId === 'pistol' && rarity.id === 'gray') return;

      const damage = Math.round(weapon.baseDamage * rarityDamageMultiplier(rarity.id));
      const price = Math.round(weapon.basePrice * RARITY_PRICE_MULTIPLIER[rarity.id]);
      items.push({
        id: `weapon:${weaponId}:${rarity.id}`,
        category: 'weapon',
        weaponId,
        rarity: rarity.id,
        slot: weapon.slot,
        name: `${weapon.name} — ${rarity.label}`,
        description:
          weapon.slot === 0
            ? 'Améliore la rareté du pistolet de départ (reste au slot 1).'
            : "Remplace l'arme du slot 2 par cette variante (même si tu en as déjà une).",
        damage,
        price,
        rarityColor: rarity.color,
      });
    });
  });

  items.push({
    id: 'ability-extra-vest-slot',
    category: 'ability',
    name: '3e emplacement de gilet',
    description:
      "Débloque un 3e gilet dans la barre de bouclier (bleue) — reste acquis pour le reste de la partie en cours, même après un respawn.",
    price: ABILITY_EXTRA_VEST_PRICE,
  });

  return items;
}

// Catalogue complet, construit une seule fois. Affiché tel quel dans
// #shop-items (voir renderShop) et utilisé par main.js pour l'affichage
// d'inventaire (rarityColor/rarityLabel).
export const SHOP_CATALOG = buildCatalog();

const CATEGORY_LABELS = { weapon: 'Armes', vest: 'Gilets', ability: 'Capacités' };

// --- État interne du module ------------------------------------------------
let shopOpen = false;
let activeCategory = 'weapon';
let lastState = { money: 0, weapons: [null, null], vestCount: 0, maxVestSlots: BASE_MAX_VEST_SLOTS };
let onBuyCallback = null;

const shopScreenEl = document.getElementById('shop-screen');
const shopMoneyEl = document.getElementById('shop-money-text');
const shopItemsEl = document.getElementById('shop-items');
const shopTabButtons = Array.from(document.querySelectorAll('[data-shop-tab]'));
const shopCloseButton = document.getElementById('shop-close-button');

export function isShopOpen() {
  return shopOpen;
}

function itemDisabledReason(item, state) {
  if (item.category === 'vest') {
    if (state.vestCount >= state.maxVestSlots) return 'Réserve pleine';
  } else if (item.category === 'ability') {
    if (state.maxVestSlots > BASE_MAX_VEST_SLOTS) return 'Déjà débloquée';
  } else if (item.category === 'weapon') {
    const equipped = state.weapons[item.slot];
    if (equipped && equipped.id === item.weaponId && equipped.rarity === item.rarity) {
      return 'Équipée';
    }
  }
  if (state.money < item.price) return 'Fonds insuffisants';
  return null;
}

function buildItemCard(item, state) {
  const card = document.createElement('div');
  card.className = 'shop-item';
  if (item.rarityColor) card.style.setProperty('--rarity-color', item.rarityColor);

  const info = document.createElement('div');
  info.className = 'shop-item-info';

  const name = document.createElement('div');
  name.className = 'shop-item-name';
  name.textContent = item.name;
  info.appendChild(name);

  const desc = document.createElement('div');
  desc.className = 'shop-item-desc';
  desc.textContent = item.description;
  info.appendChild(desc);

  if (typeof item.damage === 'number') {
    const stats = document.createElement('div');
    stats.className = 'shop-item-stats';
    stats.textContent = `${item.damage} dégâts / tir`;
    info.appendChild(stats);
  }

  card.appendChild(info);

  const buyBox = document.createElement('div');
  buyBox.className = 'shop-item-buy';

  const price = document.createElement('div');
  price.className = 'shop-item-price';
  price.textContent = `${item.price} €`;
  buyBox.appendChild(price);

  const disabledReason = itemDisabledReason(item, state);
  const button = document.createElement('button');
  button.textContent = disabledReason || 'Acheter';
  button.disabled = Boolean(disabledReason);
  button.addEventListener('click', () => onBuyCallback?.(item.id));
  buyBox.appendChild(button);

  card.appendChild(buyBox);
  return card;
}

export function renderShop(state) {
  lastState = state;
  if (shopMoneyEl) shopMoneyEl.textContent = `${state.money} €`;
  if (!shopItemsEl) return;

  shopItemsEl.innerHTML = '';
  SHOP_CATALOG.filter((item) => item.category === activeCategory).forEach((item) => {
    shopItemsEl.appendChild(buildItemCard(item, state));
  });
}

export function openShop(state) {
  shopOpen = true;
  if (shopScreenEl) shopScreenEl.hidden = false;
  renderShop(state);
}

export function closeShop() {
  shopOpen = false;
  if (shopScreenEl) shopScreenEl.hidden = true;
}

// À appeler une fois au démarrage (voir main.js). `onBuy(itemId)` est
// déclenché à chaque clic "Acheter" — main.js s'en sert pour envoyer l'achat
// au serveur (sendBuyItem). `onClose()` est déclenché par le bouton Fermer
// ou la touche Échap — main.js s'en sert pour reverrouiller le pointeur.
export function initShop({ onBuy, onClose }) {
  onBuyCallback = onBuy;

  shopTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.shopTab;
      shopTabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      renderShop(lastState);
    });
  });

  shopCloseButton?.addEventListener('click', () => {
    closeShop();
    onClose?.();
  });
}
