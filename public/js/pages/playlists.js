import { api, html, icon, $, run, toast, modal, confirmDialog, formData, fmtNum, fmtDuration, fmtClock } from '../lib.js';
import { player, playIcon } from '../player.js';
import { openCueEditor, cueSummary } from '../cue-editor.js';

const ACCEPT = '.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.wav,audio/*';

/** Envoie un fichier directement dans la playlist, avec suivi de progression. */
function upload(file, playlistId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/autodj/media?playlist=${playlistId}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Erreur ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Connexion interrompue'));
    xhr.send(file);
  });
}

/** Station AutoDJ où jouer un titre ensuite (choix demandé s'il y en a plusieurs). */
async function chooseStation() {
  const { stations } = await api('/autodj');
  if (stations.length <= 1) return stations[0]?.id ?? null;
  return new Promise((resolve) => {
    let chosen = null;
    const { dlg, close } = modal({
      title: 'Jouer ensuite sur quelle station ?',
      body: html`<form id="cs" class="stack"><label class="field">Station<select name="id" style="width:100%">
        ${stations.map((st) => html`<option value="${st.id}">${st.name} (${st.outputs.map((o) => o.mount).join(', ')})${st.state === 'playing' ? '' : ' · arrêtée'}</option>`)}</select></label></form>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="cs">Ajouter à la file</button>`,
    });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      chosen = Number(e.target.id.value);
      close();
    });
    dlg.addEventListener('close', () => resolve(chosen));
  });
}

/** Ajouter des musiques déjà envoyées (dans d'autres playlists). */
function existingDialog(playlist, onDone) {
  let all = [];
  const chosen = new Set();
  const { dlg, close } = modal({
    title: `Ajouter à « ${playlist.name} » des musiques déjà envoyées`,
    wide: true,
    body: html`<input id="q" placeholder="Rechercher…" autofocus><div id="res" class="mt" style="max-height:55vh;overflow:auto"></div>`,
    footer: html`<span class="dim small" id="cnt" style="margin-right:auto">0 sélectionné</span>
      <button class="btn" data-close>Annuler</button><button class="btn primary" id="ok">Ajouter</button>`,
  });
  const inPlaylist = new Set(playlist.items.map((m) => m.id));
  function draw(filter = '') {
    const f = filter.toLowerCase();
    const list = all.filter((m) => !inPlaylist.has(m.id) && (!f || `${m.title} ${m.artist} ${m.album} ${m.original_name}`.toLowerCase().includes(f)));
    dlg.querySelector('#res').innerHTML = String(list.length ? html`<table><tbody>${list.map((m) => html`<tr>
      <td style="width:30px"><input type="checkbox" data-id="${m.id}" ${chosen.has(m.id) ? 'checked' : ''}></td>
      <td><b>${m.title || m.original_name}</b><div class="dim small">${m.artist || ''}</div></td>
      <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td></tr>`)}</tbody></table>`
      : html`<div class="empty">Aucune autre musique : glissez vos fichiers dans la playlist pour les envoyer.</div>`);
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
  let autoCue = true;
  let poll = null;
  const uploads = []; // { name, progress, state, error }

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
      const p = await run(null, () => api('/autodj/playlists', { method: 'POST', body: { name: f.name.value, kind: f.kind.value, shuffle: f.shuffle.value === '1' } }), 'Playlist créée : glissez-y vos musiques');
      close();
      location.hash = `#/playlists/${p.id}`;
    });
  });

  function renderUploads() {
    const box = $('#uploads', view);
    if (!box) return;
    box.innerHTML = uploads.length ? String(html`<div class="stack mt" style="gap:8px">${uploads.slice(-8).map((u) => html`
      <div><div class="row between small"><span class="truncate">${u.name}</span>
        <span class="${u.state === 'error' ? 'badge danger' : u.state === 'done' ? 'badge ok' : 'dim'}">${u.state === 'error' ? u.error : u.state === 'done' ? 'Ajouté' : `${Math.round(u.progress * 100)} %`}</span></div>
        <div class="meter"><div style="width:${u.progress * 100}%;background:${u.state === 'error' ? 'var(--danger)' : 'var(--accent)'}"></div></div></div>`)}</div>`) : '';
  }

  function render() {
    const total = current ? current.items.reduce((s, m) => s + (m.duration || 0), 0) : 0;
    view.innerHTML = String(html`<div class="grid playlists-layout" style="grid-template-columns:minmax(0,1fr) minmax(0,2.2fr);align-items:start">
      <div class="stack" style="gap:10px">
        ${lists.length ? lists.map((p) => html`<a class="card" href="#/playlists/${p.id}" style="padding:14px 16px;text-decoration:none;color:inherit;${p.id === selectedId ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
          <div class="row between"><b>${p.name}</b><span class="badge ${p.kind === 'jingle' ? 'warn' : 'accent'}">${p.kind === 'jingle' ? 'Jingles' : 'Musique'}</span></div>
          <div class="dim small mt" style="margin-top:4px">${fmtNum(p.count)} titre${p.count > 1 ? 's' : ''} · ${fmtDuration(p.duration, true)} · ${p.shuffle ? 'aléatoire' : 'dans l\'ordre'}</div>
          <div class="small" style="margin-top:4px">${p.stations ? html`${icon('disc')} ${p.stations}` : html`<span class="dim">Dans aucune station AutoDJ</span>`}</div></a>`)
          : html`<div class="card empty">Aucune playlist pour l'instant.<br>Créez-en une avec le bouton « Nouvelle playlist », puis glissez-y vos musiques.</div>`}
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

        <label class="card mt" id="drop" style="display:block;border-style:dashed;border-width:2px;text-align:center;cursor:pointer;padding:22px">
          <input type="file" id="files" multiple accept="${ACCEPT}" hidden>
          <div class="drop-icon">${icon('upload')}</div>
          <h3 class="mt">Glissez vos ${current.kind === 'jingle' ? 'jingles' : 'musiques'} ici</h3>
          <p class="muted small" style="margin:6px 0 0">ou cliquez pour choisir des fichiers : MP3, AAC/M4A, OGG, Opus, FLAC, WAV.
            Ils sont ajoutés directement à « ${current.name} ». Titre et artiste lus automatiquement (sinon « Artiste - Titre.mp3 »).</p>
          <div id="uploads" style="text-align:left"></div>
        </label>

        <div class="card flush mt">
          <div class="card-head"><h3>Titres</h3><div class="spacer"></div>
            <label class="check small" title="Points cue calculés à l'envoi de chaque titre"><input type="checkbox" id="auto-cue" ${autoCue ? 'checked' : ''}> Cue auto</label>
            <button class="btn sm" id="add-existing" title="Musiques déjà envoyées dans d'autres playlists">${icon('plus')} Depuis une autre playlist</button></div>
          <div class="table-wrap mt"><table>
            <thead><tr><th class="num">#</th><th></th><th>Titre</th><th>Artiste</th><th class="num">Durée</th><th>Cue</th><th class="num">Diff.</th><th></th></tr></thead>
            <tbody>${current.items.length ? current.items.map((m, i) => html`<tr>
              <td class="num dim">${i + 1}</td>
              <td><button class="play-btn" style="width:28px;height:28px" data-play="/api/autodj/media/${m.id}/audio" title="Écouter">${playIcon(`/api/autodj/media/${m.id}/audio`)}</button></td>
              <td class="truncate" title="${m.original_name}"><b>${m.title || m.original_name}</b>${m.in_playlists > 1 ? html` <span class="dim small" title="Aussi dans d'autres playlists">+${m.in_playlists - 1}</span>` : ''}</td>
              <td class="truncate">${m.artist || '—'}</td>
              <td class="num">${m.duration ? fmtClock(m.duration) : ''}</td>
              <td>${cueSummary(m)}</td>
              <td class="num dim" title="Nombre de diffusions">${fmtNum(m.plays)}</td>
              <td class="right nowrap">
                <button class="btn sm ghost icon" data-next="${m.id}" title="Jouer ensuite sur l'AutoDJ">${icon('queue')}</button>
                <button class="btn sm ghost icon" data-cue="${m.id}" title="Points cue">${icon('wave')}</button>
                <button class="btn sm ghost icon" data-edit="${m.id}" title="Modifier titre / artiste">${icon('edit')}</button>
                <button class="btn sm ghost icon" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Monter">${icon('up')}</button>
                <button class="btn sm ghost icon" data-move="${i}" data-dir="1" ${i === current.items.length - 1 ? 'disabled' : ''} title="Descendre">${icon('down')}</button>
                <button class="btn sm ghost icon danger" data-remove="${i}" title="Retirer de la playlist">${icon('trash')}</button>
              </td></tr>`)
            : html`<tr><td colspan="8" class="empty">Playlist vide : glissez vos fichiers dans la zone ci-dessus.</td></tr>`}</tbody>
          </table></div>
        </div>` : html`<div class="card empty">${lists.length ? 'Choisissez une playlist à gauche.' : ''}</div>`}
      </div></div>`);
    renderUploads();
    player.refresh();
  }

  async function load() {
    const [pls, adj] = await Promise.all([api('/autodj/playlists'), api('/autodj')]);
    lists = pls;
    autoCue = adj.autoCue !== false;
    if (!lists.some((p) => p.id === selectedId)) selectedId = lists[0]?.id || null;
    current = selectedId ? await api(`/autodj/playlists/${selectedId}`).catch(() => null) : null;
    render();
    // Points cue en cours d'analyse : on rafraîchit jusqu'à la fin
    clearTimeout(poll);
    if (current?.items.some((m) => m.cue_auto && !m.analyzed_at)) poll = setTimeout(load, 3000);
  }

  async function sendFiles(files) {
    if (!current) return;
    const pid = current.id;
    const list = [...files];
    const entries = list.map((f) => ({ name: f.name, progress: 0, state: 'pending' }));
    uploads.push(...entries);
    renderUploads();
    let ok = 0;
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const k = i++;
        const u = entries[k];
        u.state = 'uploading';
        try {
          await upload(list[k], pid, (p) => { u.progress = p; renderUploads(); });
          u.state = 'done';
          u.progress = 1;
          ok++;
        } catch (err) {
          u.state = 'error';
          u.error = err.message;
        }
        renderUploads();
      }
    }
    await Promise.all([worker(), worker()]); // deux envois en parallèle
    if (ok) toast(`${ok} titre${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''} à la playlist`);
    await load();
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

  view.addEventListener('change', (e) => {
    if (e.target.id === 'files' && e.target.files.length) sendFiles(e.target.files);
    if (e.target.id === 'auto-cue') {
      api('/autodj/settings', { method: 'PUT', body: { autoCue: e.target.checked } })
        .then((r) => toast(r.autoCue ? 'Points cue automatiques activés pour les nouveaux titres' : 'Points cue automatiques désactivés'));
    }
  });

  view.addEventListener('dragover', (e) => {
    if (!current) return;
    e.preventDefault();
    $('#drop', view)?.style.setProperty('border-color', 'var(--accent)');
  });
  view.addEventListener('dragleave', () => $('#drop', view)?.style.removeProperty('border-color'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    $('#drop', view)?.style.removeProperty('border-color');
    if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
  });

  view.addEventListener('click', async (e) => {
    if (e.target.closest('#add-existing')) existingDialog(current, load);
    const find = (el, key) => current.items.find((m) => m.id === Number(el.dataset[key]));
    const cue = e.target.closest('[data-cue]');
    if (cue && await openCueEditor(find(cue, 'cue'))) load();
    const next = e.target.closest('[data-next]');
    if (next) {
      const station = await chooseStation();
      if (station) await run(next, () => api(`/autodj/stations/${station}/queue`, { method: 'POST', body: { mediaId: Number(next.dataset.next) } }), 'Ajouté à la file d\'attente de l\'AutoDJ').catch(() => null);
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const m = find(edit, 'edit');
      const { dlg, close } = modal({
        title: 'Modifier le titre',
        body: html`<form id="me" class="stack">
          <label class="field">Titre<input name="title" value="${m.title || ''}"></label>
          <label class="field">Artiste<input name="artist" value="${m.artist || ''}"></label>
          <label class="field">Album<input name="album" value="${m.album || ''}"></label>
          <p class="dim small" style="margin:0">Fichier : ${m.original_name}. Le texte « Artiste - Titre » est celui annoncé aux auditeurs.</p></form>`,
        footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="me">Enregistrer</button>`,
      });
      dlg.querySelector('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await run(null, () => api(`/autodj/media/${m.id}`, { method: 'PUT', body: formData(ev.target) }), 'Titre modifié');
        close();
        load();
      });
    }
    if (e.target.closest('#pl-del')) {
      const own = current.items.filter((m) => m.in_playlists <= 1).length;
      if (!await confirmDialog('Supprimer la playlist ?', `« ${current.name} » sera supprimée${own ? `, avec ses ${own} musique${own > 1 ? 's' : ''} qui ne sont dans aucune autre playlist` : ''}. Elle sera retirée des stations AutoDJ, et les créneaux de la grille qui l'utilisent seront supprimés.`, { confirm: 'Supprimer', danger: true })) return;
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
      const m = current.items[Number(rm.dataset.remove)];
      // Dernière playlist du titre : le fichier est supprimé avec
      if (m.in_playlists <= 1 && !await confirmDialog('Supprimer ce titre ?', `« ${m.artist ? `${m.artist} - ` : ''}${m.title || m.original_name} » n'est dans aucune autre playlist : le fichier sera supprimé.`, { confirm: 'Supprimer', danger: true })) return;
      await saveOrder(current.items.filter((x) => x.id !== m.id).map((x) => x.id));
    }
  });

  load();
  return () => clearTimeout(poll);
}
