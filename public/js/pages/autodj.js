import { api, html, icon, $, $$, run, toast, confirmDialog, fmtClock, fmtTime, fmtNum } from '../lib.js';
import { player, playIcon, playUrl } from '../player.js';

const DAYS = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'J'], [5, 'V'], [6, 'S'], [7, 'D']];
const DAY_NAMES = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
const SOURCE = { playlist: 'Rotation', grille: 'Grille horaire', jingle: 'Jingle', insert: 'Insertion', demande: 'Demande' };
const STATE = { playing: ['ok', 'En diffusion'], starting: ['warn', 'Démarrage…'], stopping: ['warn', 'Arrêt…'], stopped: ['', 'Arrêté'], error: ['danger', 'Erreur'] };
const MODES = [
  ['rotation', 'Rotation'],
  ['tracks', 'Une fois tous les N titres'],
  ['minutes', 'Une fois toutes les N minutes'],
];
const BITRATES = [64, 96, 128, 160, 192, 256, 320];

function daysLabel(days) {
  const d = days.split(',').map(Number);
  if (d.length === 7) return 'Tous les jours';
  if (d.join() === '1,2,3,4,5') return 'Du lundi au vendredi';
  if (d.join() === '6,7') return 'Le week-end';
  return d.map((x) => DAY_NAMES[x]).join(', ');
}

const outputLabel = (o) => `${o.mount} · ${o.format.toUpperCase()} ${o.bitrate}`;

export default function autodjPage(view, { store, onLive, params, topbar }) {
  let stations = [];
  let selectedId = Number(params[0]) || null;
  let playlists = [];
  let schedule = [];
  let mounts = [];
  let dirty = false; // réglages de la station modifiés mais pas encore enregistrés
  const s = () => stations.find((x) => x.id === selectedId);

  function renderTopbar() {
    topbar.innerHTML = String(html`<div class="seg" id="st-tabs">${stations.map((x) => html`<button data-station="${x.id}" class="${x.id === selectedId ? 'active' : ''}">
        ${x.state === 'playing' ? html`<span class="dot live" style="background:var(--ok)"></span> ` : ''}${x.name}</button>`)}</div>
      <button class="btn primary admin-only" id="new-station">${icon('plus')} Nouvelle station</button>`);
  }

  function setupNeeded(st) {
    const configured = (name) => mounts.find((m) => m.name === name && m.configured);
    if (st.outputs.some((o) => !configured(o.mount))) return true;
    if (!st.liveMount) return false;
    const live = configured(st.liveMount);
    return !live || live.fallbackMount !== st.outputs[0]?.mount;
  }

  function nowCard(st) {
    const [cls, label] = STATE[st.state] || ['', st.state];
    const cur = st.current;
    const dur = cur?.duration || cur?.media?.duration || 0;
    const elapsed = cur ? (Date.now() - cur.startedAt) / 1000 : 0;
    const mixPct = cur && cur.mixAt && cur.mixAt < dur ? (cur.mixAt / dur) * 100 : null;
    const url = st.mount ? playUrl(st.mount) : null;
    return html`
      <div class="card-head"><h2>${st.name}</h2><span class="badge ${cls}">${st.state === 'playing' ? html`<span class="dot live"></span>` : ''}${label}</span>
        ${st.outputs.map((o) => html`<span class="badge" title="Flux de sortie"><code>${outputLabel(o)}</code></span>`)}
        <div class="spacer"></div>
        ${st.state === 'playing' || st.state === 'starting'
          ? html`<button class="btn" data-act="skip">${icon('skip')} Passer</button><button class="btn danger" data-act="stop">${icon('stop')} Arrêter</button>`
          : html`<button class="btn primary" data-act="start">${icon('play')} Démarrer</button>`}
      </div>
      ${st.lastError && st.state === 'error' ? html`<div class="banner error"><div class="grow">${st.lastError}</div></div>` : ''}
      ${st.ffmpeg === false ? html`<div class="banner error"><div class="grow"><b>ffmpeg n'est pas installé.</b> Dans le conteneur : <code>apt install ffmpeg</code></div></div>` : ''}
      <div class="now-playing" style="padding:16px 18px">
        <button class="play-btn" style="width:48px;height:48px" ${url ? html`data-play="${url}"` : ''} ${st.state === 'playing' ? '' : 'disabled'} title="Écouter">${playIcon(url)}</button>
        <div class="np-text">
          <div class="np-label">${cur ? html`En cours · ${SOURCE[cur.source] || cur.source}${cur.playlist ? ` · ${cur.playlist}` : ''}` : 'Rien en diffusion'}</div>
          <div class="np-title" style="font-size:19px">${cur ? cur.title : st.state === 'playing' ? 'Silence : aucune playlist à jouer' : '—'}</div>
          ${cur && dur ? html`<div class="row" style="gap:10px;margin-top:8px;flex-wrap:nowrap">
            <span class="small dim" data-elapsed="${cur.startedAt}">${fmtClock(Math.min(elapsed, dur))}</span>
            <div class="meter" style="flex:1;position:relative"><div data-progress="${cur.startedAt}" data-dur="${dur}" style="width:${Math.min(100, (elapsed / dur) * 100)}%;background:var(--accent)"></div>
              ${mixPct !== null ? html`<span title="Enchaînement avec le titre suivant" style="position:absolute;top:-3px;bottom:-3px;left:${mixPct}%;width:2px;background:var(--warn);border-radius:1px"></span>` : ''}</div>
            <span class="small dim">${fmtClock(dur)}</span></div>` : ''}
        </div>
      </div>
      <div class="small dim mt">${st.activeRule
        ? html`${icon('clock')} Créneau en cours : <b>${st.activeRule.playlist_name}</b> (${daysLabel(st.activeRule.days)}, ${st.activeRule.start}–${st.activeRule.end})`
        : st.links.some((l) => l.mode === 'rotation' && l.count)
          ? html`Rotation : ${st.links.filter((l) => l.mode === 'rotation' && l.count).map((l) => l.name).join(', ')}`
          : html`<span style="color:var(--warn)">Aucune playlist en rotation : ajoutez-en une ci-dessous.</span>`}
        ${st.liveMount ? html` · Direct prioritaire : <code>${st.liveMount}</code>` : ''}</div>`;
  }

  function linksCard(st) {
    const rotation = st.links.filter((l) => l.mode === 'rotation');
    const total = rotation.reduce((n, l) => n + l.weight, 0);
    const free = playlists.filter((p) => !st.links.some((l) => l.playlist_id === p.id));
    return html`<div class="card mt" id="links">
      <div class="card-head"><h2>Playlists de la station</h2><span class="dim small">enregistrées automatiquement</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Playlist</th><th>Diffusion</th><th>Réglage</th><th class="num">Part</th><th></th></tr></thead>
        <tbody>${st.links.length ? st.links.map((l, i) => html`<tr>
          <td><b>${l.name}</b> <span class="badge ${l.kind === 'jingle' ? 'warn' : 'accent'}">${l.kind === 'jingle' ? 'Jingles' : 'Musique'}</span>
            <div class="dim small">${fmtNum(l.count)} titre${l.count > 1 ? 's' : ''}${l.count ? '' : ' : playlist vide, ignorée'}</div></td>
          <td><select data-link="${i}" data-field="mode">${MODES.map(([v, label]) => html`<option value="${v}" ${v === l.mode ? 'selected' : ''}>${label}</option>`)}</select></td>
          <td class="nowrap">${l.mode === 'rotation'
            ? html`Poids <select data-link="${i}" data-field="weight">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((w) => html`<option value="${w}" ${w === l.weight ? 'selected' : ''}>${w}</option>`)}</select>`
            : html`Tous les <input type="number" min="1" max="${l.mode === 'minutes' ? 1440 : 100}" style="width:80px" data-link="${i}" data-field="every" value="${l.every}"> ${l.mode === 'minutes' ? 'min' : 'titres'}`}</td>
          <td class="num dim">${l.mode === 'rotation' && total ? `${Math.round((l.weight / total) * 100)} %` : '—'}</td>
          <td class="right"><button class="btn sm ghost icon danger" data-unlink="${i}" title="Retirer de la station">${icon('x')}</button></td></tr>`)
        : html`<tr><td colspan="5" class="empty">Aucune playlist : ajoutez-en une ci-dessous.</td></tr>`}</tbody>
      </table></div>
      <div class="row mt" style="gap:10px">
        ${free.length ? html`<select id="link-add">${free.map((p) => html`<option value="${p.id}">${p.name} (${p.kind === 'jingle' ? 'jingles' : 'musique'}, ${p.count})</option>`)}</select>
          <button class="btn primary sm" data-act="link-add">${icon('plus')} Ajouter à la station</button>`
        : html`<span class="dim small">${playlists.length ? 'Toutes les playlists sont dans cette station.' : html`Aucune playlist : <a href="#/playlists">créez-en une</a>.`}</span>`}
      </div>
      <p class="dim small" style="margin-bottom:0"><b>Rotation</b> : à chaque titre, une playlist en rotation est tirée au sort selon son poids
        (poids 6 = deux fois plus souvent qu'un poids 3). <b>Tous les N titres</b> : jingles, pubs, habillage.
        <b>Toutes les N minutes</b> : flash, identifiant de la station. Pendant un créneau de la grille horaire, sa playlist remplace la rotation.</p>
    </div>`;
  }

  function settingsCard(st) {
    return html`<form class="card mt admin-only" id="station-form">
      <div class="card-head"><h2>Flux de sortie et réglages</h2><div class="spacer"></div>
        <button type="button" class="btn danger sm" data-act="delete">${icon('trash')} Supprimer la station</button>
        <button class="btn primary" type="submit">Enregistrer</button></div>
      <datalist id="mount-list">${mounts.map((m) => html`<option value="${m.name}">`)}</datalist>
      <div class="form-grid">
        <label class="field">Nom de la station<input name="name" value="${st.name}" required></label>
        <label class="field">Flux direct prioritaire<input name="liveMount" value="${st.liveMount}" list="mount-list" placeholder="aucun (ex. /live)">
          <span class="hint">Les auditeurs de ce flux entendent la station quand aucun animateur n'est connecté dessus</span></label>
      </div>
      <h3 class="mt">Flux de sortie</h3>
      <p class="dim small" style="margin-top:4px">La station diffuse la même musique sur chacun de ces points de montage, chacun dans son format.</p>
      <div class="stack" id="outputs" style="gap:8px">${st.outputs.map((o) => html`<div class="row output-row" style="gap:8px;flex-wrap:nowrap">
        <input data-o="mount" value="${o.mount}" list="mount-list" placeholder="/autodj" style="flex:1;min-width:0" required>
        <select data-o="format"><option value="mp3" ${o.format === 'mp3' ? 'selected' : ''}>MP3</option><option value="aac" ${o.format === 'aac' ? 'selected' : ''}>AAC</option></select>
        <select data-o="bitrate">${BITRATES.map((b) => html`<option value="${b}" ${b === o.bitrate ? 'selected' : ''}>${b} kbps</option>`)}</select>
        <button type="button" class="btn ghost icon danger" data-act="output-remove" title="Retirer ce flux">${icon('x')}</button></div>`)}</div>
      <button type="button" class="btn sm mt" data-act="output-add">${icon('plus')} Ajouter un flux de sortie</button>
      <label class="check mt"><input type="checkbox" name="crossfade" ${st.crossfade ? 'checked' : ''}> Enchaînements aux points cue : le titre suivant démarre au repère « MIX », par-dessus la fin du titre en cours</label>
      <p class="dim small" style="margin-bottom:0">Après avoir ajouté un flux, cliquez sur <b>Configurer</b> dans le bandeau du haut puis sur
        <b>Appliquer maintenant</b> pour créer ses points de montage dans Icecast.</p>
    </form>`;
  }

  function scheduleCard() {
    const music = playlists;
    return html`<div class="card mt">
      <div class="card-head"><h2>Grille horaire</h2><span class="dim small">heure de la radio</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Jours</th><th>Horaires</th><th>Playlist</th><th></th></tr></thead>
        <tbody>${schedule.length ? schedule.map((r) => html`<tr style="${s().activeRule?.id === r.id ? 'background:var(--accent-soft)' : ''}">
          <td>${daysLabel(r.days)}</td><td class="nowrap">${r.start} → ${r.end}${s().activeRule?.id === r.id ? html` <span class="badge live">en cours</span>` : ''}</td>
          <td><b>${r.playlist_name || '?'}</b></td>
          <td class="right"><button class="btn sm ghost icon danger" data-delrule="${r.id}" title="Supprimer">${icon('trash')}</button></td></tr>`)
        : html`<tr><td colspan="4" class="empty">Aucun créneau : les playlists en rotation tournent en continu.</td></tr>`}</tbody>
      </table></div>
      <form id="rule" class="row mt" style="gap:12px;align-items:flex-end">
        <div class="field"><span class="small" style="font-weight:600">Jours</span><div class="seg" id="days">
          ${DAYS.map(([d, l]) => html`<button type="button" data-day="${d}" class="${d <= 5 ? 'active' : ''}" title="${DAY_NAMES[d]}">${l}</button>`)}</div></div>
        <label class="field">De<input type="time" name="start" value="08:00" required></label>
        <label class="field">À<input type="time" name="end" value="12:00" required></label>
        <label class="field">Playlist<select name="playlist_id" required>${music.length ? music.map((p) => html`<option value="${p.id}">${p.name}</option>`) : html`<option value="">Créez d'abord une playlist</option>`}</select></label>
        <button class="btn primary" type="submit">${icon('plus')} Ajouter le créneau</button>
      </form>
      <p class="dim small" style="margin-bottom:0">Un créneau peut passer minuit (ex. 22:00 → 02:00). Si plusieurs créneaux se chevauchent, le premier de la liste l'emporte.
        Les insertions (jingles, flashs) continuent pendant les créneaux.</p>
    </div>`;
  }

  function render() {
    dirty = false;
    renderTopbar();
    const st = s();
    if (!st) {
      view.innerHTML = String(html`<div class="card empty">Aucune station AutoDJ. Créez-en une avec le bouton « Nouvelle station ».</div>`);
      return;
    }
    view.innerHTML = String(html`
      ${setupNeeded(st) ? html`<div class="banner admin-only"><div class="grow"><b>Flux à configurer dans Icecast.</b>
        <span class="muted">Crée les points de montage ${st.outputs.map((o) => html`<code>${o.mount}</code> `)}${st.liveMount
          ? html`et déclare <code>${st.outputs[0]?.mount}</code> comme secours de <code>${st.liveMount}</code> : un animateur qui se connecte sur ${st.liveMount} prend l'antenne, la station reprend quand il coupe.`
          : ''}</span></div>
        <button class="btn primary" data-act="setup">Configurer</button></div>` : ''}
      <div class="card" id="now">${nowCard(st)}</div>
      <div class="grid cols-2 mt">
        <div class="card flush">
          <div class="card-head"><h3>À suivre</h3></div>
          <div class="table-wrap mt"><table><tbody>
            ${st.queue.map((m, i) => html`<tr><td><span class="badge accent">Demande</span></td><td class="truncate"><b>${m.title || m.original_name}</b> <span class="dim">${m.artist || ''}</span></td>
              <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td><td class="right"><button class="btn sm ghost icon" data-unqueue="${i}" title="Retirer">${icon('x')}</button></td></tr>`)}
            ${st.upcoming.map((m) => html`<tr><td><span class="badge ${m.source === 'jingle' ? 'warn' : m.source === 'insert' ? 'info' : ''}" title="${m.playlist || ''}">${SOURCE[m.source] || ''}</span></td>
              <td class="truncate"><b>${m.title || m.original_name}</b> <span class="dim">${m.artist || ''}</span></td>
              <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td><td class="dim small truncate">${m.playlist || ''}</td></tr>`)}
            ${!st.queue.length && !st.upcoming.length ? html`<tr><td class="empty">Rien de prévu</td></tr>` : ''}
          </tbody></table></div>
          <p class="dim small" style="padding:0 20px 14px;margin:0">Pour passer un titre précis ensuite : Bibliothèque → bouton ${icon('queue')}.</p>
        </div>
        <div class="card flush">
          <div class="card-head"><h3>Derniers titres</h3></div>
          <div class="table-wrap mt"><table><tbody>
            ${st.history.length ? st.history.map((h) => html`<tr><td class="dim small nowrap">${fmtTime(h.at).slice(0, 5)}</td><td class="truncate">${h.title}</td>
              <td class="right"><span class="badge ${h.source === 'jingle' ? 'warn' : ''}">${SOURCE[h.source] || ''}</span></td></tr>`)
            : html`<tr><td class="empty">Pas encore d'historique</td></tr>`}
          </tbody></table></div>
        </div>
      </div>
      ${linksCard(st)}
      ${settingsCard(st)}
      ${scheduleCard()}`);
    player.refresh();
  }

  async function loadSchedule() {
    schedule = selectedId ? await api(`/autodj/stations/${selectedId}/schedule`) : [];
  }

  async function load() {
    const [st, pls, mt] = await Promise.all([api('/autodj'), api('/autodj/playlists'), api('/mounts')]);
    stations = st.stations;
    playlists = pls;
    mounts = mt.mounts;
    if (!s()) selectedId = stations[0]?.id || null;
    await loadSchedule();
    render();
  }

  const replace = (st) => {
    stations = stations.map((x) => (x.id === st.id ? st : x));
    render();
  };

  // Playlists de la station : enregistrées à chaque modification
  async function saveLinks(links) {
    const st = await run(null, () => api(`/autodj/stations/${selectedId}/playlists`, {
      method: 'PUT', body: { links: links.map((l) => ({ playlistId: l.playlist_id, mode: l.mode, weight: l.weight, every: l.every })) },
    })).catch(() => null);
    if (st) replace(st);
  }

  function readOutputs() {
    return $$('.output-row', view).map((r) => ({
      mount: $('[data-o=mount]', r).value.trim(),
      format: $('[data-o=format]', r).value,
      bitrate: Number($('[data-o=bitrate]', r).value),
    }));
  }

  topbar.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-station]');
    if (tab) {
      selectedId = Number(tab.dataset.station);
      history.replaceState(null, '', `#/autodj/${selectedId}`);
      await loadSchedule();
      render();
    }
    if (e.target.closest('#new-station')) {
      const st = await run(null, () => api('/autodj/stations', { method: 'POST', body: {} }), 'Station créée : choisissez ses flux et ses playlists').catch(() => null);
      if (st) {
        selectedId = st.id;
        history.replaceState(null, '', `#/autodj/${st.id}`);
        await load();
        $('#station-form [name=name]', view)?.focus();
      }
    }
  });

  view.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const act = a.dataset.act;
      const st = s();
      if (act === 'output-add') {
        const rows = readOutputs();
        $('#outputs', view).insertAdjacentHTML('beforeend', String(html`<div class="row output-row" style="gap:8px;flex-wrap:nowrap">
          <input data-o="mount" value="" list="mount-list" placeholder="/autodj-aac" style="flex:1;min-width:0" required>
          <select data-o="format"><option value="mp3">MP3</option><option value="aac" ${rows.length ? 'selected' : ''}>AAC</option></select>
          <select data-o="bitrate">${BITRATES.map((b) => html`<option value="${b}" ${b === (rows.length ? 64 : 128) ? 'selected' : ''}>${b} kbps</option>`)}</select>
          <button type="button" class="btn ghost icon danger" data-act="output-remove" title="Retirer ce flux">${icon('x')}</button></div>`));
        $$('.output-row [data-o=mount]', view).at(-1).focus();
        dirty = true;
        return;
      }
      if (act === 'output-remove') {
        if ($$('.output-row', view).length > 1) {
          a.closest('.output-row').remove();
          dirty = true;
        } else toast('Une station a au moins un flux de sortie', 'error');
        return;
      }
      if (act === 'link-add') {
        const id = Number($('#link-add', view).value);
        const p = playlists.find((x) => x.id === id);
        await saveLinks([...st.links, { playlist_id: id, mode: p?.kind === 'jingle' ? 'tracks' : 'rotation', weight: 3, every: 4 }]);
        return;
      }
      if (act === 'delete') {
        if (!await confirmDialog(`Supprimer la station « ${st.name} » ?`, 'La station s\'arrête, ses réglages, ses playlists associées et sa grille horaire sont supprimés. Les playlists et la musique restent dans la bibliothèque, et les points de montage dans Icecast.', { confirm: 'Supprimer', danger: true })) return;
        await run(a, () => api(`/autodj/stations/${st.id}`, { method: 'DELETE' }), 'Station supprimée').catch(() => null);
        selectedId = null;
        history.replaceState(null, '', '#/autodj');
        await load();
        return;
      }
      if (act === 'stop' && !await confirmDialog(`Arrêter « ${st.name} » ?`, 'Les auditeurs de ses flux n\'entendront plus rien tant qu\'aucun animateur n\'est en direct.', { confirm: 'Arrêter', danger: true })) return;
      const msg = { start: 'Station démarrée', stop: 'Station arrêtée', skip: 'Titre suivant', setup: 'Configuration prête : appliquez-la avec le bandeau « Appliquer maintenant »' }[act];
      const r = await run(a, () => api(`/autodj/stations/${st.id}/${act}`, { method: 'POST' }), msg).catch(() => null);
      if (r?.process) store.process = r.process;
      await load();
    }
    const un = e.target.closest('[data-unlink]');
    if (un) await saveLinks(s().links.filter((_, i) => i !== Number(un.dataset.unlink)));
    const uq = e.target.closest('[data-unqueue]');
    if (uq) replace(await api(`/autodj/stations/${selectedId}/queue/${uq.dataset.unqueue}`, { method: 'DELETE' }));
    const day = e.target.closest('[data-day]');
    if (day) day.classList.toggle('active');
    const del = e.target.closest('[data-delrule]');
    if (del) {
      schedule = await run(del, () => api(`/autodj/schedule/${del.dataset.delrule}`, { method: 'DELETE' }), 'Créneau supprimé');
      replace((await api('/autodj')).stations.find((x) => x.id === selectedId));
    }
  });

  view.addEventListener('input', (e) => {
    if (e.target.closest('#station-form')) dirty = true;
  });

  view.addEventListener('change', async (e) => {
    if (e.target.closest('#station-form')) dirty = true;
    const f = e.target.closest('[data-link]');
    if (!f) return;
    const links = s().links.map((l) => ({ ...l }));
    const l = links[Number(f.dataset.link)];
    l[f.dataset.field] = f.dataset.field === 'mode' ? f.value : Number(f.value);
    await saveLinks(links);
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'station-form') {
      const st = await run(f.querySelector('[type=submit]'), () => api(`/autodj/stations/${selectedId}`, {
        method: 'PUT', body: { name: f.name.value, liveMount: f.liveMount.value, crossfade: f.crossfade.checked, outputs: readOutputs() },
      }), 'Station enregistrée').catch(() => null);
      if (st) replace(st);
    }
    if (f.id === 'rule') {
      const days = $$('[data-day].active', f).map((b) => b.dataset.day).join(',');
      schedule = await run(f.querySelector('[type=submit]'), () => api(`/autodj/stations/${selectedId}/schedule`, {
        method: 'POST', body: { days, start: f.start.value, end: f.end.value, playlist_id: Number(f.playlist_id.value) },
      }), 'Créneau ajouté');
      replace((await api('/autodj')).stations.find((x) => x.id === selectedId));
    }
  });

  load();
  // Mises à jour en direct (changement de titre) et progression
  let lastKey = '';
  const off = onLive(() => {
    const live = store.autodj?.stations;
    if (!live || !stations.length) return;
    const key = live.map((x) => `${x.id}|${x.state}|${x.current?.startedAt}|${x.queue.length}|${x.upcoming.map((u) => u.id).join()}`).join(';');
    if (key === lastKey) return;
    lastKey = key;
    // Les réglages en cours de saisie ne sont pas écrasés
    if (dirty || live.length !== stations.length || $('form:focus-within', view) || $('[data-link]:focus', view)) return;
    stations = live;
    render();
  });
  const tick = setInterval(() => {
    $$('[data-progress]', view).forEach((bar) => {
      const el = (Date.now() - Number(bar.dataset.progress)) / 1000;
      const dur = Number(bar.dataset.dur);
      bar.style.width = `${Math.min(100, (el / dur) * 100)}%`;
      const lab = $('[data-elapsed]', view);
      if (lab) lab.textContent = fmtClock(Math.min(el, dur));
    });
  }, 1000);
  return () => { off(); clearInterval(tick); };
}
