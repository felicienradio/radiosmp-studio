import { api, html, $, fmtNum, fmtDec, fmtDuration, fmtDateTime, fmtTime } from '../lib.js';
import { playIcon, playUrl } from '../player.js';
import { rangeSelector, mountSelector } from './components.js';

const PAGE = 50;

function delta(v) {
  if (!v) return html`<span class="dim">0</span>`;
  return html`<span style="color:var(${v > 0 ? '--ok' : '--danger'})">${v > 0 ? '+' : ''}${fmtDec(v)}</span>`;
}

export default function tracksPage(view, { store, onLive, topbar }) {
  let range = '24h';
  let mount = '';
  let page = 0;
  let mounts = [];

  topbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range] button');
    if (b) { range = b.dataset.v; page = 0; load(); }
  });
  topbar.addEventListener('change', (e) => {
    if (e.target.matches('[data-mount]')) { mount = e.target.value; page = 0; load(); }
  });
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { page += Number(b.dataset.page); load(); }
  });

  view.innerHTML = String(html`
    <div class="card"><div class="card-head"><h2>À l'antenne</h2></div><div id="now"></div></div>
    <div class="grid cols-2 mt" style="grid-template-columns: minmax(0, 3fr) minmax(0, 2fr)">
      <div class="card flush"><div class="card-head"><h2>Historique</h2></div><div id="history"></div></div>
      <div class="card flush"><div class="card-head"><h2>Les plus diffusés</h2></div><div id="top"></div></div>
    </div>`);

  function renderNow() {
    const live = store.live?.mounts || [];
    $('#now', view).innerHTML = live.length
      ? String(html`<div class="grid mounts">${live.map((m) => html`
          <div class="now-playing">
            <button class="play-btn" data-play="${playUrl(m.mount)}" title="Écouter">${playIcon(playUrl(m.mount))}</button>
            <div class="np-text"><div class="np-label">${m.mount} · ${fmtNum(m.listeners)} auditeurs</div>
            <div class="np-title">${m.title || 'Titre non renseigné'}</div></div>
          </div>`)}</div>`)
      : '<div class="empty">Aucun flux en direct</div>';
  }

  async function load() {
    topbar.innerHTML = String(html`${mountSelector(mounts, mount)}${rangeSelector(range)}`);
    const r = await api(`/stats/tracks?range=${range}${mount ? `&mount=${encodeURIComponent(mount)}` : ''}&limit=${PAGE}&offset=${page * PAGE}`);
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    $('#history', view).innerHTML = String(html`
      <div class="table-wrap mt"><table>
        <thead><tr><th>Heure</th><th>Titre</th><th>Flux</th><th class="num">Durée</th><th class="num" title="Auditeurs au début du titre">Début</th>
          <th class="num" title="Auditeurs au maximum pendant le titre">Pic</th><th class="num" title="Différence entre la fin et le début du titre">Évolution</th></tr></thead>
        <tbody>${r.history.length ? r.history.map((t) => html`<tr>
          <td class="nowrap" title="${fmtDateTime(t.started_at)}">${fmtTime(t.started_at)}</td>
          <td class="truncate" title="${t.title}">${t.playing ? html`<span class="badge live">en cours</span> ` : ''}${t.title}</td>
          <td><code>${t.mount}</code></td>
          <td class="num nowrap">${fmtDuration((t.ended_at - t.started_at) / 1000, true)}</td>
          <td class="num">${fmtNum(t.listeners_start)}</td><td class="num">${fmtNum(t.listeners_peak)}</td>
          <td class="num">${t.playing ? html`<span class="dim">…</span>` : delta(t.listeners_end - t.listeners_start)}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">Aucun titre enregistré. Les titres sont relevés à partir des métadonnées envoyées par votre logiciel de diffusion.</td></tr>`}</tbody>
      </table></div>
      <div class="row between" style="padding:12px 18px">
        <span class="dim small">${fmtNum(r.total)} titres</span>
        <div class="row">
          <button class="btn sm" data-page="-1" ${page === 0 ? 'disabled' : ''}>←</button>
          <span class="small muted">${page + 1} / ${pages}</span>
          <button class="btn sm" data-page="1" ${page + 1 >= pages ? 'disabled' : ''}>→</button>
        </div>
      </div>`);
    $('#top', view).innerHTML = String(html`
      <div class="table-wrap mt"><table>
        <thead><tr><th>Titre</th><th class="num">Diffusions</th><th class="num" title="Pic d'auditeurs moyen pendant le titre">Pic moy.</th>
          <th class="num" title="Auditeurs gagnés ou perdus en moyenne pendant le titre">Évol. moy.</th></tr></thead>
        <tbody>${r.top.length ? r.top.map((t) => html`<tr>
          <td class="truncate" title="${t.title}">${t.title}</td><td class="num">${fmtNum(t.plays)}</td>
          <td class="num">${fmtDec(t.avg_peak)}</td><td class="num">${delta(t.avg_delta)}</td></tr>`)
        : html`<tr><td colspan="4" class="empty">Pas encore de données</td></tr>`}</tbody>
      </table></div>`);
  }

  api('/mounts').then((r) => { mounts = r.mounts.map((m) => m.name); load(); }).catch(load);
  renderNow();
  let lastKey = '';
  const off = onLive(() => {
    const key = JSON.stringify((store.live?.mounts || []).map((m) => [m.mount, m.title, m.listeners]));
    if (key === lastKey) return;
    const titleChanged = lastKey && JSON.stringify((store.live?.mounts || []).map((m) => m.title)) !== JSON.stringify(JSON.parse(lastKey).map((x) => x[1]));
    lastKey = key;
    renderNow();
    if (titleChanged && page === 0) load();
  });
  return off;
}
