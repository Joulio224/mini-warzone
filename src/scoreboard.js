// ---------------------------------------------------------------------------
// Kill feed (« Clovis [Fusil] Léa », en haut à droite) et tableau des scores
// (touche maintenue, Tab par défaut). Uniquement de l'affichage : toutes les
// données viennent du serveur (événements 'kill-feed' et 'scoreboard', voir
// mini-warzone-server/server.js).
//
// Les pseudos viennent des AUTRES joueurs : ils ne sont donc JAMAIS injectés
// en HTML, uniquement posés avec textContent.
// ---------------------------------------------------------------------------

const TEAM_CLASS = { red: 'sb-team-red', blue: 'sb-team-blue' };
const TEAM_LABEL = { red: 'Rouge', blue: 'Bleue' };

function teamClass(team) {
  return TEAM_CLASS[team] || '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createScoreboard({
  feedEl,
  boardEl,
  getMyId = () => null,
  weaponName = (id) => String(id),
  rarityColor = () => null,
  feedLifetimeMs = 6000,
  feedMax = 5,
} = {}) {
  let scores = [];
  let visible = false;

  // --- Kill feed -----------------------------------------------------------
  function nameSpan(pseudo, team) {
    const cls = ['feed-name', teamClass(team)].filter(Boolean).join(' ');
    return el('span', cls, pseudo || '?');
  }

  function addKill(data) {
    if (!feedEl || !data || typeof data !== 'object') return;
    const myId = getMyId();

    const row = el('div', 'feed-entry');
    if (myId && data.killerId === myId) row.classList.add('mine');
    if (myId && data.victimId === myId) row.classList.add('died');

    if (data.killerPseudo) {
      row.appendChild(nameSpan(data.killerPseudo, data.killerTeam));
      if (data.weaponId) {
        const weapon = el('span', 'feed-weapon', `[${weaponName(data.weaponId)}]`);
        const color = rarityColor(data.rarity);
        if (color) weapon.style.color = color;
        row.appendChild(weapon);
      } else {
        row.appendChild(el('span', 'feed-weapon', '›'));
      }
    } else {
      row.appendChild(el('span', 'feed-weapon', '☠'));
    }
    row.appendChild(nameSpan(data.victimPseudo, data.victimTeam));

    feedEl.appendChild(row);
    while (feedEl.children.length > feedMax) feedEl.removeChild(feedEl.firstChild);

    setTimeout(() => row.classList.add('fade'), Math.max(0, feedLifetimeMs - 500));
    setTimeout(() => row.remove(), feedLifetimeMs);
  }

  function clearFeed() {
    if (feedEl) feedEl.innerHTML = '';
  }

  // --- Tableau des scores --------------------------------------------------
  function setScores(list) {
    if (!Array.isArray(list)) return;
    scores = list
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: p.id,
        pseudo: typeof p.pseudo === 'string' ? p.pseudo : '?',
        team: p.team,
        mode: p.mode,
        kills: Number.isFinite(p.kills) ? p.kills : 0,
        deaths: Number.isFinite(p.deaths) ? p.deaths : 0,
      }));
    if (visible) render();
  }

  function sorted() {
    return [...scores].sort(
      (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.pseudo.localeCompare(b.pseudo)
    );
  }

  function render() {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    const myId = getMyId();
    const card = el('div', 'sb-card');
    card.appendChild(el('h3', 'sb-title', 'Joueurs'));

    // Totaux par équipe, seulement s'il y a des joueurs en mode Équipes
    const teamPlayers = scores.filter((p) => p.mode === 'team' && TEAM_CLASS[p.team]);
    if (teamPlayers.length > 0) {
      const totals = { red: 0, blue: 0 };
      teamPlayers.forEach((p) => {
        totals[p.team] += p.kills;
      });
      const bar = el('div', 'sb-teams');
      bar.appendChild(el('span', `sb-team-total ${TEAM_CLASS.red}`, `${TEAM_LABEL.red} ${totals.red}`));
      bar.appendChild(el('span', 'sb-team-sep', '—'));
      bar.appendChild(el('span', `sb-team-total ${TEAM_CLASS.blue}`, `${totals.blue} ${TEAM_LABEL.blue}`));
      card.appendChild(bar);
    }

    const table = el('table', 'sb-table');
    const head = el('tr');
    head.append(el('th', 'sb-name', 'Joueur'), el('th', 'sb-num', 'Kills'), el('th', 'sb-num', 'Morts'));
    table.appendChild(el('thead')).appendChild(head);

    const body = el('tbody');
    sorted().forEach((p) => {
      const tr = el('tr', myId && p.id === myId ? 'mine' : '');
      const nameCell = el('td', 'sb-name');
      if (p.mode === 'team' && TEAM_CLASS[p.team]) nameCell.appendChild(el('span', `sb-dot ${TEAM_CLASS[p.team]}`));
      nameCell.appendChild(el('span', '', p.pseudo));
      tr.append(nameCell, el('td', 'sb-num', String(p.kills)), el('td', 'sb-num', String(p.deaths)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    card.appendChild(table);
    boardEl.appendChild(card);
  }

  function show() {
    visible = true;
    if (boardEl) {
      render();
      boardEl.hidden = false;
    }
  }

  function hide() {
    visible = false;
    if (boardEl) boardEl.hidden = true;
  }

  return { addKill, clearFeed, setScores, show, hide, isVisible: () => visible, getScores: () => scores };
}
