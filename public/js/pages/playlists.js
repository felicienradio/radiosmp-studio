import { api, html, icon, $, run, modal, confirmDialog, fmtNum, fmtDuration, fmtClock } from '../lib.js';
import { player, playIcon } from '../player.js';
import { openCueEditor, cueSummary } from '../cue-editor.js';

function addTracksDialog(playlist, onDone) {
  let all = [];
  const chosen = new Set();
  const { dlg, close } = modal({
    title: `Ajouter des titres à « ${playlist.name} »`,
    wide: true,
    body: html`<input id="q" placeholder="Rechercher…" autofocus><div id="res" class="mt" style="max-height:55vh;overflow:auto"></div>`,
    footer: html`<span class="dim small" id="cnt" style="margin-right:auto">0 sélectionné</span>
      <button class="btn" data-close>Annuler</button><button class="btn primary" id="ok">Ajouter</button>`,
  });
  const inPlaylist = new Set(playlist.items.map((m) => m.id));
  function draw(filter = '') {
    const f = filter.toLowerCase();
    const list = all.filter((m) => !f || `${m.title} ${m.artist} ${m.album} ${m.original_name}`.toLowerCase().includes(f));
    dlg.querySelector('#res').innerHTML = String(list.length ? html`<table><tbody>${list.map((m) => html`<tr>
      <td style="width:30px"><input type="checkbox" data-id="${m.id}" ${chosen.has(m.id) ? 'checked' : ''}></td>
      <td><b>${m.title || m.original_name}</b><div class="dim small">${m.artist || ''}</div></td>
      <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td>
      <td class="right">${inPlaylist.has(m.id) ? html`<span class="badge">déjà dedans</span>` : ''}</td></tr>`)}</tbody></table>`
      : html`<div class="empty">Aucun titre. <a href="#/bibliotheque">Ajoutez des musiques à la bibliothèque</a>.</div>`);
  }
  api('/autodj/media').then((r) => { all = r.items; draw(); });
  dlg.querySelector('#q').addEventListener('input', (e) => draw(e.target.value));
  dlg.addEventListener('change', (e) => {
    const c = e.target.closest('[data-id]');
    if (!c) return;
    if (c.checked) chosen.add(Number(c.dataset.id)); else chosen.delete(Number(c.dataset.id));
    dlg.querySelector('#cnt').textContent = `${chosen.size} sélectionné${chosen.size > 1 ? 's' : ''}`;
  });
  dlg.querySelector('#ok').addEventListener('click', async () => {
    if (!chosen.size) return close();
    await run(null, () => api(`/autodj/playlists/${playlist.id}/items`, { method: 'POST', body: { mediaIds: [...chosen] } }), `${chosen.size} titre(s) ajouté(s)`);
    close();
    onDone();
  });
}

export default function playlistsPage(view, { params, topbar }) {
  let lists = [];
  let current = null;
  let selectedId = Number(params[0]) || null;

  topbar.innerHTML = String(html`<button class="btn primary" id="new-pl">${icon('plus')} Nouvelle playlist</button>`);
  $('#new-pl', topbar).addEventListener('click', () => {
    const { dlg, close } = modal({
      title: 'Nouvelle playlist',
      body: html`<form id="np" class="stack">
        <label class="field">Nom<input name="name" required placeholder="Hits du moment" autofocus></label>
        <div class="form-grid">
          <label class="field">Type<select name="kind" style="width:100%"><option value="music">Musique</option><option value="jingle">Jingles</option></select></label>
          <label class="field">Lecture<select name="shuffle" style="width:100%"><option value="1">Aléatoire</option><option value="0">Dans l'ordre</option></select></label>
        </div></form>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="np">Créer</button>`,
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const p = await run(null, () => api('/autodj/playlists', { method: 'POST', body: { name: f.name.value, kind: f.kind.value, shuffle: f.shuffle.value === '1' } }), 'Playlist créée');
      close();
      location.hash = `#/playlists/${p.id}`;
    });
  });

  function render() {
    const total = current ? current.items.reduce((s, m) => s + (m.duration || 0), 0) : 0;
    view.innerHTML = String(html`<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2.2fr);align-items:start">
      <div class="stack" style="gap:10px">
        ${lists.length ? lists.map((p) => html`<a class="card" href="#/playlists/${p.id}" style="padding:14px 16px;text-decoration:none;color:inherit;${p.id === selectedId ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
          <div class="row between"><b>${p.name}</b><span class="badge ${p.kind === 'jingle' ? 'warn' : 'accent'}">${p.kind === 'jingle' ? 'Jingles' : 'Musique'}</span></div>
          <div class="dim small mt" style="margin-top:4px">${fmtNum(p.count)} titre${p.count > 1 ? 's' : ''} · ${fmtDuration(p.duration, true)} · ${p.shuffle ? 'aléatoire' : 'dans l\'ordre'}</div>
          <div class="small" style="margin-top:4px">${p.stations ? html`${icon('disc')} ${p.stations}` : html`<span class="dim">Dans aucune station AutoDJ</span>`}</div></a>`)
          : html`<div class="card empty">Aucune playlist pour l'instant.<br>Créez-en une avec le bouton « Nouvelle playlist ».</div>`}
      </div>
      <div>${current ? html`
        <form class="card" id="pl-form">
          <div class="card-head"><h2>${current.name}</h2><div class="spacer"></div>
            <button type="button" class="btn sm danger" id="pl-del">${icon('trash')} Supprimer</button></div>
          <div class="form-grid">
            <label class="field">Nom<input name="name" value="${current.name}" required></label>
            <div class="form-grid" style="gap:10px">
              <label class="field">Type<select name="kind" style="width:100%">
                <option value="music" ${current.kind === 'music' ? 'selected' : ''}>Musique</option>
                <option value="jingle" ${current.kind === 'jingle' ? 'selected' : ''}>Jingles</option></select></label>
              <label class="field">Lecture<select name="shuffle" style="width:100%">
                <option value="1" ${current.shuffle ? 'selected' : ''}>Aléatoire</option>
                <option value="0" ${current.shuffle ? '' : 'selected'}>Dans l'ordre</option></select></label>
            </div>
          </div>
          <p class="dim small" style="margin:10px 0 0">Pour la diffuser, ajoutez-la à une station sur la page <a href="#/autodj">AutoDJ</a>
            (en rotation, ou une fois tous les N titres pour des jingles).</p>
          <div class="row mt"><button class="btn" type="submit">Enregistrer</button>
            <span class="dim small">${fmtNum(current.items.length)} titre${current.items.length > 1 ? 's' : ''} · ${fmtDuration(total, true)}</span></div>
        </form>
        <div class="card flush mt">
          <div class="card-head"><h3>Titres</h3><div class="spacer"></div>
            <button class="btn sm primary" id="add-tracks">${icon('plus')} Ajouter des titres</button></div>
          <div class="table-wrap mt"><table>
            <thead><tr><th class="num">#</th><th></th><th>Titre</th><th>Artiste</th><th class="num">Durée</th><th>Cue</th><th></th></tr></thead>
            <tbody>${current.items.length ? current.items.map((m, i) => html`<tr>
              <td class="num dim">${i + 1}</td>
              <td><button class="play-btn" style="width:28px;height:28px" data-play="/api/autodj/media/${m.id}/audio">${playIcon(`/api/autodj/media/${m.id}/audio`)}</button></td>
              <td class="truncate"><b>${m.title || m.original_name}</b></td>
              <td class="truncate">${m.artist || '—'}</td>
              <td class="num">${m.duration ? fmtClock(m.duration) : ''}</td>
              <td>${cueSummary(m)}</td>
              <td class="right nowrap">
                <button class="btn sm ghost icon" data-cue="${m.id}" title="Points cue">${icon('wave')}</button>
                <button class="btn sm ghost icon" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Monter">${icon('up')}</button>
                <button class="btn sm ghost icon" data-move="${i}" data-dir="1" ${i === current.items.length - 1 ? 'disabled' : ''} title="Descendre">${icon('down')}</button>
                <button class="btn sm ghost icon danger" data-remove="${i}" title="Retirer de la playlist">${icon('x')}</button>
              </td></tr>`)
            : html`<tr><td colspan="7" class="empty">Playlist vide : cliquez sur « Ajouter des titres ».</td></tr>`}</tbody>
          </table></div>
        </div>` : html`<div class="card empty">${lists.length ? 'Choisissez une playlist à gauche.' : ''}</div>`}
      </div></div>`);
    player.refresh();
  }

  async function load() {
    lists = await api('/autodj/playlists');
    if (!selectedId && lists.length) selectedId = lists[0].id;
    current = selectedId ? await api(`/autodj/playlists/${selectedId}`).catch(() => null) : null;
    render();
  }

  const saveOrder = async (ids) => {
    current = await api(`/autodj/playlists/${current.id}/items`, { method: 'PUT', body: { mediaIds: ids } });
    lists = await api('/autodj/playlists');
    render();
  };

  view.addEventListener('submit', async (e) => {
    if (e.target.id !== 'pl-form') return;
    e.preventDefault();
    const f = e.target;
    current = await run(f.querySelector('[type=submit]'), () => api(`/autodj/playlists/${current.id}`, {
      method: 'PUT', body: { name: f.name.value, kind: f.kind.value, shuffle: f.shuffle.value === '1' },
    }), 'Playlist enregistrée');
    load();
  });

  view.addEventListener('click', async (e) => {
    if (e.target.closest('#add-tracks')) addTracksDialog(current, load);
    const cue = e.target.closest('[data-cue]');
    if (cue && await openCueEditor(current.items.find((m) => m.id === Number(cue.dataset.cue)))) load();
    if (e.target.closest('#pl-del')) {
      if (!await confirmDialog('Supprimer la playlist ?', `« ${current.name} » sera supprimée (les musiques restent dans la bibliothèque). Elle sera retirée des stations AutoDJ, et les créneaux de la grille qui l'utilisent seront supprimés.`, { confirm: 'Supprimer', danger: true })) return;
      await run(null, () => api(`/autodj/playlists/${current.id}`, { method: 'DELETE' }), 'Playlist supprimée');
      selectedId = null;
      location.hash = '#/playlists';
      load();
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const ids = current.items.map((m) => m.id);
      const i = Number(mv.dataset.move);
      const j = i + Number(mv.dataset.dir);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await saveOrder(ids);
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const ids = current.items.map((m) => m.id);
      ids.splice(Number(rm.dataset.remove), 1);
      await saveOrder(ids);
    }
  });

  load();
}
