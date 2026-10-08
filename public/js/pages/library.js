import { api, html, icon, $, run, toast, modal, confirmDialog, formData, fmtNum, fmtDuration, fmtBytes, fmtDateTime, fmtClock } from '../lib.js';
import { player, playIcon } from '../player.js';
import { openCueEditor, cueSummary } from '../cue-editor.js';

const ACCEPT = '.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.wav,audio/*';

/** Envoie un fichier avec suivi de progression (le fichier est le corps de la requête). */
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/autodj/media');
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

export async function choosePlaylist(title, kind) {
  const lists = (await api('/autodj/playlists')).filter((p) => !kind || p.kind === kind);
  return new Promise((resolve) => {
    let chosen = null;
    const { dlg, close } = modal({
      title,
      body: lists.length
        ? html`<form id="cp" class="stack"><label class="field">Playlist<select name="id" style="width:100%">
            ${lists.map((p) => html`<option value="${p.id}">${p.name} (${p.kind === 'jingle' ? 'jingles' : 'musique'}, ${p.count} titres)</option>`)}</select></label></form>`
        : html`<p>Aucune playlist. <a href="#/playlists">Créez-en une</a> d'abord.</p>`,
      footer: lists.length ? html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="cp">Ajouter</button>` : '',
    });
    dlg.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      chosen = Number(e.target.id.value);
      close();
    });
    dlg.addEventListener('close', () => resolve(chosen));
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

export default function libraryPage(view, { topbar }) {
  let items = [];
  let stats = { count: 0, duration: 0, size: 0 };
  let analysing = 0;
  let autoCue = true;
  let poll = null;
  let search = '';
  const selected = new Set();
  const uploads = []; // { name, progress, state, error }

  topbar.innerHTML = String(html`<input id="lib-search" placeholder="Rechercher un titre, un artiste…" style="width:260px">`);
  let t;
  $('#lib-search', topbar).addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { search = e.target.value; load(); }, 250);
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
    view.innerHTML = String(html`
      <label class="card" id="drop" style="display:block;border-style:dashed;border-width:2px;text-align:center;cursor:pointer;padding:28px">
        <input type="file" id="files" multiple accept="${ACCEPT}" hidden>
        <div class="drop-icon">${icon('upload')}</div>
        <h2 class="mt">Glissez vos musiques ici</h2>
        <p class="muted" style="margin:6px 0 0">ou cliquez pour choisir des fichiers : MP3, AAC/M4A, OGG, Opus, FLAC, WAV.
          Le titre et l'artiste sont lus automatiquement (sinon depuis le nom « Artiste - Titre.mp3 »).</p>
        <div id="uploads" style="text-align:left"></div>
      </label>
      <div class="row between mt">
        <span class="muted">${fmtNum(stats.count)} titres · ${fmtDuration(stats.duration, true)} · ${fmtBytes(stats.size)}</span>
        <div class="row">
          ${analysing ? html`<span class="dim small">${icon('wave')} Points cue : ${fmtNum(analysing)} titre${analysing > 1 ? 's' : ''} en analyse…</span>` : ''}
          <label class="check small" title="Analyse de chaque nouveau titre envoyé"><input type="checkbox" id="auto-cue" ${autoCue ? 'checked' : ''}> Cue auto à l'envoi</label>
          <button class="btn sm" id="analyse-all" title="Recalcule les points cue automatiques (les réglages faits à la main sont conservés)">${icon('wave')} Points cue automatiques</button>
          <button class="btn sm" id="add-selection" ${selected.size ? '' : 'disabled'}>${icon('plus')} Ajouter la sélection (${selected.size}) à une playlist</button>
        </div>
      </div>
      <div class="card flush mt">
        <div class="table-wrap"><table>
          <thead><tr><th style="width:34px"><input type="checkbox" id="select-all"></th><th></th><th>Titre</th><th>Artiste</th><th>Album</th>
            <th class="num">Durée</th><th>Cue</th><th class="num">Diffusions</th><th>Ajouté le</th><th></th></tr></thead>
          <tbody>${items.length ? items.map((m) => html`<tr>
            <td><input type="checkbox" data-sel="${m.id}" ${selected.has(m.id) ? 'checked' : ''}></td>
            <td><button class="play-btn" style="width:30px;height:30px" data-play="/api/autodj/media/${m.id}/audio" title="Écouter">${playIcon(`/api/autodj/media/${m.id}/audio`)}</button></td>
            <td class="truncate" title="${m.original_name}"><b>${m.title || m.original_name}</b>${m.in_playlists ? '' : html` <span class="badge" title="Dans aucune playlist">hors playlist</span>`}</td>
            <td class="truncate">${m.artist || '—'}</td>
            <td class="truncate dim">${m.album || ''}</td>
            <td class="num">${m.duration ? fmtClock(m.duration) : '—'}</td>
            <td>${cueSummary(m)}</td>
            <td class="num">${fmtNum(m.plays)}</td>
            <td class="dim small nowrap">${fmtDateTime(m.added_at).slice(0, 10)}</td>
            <td class="right nowrap">
              <button class="btn sm ghost" data-next="${m.id}" title="Jouer ensuite sur l'AutoDJ">${icon('queue')}</button>
              <button class="btn sm ghost" data-cue="${m.id}" title="Points cue (entrée, enchaînement, sortie, fondus)">${icon('wave')}</button>
              <button class="btn sm ghost" data-add="${m.id}" title="Ajouter à une playlist">${icon('plus')}</button>
              <button class="btn sm ghost" data-edit="${m.id}" title="Modifier">${icon('edit')}</button>
              <button class="btn sm ghost danger" data-del="${m.id}" title="Supprimer">${icon('trash')}</button>
            </td></tr>`)
          : html`<tr><td colspan="10" class="empty">${search ? 'Aucun résultat' : 'La bibliothèque est vide : envoyez vos premières musiques ci-dessus.'}</td></tr>`}</tbody>
        </table></div>
      </div>`);
    renderUploads();
    player.refresh();
  }

  async function load() {
    const r = await api(`/autodj/media?q=${encodeURIComponent(search)}`);
    items = r.items;
    stats = r.stats;
    analysing = r.analysing || 0;
    autoCue = r.autoCue !== false;
    render();
    // Analyse en cours : on rafraîchit jusqu'à la fin
    clearTimeout(poll);
    if (analysing) poll = setTimeout(load, 3000);
  }

  async function sendFiles(files) {
    const list = [...files];
    const entries = list.map((f) => ({ name: f.name, progress: 0, state: 'pending' }));
    uploads.push(...entries);
    renderUploads();
    let ok = 0;
    // deux envois en parallèle
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const k = i++;
        const u = entries[k];
        u.state = 'uploading';
        try {
          await upload(list[k], (p) => { u.progress = p; renderUploads(); });
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
    await Promise.all([worker(), worker()]);
    if (ok) toast(`${ok} titre${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''} à la bibliothèque`);
    await load();
  }

  view.addEventListener('change', (e) => {
    if (e.target.id === 'files' && e.target.files.length) sendFiles(e.target.files);
    if (e.target.id === 'auto-cue') {
      api('/autodj/settings', { method: 'PUT', body: { autoCue: e.target.checked } })
        .then((r) => toast(r.autoCue ? 'Points cue automatiques activés pour les nouveaux titres' : 'Points cue automatiques désactivés'));
    }
    const sel = e.target.closest('[data-sel]');
    if (sel) {
      const id = Number(sel.dataset.sel);
      if (sel.checked) selected.add(id); else selected.delete(id);
      const b = $('#add-selection', view);
      b.disabled = !selected.size;
      b.lastChild.textContent = ` Ajouter la sélection (${selected.size}) à une playlist`;
    }
    if (e.target.id === 'select-all') {
      items.forEach((m) => (e.target.checked ? selected.add(m.id) : selected.delete(m.id)));
      render();
    }
  });

  view.addEventListener('dragover', (e) => {
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
    const cue = e.target.closest('[data-cue]');
    if (cue && await openCueEditor(items.find((x) => x.id === Number(cue.dataset.cue)))) load();
    if (e.target.closest('#analyse-all')) {
      const r = await run(null, () => api('/autodj/autocue', { method: 'POST' }));
      toast(r.queued ? `${r.queued} titre${r.queued > 1 ? 's' : ''} en cours d'analyse` : 'Tous les titres ont des points cue réglés à la main');
      load();
    }
    const next = e.target.closest('[data-next]');
    if (next) {
      const station = await chooseStation();
      if (station) await run(next, () => api(`/autodj/stations/${station}/queue`, { method: 'POST', body: { mediaId: Number(next.dataset.next) } }), 'Ajouté à la file d\'attente de l\'AutoDJ');
    }
    const add = e.target.closest('[data-add]');
    if (add || e.target.closest('#add-selection')) {
      const ids = add ? [Number(add.dataset.add)] : [...selected];
      const pid = await choosePlaylist(ids.length > 1 ? `Ajouter ${ids.length} titres à une playlist` : 'Ajouter à une playlist');
      if (pid) {
        await run(null, () => api(`/autodj/playlists/${pid}/items`, { method: 'POST', body: { mediaIds: ids } }), 'Ajouté à la playlist');
        selected.clear();
        load();
      }
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const m = items.find((x) => x.id === Number(edit.dataset.edit));
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
    const del = e.target.closest('[data-del]');
    if (del) {
      const m = items.find((x) => x.id === Number(del.dataset.del));
      if (!await confirmDialog('Supprimer ce titre ?', `« ${m.artist ? `${m.artist} - ` : ''}${m.title} » sera retiré de la bibliothèque et de toutes les playlists.`, { confirm: 'Supprimer', danger: true })) return;
      await run(null, () => api(`/autodj/media/${m.id}`, { method: 'DELETE' }), 'Titre supprimé');
      selected.delete(m.id);
      load();
    }
  });

  load();
  return () => { clearTimeout(t); clearTimeout(poll); };
}

