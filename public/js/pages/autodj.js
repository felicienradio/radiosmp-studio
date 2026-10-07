import { api, html, icon, $, $$, run, confirmDialog, fmtClock, fmtTime } from '../lib.js';
import { player, playIcon, playUrl } from '../player.js';

const DAYS = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'J'], [5, 'V'], [6, 'S'], [7, 'D']];
const DAY_NAMES = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
const SOURCE = { playlist: 'Playlist', grille: 'Grille horaire', jingle: 'Jingle', demande: 'Demande' };
const STATE = { playing: ['ok', 'En diffusion'], starting: ['warn', 'Démarrage…'], stopping: ['warn', 'Arrêt…'], stopped: ['', 'Arrêté'], error: ['danger', 'Erreur'] };

function daysLabel(days) {
  const d = days.split(',').map(Number);
  if (d.length === 7) return 'Tous les jours';
  if (d.join() === '1,2,3,4,5') return 'Du lundi au vendredi';
  if (d.join() === '6,7') return 'Le week-end';
  return d.map((x) => DAY_NAMES[x]).join(', ');
}

export default function autodjPage(view, { store, onLive }) {
  let s = null;
  let playlists = [];
  let schedule = [];
  let mounts = [];

  function setupNeeded() {
    const auto = mounts.find((m) => m.name === s.mount && m.configured);
    const live = mounts.find((m) => m.name === s.liveMount && m.configured);
    return !auto || !live || live.fallbackMount !== s.mount;
  }

  function nowCard() {
    const [cls, label] = STATE[s.state] || ['', s.state];
    const cur = s.current;
    const dur = cur?.duration || cur?.media?.duration || 0;
    const mixPct = cur && cur.mixAt && cur.mixAt < dur ? (cur.mixAt / dur) * 100 : null;
    const elapsed = cur ? (Date.now() - cur.startedAt) / 1000 : 0;
    const url = playUrl(s.mount);
    return html`
      <div class="card-head"><h2>AutoDJ</h2><span class="badge ${cls}">${s.state === 'playing' ? html`<span class="dot live"></span>` : ''}${label}</span>
        <span class="dim small"><code>${s.mount}</code> · ${s.format.toUpperCase()} ${s.bitrate} kbps</span><div class="spacer"></div>
        ${s.state === 'playing' || s.state === 'starting'
          ? html`<button class="btn" data-act="skip">${icon('skip')} Passer</button><button class="btn danger" data-act="stop">${icon('stop')} Arrêter</button>`
          : html`<button class="btn primary" data-act="start">${icon('play')} Démarrer l'AutoDJ</button>`}
      </div>
      ${s.lastError && s.state === 'error' ? html`<div class="banner error"><div class="grow">${s.lastError}</div></div>` : ''}
      ${s.ffmpeg === false ? html`<div class="banner error"><div class="grow"><b>ffmpeg n'est pas installé.</b> Dans le conteneur : <code>apt install ffmpeg</code></div></div>` : ''}
      <div class="now-playing" style="padding:16px 18px">
        <button class="play-btn" style="width:48px;height:48px" data-play="${url}" ${s.state === 'playing' ? '' : 'disabled'} title="Écouter l'AutoDJ">${playIcon(url)}</button>
        <div class="np-text">
          <div class="np-label">${cur ? html`En cours · ${SOURCE[cur.source] || cur.source}` : 'Rien en diffusion'}</div>
          <div class="np-title" style="font-size:19px">${cur ? cur.title : s.state === 'playing' ? 'Silence : aucune playlist à jouer' : '—'}</div>
          ${cur && dur ? html`<div class="row" style="gap:10px;margin-top:8px;flex-wrap:nowrap">
            <span class="small dim" data-elapsed="${cur.startedAt}">${fmtClock(Math.min(elapsed, dur))}</span>
            <div class="meter" style="flex:1;position:relative"><div data-progress="${cur.startedAt}" data-dur="${dur}" style="width:${Math.min(100, (elapsed / dur) * 100)}%;background:var(--accent)"></div>
              ${mixPct !== null ? html`<span title="Enchaînement avec le titre suivant" style="position:absolute;top:-3px;bottom:-3px;left:${mixPct}%;width:2px;background:var(--warn);border-radius:1px"></span>` : ''}</div>
            <span class="small dim">${fmtClock(dur)}</span></div>` : ''}
        </div>
      </div>
      <div class="small dim mt">${s.activeRule
        ? html`${icon('clock')} Créneau en cours : <b>${s.activeRule.playlist_name}</b> (${daysLabel(s.activeRule.days)}, ${s.activeRule.start}–${s.activeRule.end})`
        : s.activePlaylist ? html`Playlist par défaut : <b>${s.activePlaylist.name}</b>` : html`<span style="color:var(--warn)">Aucune playlist choisie : réglez une playlist par défaut ci-dessous.</span>`}</div>`;
  }

  function render() {
    const music = playlists.filter((p) => p.kind === 'music');
    const jingles = playlists.filter((p) => p.kind === 'jingle');
    const opts = (list, val, empty) => html`<option value="">${empty}</option>${list.map((p) => html`<option value="${p.id}" ${p.id === val ? 'selected' : ''}>${p.name} (${p.count})</option>`)}`;
    view.innerHTML = String(html`
      ${setupNeeded() ? html`<div class="banner"><div class="grow"><b>Relais du direct à configurer.</b>
        <span class="muted">Crée le point de montage <code>${s.mount}</code> et le déclare comme secours de <code>${s.liveMount}</code> :
        les auditeurs de ${s.liveMount} entendent l'AutoDJ, un animateur qui se connecte prend l'antenne, et l'AutoDJ reprend quand il coupe.</span></div>
        <button class="btn primary" data-act="setup">Configurer</button></div>` : ''}
      <div class="card" id="now">${nowCard()}</div>
      <div class="grid cols-2 mt">
        <div class="card flush">
          <div class="card-head"><h3>À suivre</h3></div>
          <div class="table-wrap mt"><table><tbody>
            ${s.queue.map((m, i) => html`<tr><td><span class="badge accent">Demande</span></td><td class="truncate"><b>${m.title || m.original_name}</b> <span class="dim">${m.artist || ''}</span></td>
              <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td><td class="right"><button class="btn sm ghost icon" data-unqueue="${i}" title="Retirer">${icon('x')}</button></td></tr>`)}
            ${s.upcoming.map((m) => html`<tr><td><span class="badge ${m.source === 'jingle' ? 'warn' : ''}">${SOURCE[m.source] || ''}</span></td>
              <td class="truncate"><b>${m.title || m.original_name}</b> <span class="dim">${m.artist || ''}</span></td>
              <td class="num dim">${m.duration ? fmtClock(m.duration) : ''}</td><td></td></tr>`)}
            ${!s.queue.length && !s.upcoming.length ? html`<tr><td class="empty">Rien de prévu</td></tr>` : ''}
          </tbody></table></div>
          <p class="dim small" style="padding:0 20px 14px;margin:0">Pour passer un titre précis ensuite : Bibliothèque → bouton ${icon('queue')}.</p>
        </div>
        <div class="card flush">
          <div class="card-head"><h3>Derniers titres</h3></div>
          <div class="table-wrap mt"><table><tbody>
            ${s.history.length ? s.history.map((h) => html`<tr><td class="dim small nowrap">${fmtTime(h.at).slice(0, 5)}</td><td class="truncate">${h.title}</td>
              <td class="right"><span class="badge ${h.source === 'jingle' ? 'warn' : ''}">${SOURCE[h.source] || ''}</span></td></tr>`)
            : html`<tr><td class="empty">Pas encore d'historique</td></tr>`}
          </tbody></table></div>
        </div>
      </div>

      <form class="card mt" id="settings">
        <div class="card-head"><h2>Réglages</h2><div class="spacer"></div><button class="btn primary" type="submit">Enregistrer</button></div>
        <div class="form-grid">
          <label class="field">Playlist par défaut<select name="defaultPlaylist" style="width:100%">${opts(music, s.defaultPlaylist, '— aucune —')}</select>
            <span class="hint">Jouée en dehors des créneaux de la grille horaire</span></label>
          <div class="form-grid" style="gap:10px">
            <label class="field">Playlist de jingles<select name="jinglePlaylist" style="width:100%">${opts(jingles, s.jinglePlaylist, '— pas de jingles —')}</select></label>
            <label class="field">Un jingle tous les<div class="input-group"><input type="number" name="jingleEvery" min="0" max="50" value="${s.jingleEvery}"><span class="dim" style="align-self:center">titres</span></div></label>
          </div>
          <label class="field">Point de montage de l'AutoDJ<input name="mount" value="${s.mount}"></label>
          <label class="field">Flux direct (prioritaire)<input name="liveMount" value="${s.liveMount}">
            <span class="hint">Le point de montage des animateurs, qui a l'AutoDJ comme secours</span></label>
          <label class="field">Format<select name="format" style="width:100%">
            <option value="mp3" ${s.format === 'mp3' ? 'selected' : ''}>MP3</option><option value="aac" ${s.format === 'aac' ? 'selected' : ''}>AAC</option></select>
            <span class="hint">Utilisez le même format et le même débit que vos animateurs pour des transitions propres</span></label>
          <label class="field">Débit<select name="bitrate" style="width:100%">${[64, 96, 128, 160, 192, 256, 320].map((b) => html`<option value="${b}" ${b === s.bitrate ? 'selected' : ''}>${b} kbps</option>`)}</select></label>
          <div class="stack full" style="gap:8px">
            <label class="check"><input type="checkbox" name="crossfade" ${s.crossfade !== false ? 'checked' : ''}> Enchaînements aux points cue : le titre suivant démarre au repère « MIX », par-dessus la fin du titre en cours</label>
            <label class="check"><input type="checkbox" name="autoCue" ${s.autoCue !== false ? 'checked' : ''}> Points cue automatiques : silences du début et de la fin coupés, enchaînement placé à l'analyse de chaque nouveau titre</label>
            <span class="hint">Réglez les points cue titre par titre dans la Bibliothèque ou les Playlists (bouton ${icon('wave')}).</span>
          </div>
        </div>
      </form>

      <div class="card mt">
        <div class="card-head"><h2>Grille horaire</h2><span class="dim small">heure de la radio</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Jours</th><th>Horaires</th><th>Playlist</th><th></th></tr></thead>
          <tbody>${schedule.length ? schedule.map((r) => html`<tr style="${s.activeRule?.id === r.id ? 'background:var(--accent-soft)' : ''}">
            <td>${daysLabel(r.days)}</td><td class="nowrap">${r.start} → ${r.end}${s.activeRule?.id === r.id ? html` <span class="badge live">en cours</span>` : ''}</td>
            <td><b>${r.playlist_name || '?'}</b></td>
            <td class="right"><button class="btn sm ghost icon danger" data-delrule="${r.id}" title="Supprimer">${icon('trash')}</button></td></tr>`)
          : html`<tr><td colspan="4" class="empty">Aucun créneau : la playlist par défaut tourne en continu.</td></tr>`}</tbody>
        </table></div>
        <form id="rule" class="row mt" style="gap:12px;align-items:flex-end">
          <div class="field"><span class="small" style="font-weight:600">Jours</span><div class="seg" id="days">
            ${DAYS.map(([d, l]) => html`<button type="button" data-day="${d}" class="${d <= 5 ? 'active' : ''}" title="${DAY_NAMES[d]}">${l}</button>`)}</div></div>
          <label class="field">De<input type="time" name="start" value="08:00" required></label>
          <label class="field">À<input type="time" name="end" value="12:00" required></label>
          <label class="field">Playlist<select name="playlist_id" required>${music.length ? music.map((p) => html`<option value="${p.id}">${p.name}</option>`) : html`<option value="">Créez d'abord une playlist</option>`}</select></label>
          <button class="btn primary" type="submit">${icon('plus')} Ajouter le créneau</button>
        </form>
        <p class="dim small" style="margin-bottom:0">Un créneau peut passer minuit (ex. 22:00 → 02:00). Si plusieurs créneaux se chevauchent, le premier de la liste l'emporte.</p>
      </div>`);
    player.refresh();
  }

  async function load() {
    const [st, pls, sch, mt] = await Promise.all([api('/autodj'), api('/autodj/playlists'), api('/autodj/schedule'), api('/mounts')]);
    s = st;
    playlists = pls;
    schedule = sch;
    mounts = mt.mounts;
    render();
  }

  view.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const act = a.dataset.act;
      if (act === 'stop' && !await confirmDialog('Arrêter l\'AutoDJ ?', 'Les auditeurs qui l\'écoutent n\'entendront plus rien tant qu\'aucun animateur n\'est en direct.', { confirm: 'Arrêter', danger: true })) return;
      const msg = { start: 'AutoDJ démarré', stop: 'AutoDJ arrêté', skip: 'Titre suivant', setup: 'Configuration prête : appliquez-la avec le bandeau « Appliquer maintenant »' }[act];
      const r = await run(a, () => api(`/autodj/${act}`, { method: 'POST' }), msg).catch(() => null);
      if (r?.process) store.process = r.process;
      await load();
    }
    const uq = e.target.closest('[data-unqueue]');
    if (uq) { s = await api(`/autodj/queue/${uq.dataset.unqueue}`, { method: 'DELETE' }); render(); }
    const day = e.target.closest('[data-day]');
    if (day) day.classList.toggle('active');
    const del = e.target.closest('[data-delrule]');
    if (del) {
      schedule = await run(del, () => api(`/autodj/schedule/${del.dataset.delrule}`, { method: 'DELETE' }), 'Créneau supprimé');
      s = await api('/autodj');
      render();
    }
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'settings') {
      s = await run(f.querySelector('[type=submit]'), () => api('/autodj/settings', {
        method: 'PUT',
        body: {
          defaultPlaylist: f.defaultPlaylist.value || null, jinglePlaylist: f.jinglePlaylist.value || null,
          jingleEvery: Number(f.jingleEvery.value), mount: f.mount.value, liveMount: f.liveMount.value,
          format: f.format.value, bitrate: Number(f.bitrate.value), crossfade: f.crossfade.checked, autoCue: f.autoCue.checked,
        },
      }), 'Réglages enregistrés');
      await load();
    }
    if (f.id === 'rule') {
      const days = $$('[data-day].active', f).map((b) => b.dataset.day).join(',');
      schedule = await run(f.querySelector('[type=submit]'), () => api('/autodj/schedule', {
        method: 'POST', body: { days, start: f.start.value, end: f.end.value, playlist_id: Number(f.playlist_id.value) },
      }), 'Créneau ajouté');
      s = await api('/autodj');
      render();
    }
  });

  load();
  // Mises à jour en direct (changement de titre) et progression
  let lastKey = '';
  const off = onLive(() => {
    if (!store.autodj || !s) return;
    const key = `${store.autodj.state}|${store.autodj.current?.startedAt}|${store.autodj.queue.length}|${store.autodj.upcoming.map((u) => u.id).join()}`;
    if (key === lastKey) return;
    lastKey = key;
    s = store.autodj;
    if (!$('form:focus-within', view)) render();
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
