import { api, html, icon, $, fmtNum, fmtDec, fmtDuration, fmtDateTime, fmtDay, fmtBytes, barList, country } from '../lib.js';
import { lineChart, doughnutChart, barChart } from '../charts.js';
import { rangeSelector, mountSelector } from './components.js';

const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']];
const PAGE = 50;

function heatmap(grid) {
  const max = Math.max(...grid.flat(), 0.01);
  return html`<div class="heatmap">
    <span></span>${Array.from({ length: 24 }, (_, h) => html`<span class="hlbl">${h % 3 === 0 ? `${h}h` : ''}</span>`)}
    ${DAYS.map(([d, label]) => html`<span class="lbl">${label}</span>${grid[d].map((v, h) => html`<span class="cell"
      title="${label} ${h}h–${h + 1}h : ${fmtDec(v)} auditeurs en moyenne"
      style="${v ? `background:color-mix(in srgb, var(--accent) ${Math.round(12 + (v / max) * 88)}%, var(--panel-2))` : ''}"></span>`)}`)}
  </div>`;
}

function kpi(label, value, sub = '', cls = '') {
  return html`<div class="card kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

export default function statsPage(view, { topbar }) {
  let range = '24h';
  let mount = '';
  let mounts = [];
  let page = 0;
  try { range = localStorage.getItem('flux-range') || range; } catch {}

  async function loadMounts() {
    const r = await api('/mounts').catch(() => ({ mounts: [] }));
    mounts = [...new Set(r.mounts.map((m) => m.name))];
  }

  function controls() {
    topbar.innerHTML = String(html`${mountSelector(mounts, mount)}${rangeSelector(range)}`);
  }

  topbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range] button');
    if (!b) return;
    range = b.dataset.v;
    try { localStorage.setItem('flux-range', range); } catch {}
    page = 0;
    load();
  });
  topbar.addEventListener('change', (e) => {
    if (e.target.matches('[data-mount]')) { mount = e.target.value; page = 0; load(); }
  });

  const qs = () => `range=${range}${mount ? `&mount=${encodeURIComponent(mount)}` : ''}`;

  async function load() {
    controls();
    let d;
    try {
      d = await api(`/stats/overview?${qs()}`);
    } catch (err) {
      view.innerHTML = String(html`<div class="card empty">${err.message}</div>`);
      return;
    }
    for (const m of d.mounts) if (!mounts.includes(m.mount)) mounts.push(m.mount);
    const k = d.kpis;
    const fidelity = k.uniqueListeners ? Math.round((k.returningListeners / k.uniqueListeners) * 100) : 0;
    const longRange = d.range.to - d.range.from > 2 * 86400_000;

    view.innerHTML = String(html`
      <div class="grid kpis">
        ${kpi('Pic d\'auditeurs simultanés', fmtNum(k.peak), k.peakAt ? fmtDateTime(k.peakAt) : '—', 'accent')}
        ${kpi('Moyenne simultanés', fmtDec(k.avgListeners), 'sur toute la période')}
        ${kpi('Auditeurs uniques', fmtNum(k.uniqueListeners), `${fmtNum(k.sessions)} sessions`)}
        ${kpi('Heures d\'écoute', fmtDec(k.listeningHours), 'cumul de tous les auditeurs')}
        ${kpi('Durée moyenne d\'écoute', fmtDuration(k.avgDurationSec, true), 'par session')}
        ${kpi('Fidélité', `${fidelity} %`, `${fmtNum(k.returningListeners)} déjà venus avant`)}
        ${kpi('Données envoyées', fmtBytes(k.bytesSent), `${fmtNum(k.shortSessions)} connexions éclair exclues`)}
      </div>

      <div class="card mt">
        <div class="card-head"><h2>Audience</h2><span class="dim small">auditeurs simultanés</span></div>
        <div class="chart-box"><canvas id="c-audience"></canvas></div>
      </div>

      <div class="grid cols-2 mt">
        <div class="card">
          <div class="card-head"><h2>Quand vous écoute-t-on ?</h2><span class="dim small">moyenne par jour et par heure</span></div>
          ${heatmap(d.heatmap)}
        </div>
        <div class="card">
          <div class="card-head"><h2>Durée des sessions</h2></div>
          <div class="chart-box sm"><canvas id="c-durations"></canvas></div>
        </div>
      </div>

      <div class="grid cols-3 mt">
        <div class="card">
          <div class="card-head"><h2>Lecteurs</h2><span class="dim small">heures d'écoute</span></div>
          <div class="chart-box sm"><canvas id="c-players"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Pays</h2><span class="dim small">heures d'écoute</span></div>
          <div id="countries"></div>
          <p class="dim small" style="margin:12px 0 0">Géolocalisation : <a href="https://db-ip.com" target="_blank" rel="noopener">IP Geolocation by DB-IP</a></p>
        </div>
        <div class="card">
          <div class="card-head"><h2>Systèmes</h2><span class="dim small">heures d'écoute</span></div>
          <div id="os"></div>
        </div>
      </div>

      <div class="card flush mt">
        <div class="card-head"><h2>Par flux</h2></div>
        <div class="table-wrap mt"><table>
          <thead><tr><th>Flux</th><th class="num">Pic</th><th class="num">Moyenne</th><th class="num">Auditeurs uniques</th><th class="num">Sessions</th><th class="num">Heures d'écoute</th><th class="num">Données</th></tr></thead>
          <tbody>${d.mounts.length ? d.mounts.map((m) => html`<tr>
            <td><code>${m.mount}</code></td><td class="num">${fmtNum(m.peak)}</td><td class="num">${fmtDec(m.avgListeners)}</td>
            <td class="num">${fmtNum(m.listeners)}</td><td class="num">${fmtNum(m.sessions)}</td><td class="num">${fmtDec(m.hours)}</td>
            <td class="num">${fmtBytes(m.bytes)}</td></tr>`) : html`<tr><td colspan="7" class="empty">Pas encore de données sur cette période</td></tr>`}</tbody>
        </table></div>
      </div>

      ${longRange ? html`<div class="card flush mt">
        <div class="card-head"><h2>Jour par jour</h2></div>
        <div class="table-wrap mt"><table>
          <thead><tr><th>Jour</th><th class="num">Pic</th><th class="num">Moyenne</th><th class="num">Auditeurs uniques</th><th class="num">Sessions</th><th class="num">Durée moy.</th><th class="num">Heures d'écoute</th></tr></thead>
          <tbody>${d.daily.map((x) => html`<tr>
            <td class="nowrap">${fmtDay(x.day)}</td><td class="num">${fmtNum(x.peak)}</td><td class="num">${fmtDec(x.avgListeners)}</td>
            <td class="num">${fmtNum(x.listeners || 0)}</td><td class="num">${fmtNum(x.sessions || 0)}</td>
            <td class="num">${x.avgDurationSec ? fmtDuration(x.avgDurationSec, true) : '—'}</td><td class="num">${fmtDec(x.hours || 0)}</td></tr>`)}</tbody>
        </table></div>
      </div>` : ''}

      <div class="card flush mt">
        <div class="card-head"><h2>Historique des sessions</h2><div class="spacer"></div>
          <a class="btn sm" href="/api/stats/sessions.csv?${qs()}" download>${icon('download')} Exporter en CSV</a></div>
        <div id="sessions"></div>
      </div>`);

    const t = d.range.to - d.range.from;
    lineChart($('#c-audience', view), [
      { label: 'Moyenne', data: d.series.map((p) => ({ x: p.t, y: p.avg })) },
      { label: 'Maximum', data: d.series.map((p) => ({ x: p.t, y: p.max })), fill: false, dashed: true },
    ], { timeFormat: t > 3 * 86400_000 ? 'day' : t > 26 * 3600_000 ? 'dayhour' : 'time', min: d.range.from, max: d.range.to });
    barChart($('#c-durations', view), d.durations.map((x) => x.label), d.durations.map((x) => x.sessions));
    if (d.players.length) {
      doughnutChart($('#c-players', view), d.players.slice(0, 8).map((x) => x.label), d.players.slice(0, 8).map((x) => x.hours));
    } else {
      $('#c-players', view).parentElement.innerHTML = '<div class="empty">Pas encore de données</div>';
    }
    $('#countries', view).innerHTML = String(barList(d.countries.slice(0, 10), {
      label: (x) => { const c = country(x.label); return `${c.flag} ${c.name}`; },
      value: (x) => x.hours,
      fmt: (v) => `${fmtDec(v)} h`,
    }));
    $('#os', view).innerHTML = String(barList(d.os, { value: (x) => x.hours, fmt: (v) => `${fmtDec(v)} h` }));
    loadSessions();
  }

  async function loadSessions() {
    const box = $('#sessions', view);
    if (!box) return;
    const r = await api(`/stats/sessions?${qs()}&limit=${PAGE}&offset=${page * PAGE}`);
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    box.innerHTML = String(html`
      <div class="table-wrap mt"><table>
        <thead><tr><th>Début</th><th class="num">Durée</th><th>Flux</th><th>Pays</th><th>IP</th><th>Lecteur</th><th>Système</th></tr></thead>
        <tbody>${r.rows.length ? r.rows.map((s) => {
          const c = country(s.country);
          return html`<tr>
            <td class="nowrap">${fmtDateTime(s.started_at)}</td>
            <td class="num nowrap">${fmtDuration(s.duration / 1000)}${s.active ? html` <span class="badge live">en cours</span>` : ''}</td>
            <td><code>${s.mount}</code></td><td class="nowrap">${c.flag} ${c.name}</td><td><code>${s.ip}</code></td>
            <td title="${s.user_agent}">${s.player}</td><td>${s.os}</td></tr>`;
        }) : html`<tr><td colspan="7" class="empty">Aucune session sur cette période</td></tr>`}</tbody>
      </table></div>
      <div class="row between" style="padding:12px 18px">
        <span class="dim small">${fmtNum(r.total)} sessions</span>
        <div class="row">
          <button class="btn sm" data-page="-1" ${page === 0 ? 'disabled' : ''}>← Précédent</button>
          <span class="small muted">Page ${page + 1} / ${pages}</span>
          <button class="btn sm" data-page="1" ${page + 1 >= pages ? 'disabled' : ''}>Suivant →</button>
        </div>
      </div>`);
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b) return;
    page += Number(b.dataset.page);
    loadSessions();
  });

  loadMounts().then(load);
  const refresh = setInterval(() => { if (!document.hidden) load(); }, 60_000);
  return () => clearInterval(refresh);
}
