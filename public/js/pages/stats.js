import { api, html, icon, $, fmtNum, fmtDec, fmtDuration, fmtDateTime, insight, country } from '../lib.js';
import { rangeSelector, mountSelector } from './components.js';
import * as V from './statviews.js';

const PAGE = 50;

function dateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function statsPage(view, { topbar }) {
  let range = '30d';
  let custom = null; // { from, to }
  let mount = '';
  let mounts = [];
  let page = 0;
  let stacked = false;
  let data = null;
  try { range = localStorage.getItem('flux-range') || range; } catch {}

  function controls() {
    topbar.innerHTML = String(html`
      ${mountSelector(mounts, mount)}
      ${rangeSelector(custom ? '' : range)}
      <form class="row" id="custom-range" style="gap:6px">
        <input type="date" name="from" value="${dateInput(custom?.from ?? Date.now() - 30 * 86400_000)}" aria-label="Du">
        <span class="dim">→</span>
        <input type="date" name="to" value="${dateInput(custom?.to ?? Date.now())}" aria-label="Au">
        <button class="btn sm ${custom ? 'primary' : ''}" title="Période personnalisée">${icon('calendar')}</button>
      </form>`);
  }

  topbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range] button');
    if (!b) return;
    range = b.dataset.v;
    custom = null;
    try { localStorage.setItem('flux-range', range); } catch {}
    page = 0;
    load();
  });
  topbar.addEventListener('change', (e) => {
    if (e.target.matches('[data-mount]')) { mount = e.target.value; page = 0; load(); }
  });
  topbar.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const from = new Date(`${f.from.value}T00:00:00`).getTime();
    const to = new Date(`${f.to.value}T23:59:59.999`).getTime();
    if (!(from < to)) return;
    custom = { from, to };
    page = 0;
    load();
  });

  const qs = () => (custom ? `from=${custom.from}&to=${custom.to}` : `range=${range}`) + (mount ? `&mount=${encodeURIComponent(mount)}` : '');

  async function load() {
    controls();
    try {
      data = await api(`/stats/overview?${qs()}`);
    } catch (err) {
      view.innerHTML = String(html`<div class="card empty">${err.message}</div>`);
      return;
    }
    for (const m of data.mounts) if (!mounts.includes(m.mount)) mounts.push(m.mount);
    render();
  }

  function render() {
    const d = data;
    const k = d.kpis;
    const i = d.insights;
    const multiDay = d.days.length >= 2;
    const multiMount = Object.keys(d.mountSeries).length > 1;

    view.innerHTML = String(html`
      <div class="grid kpis">${V.headlineKpis(d)}</div>
      <div class="grid kpis mt">${V.secondaryKpis(d)}</div>
      ${i.trend || i.loyalty ? html`<div class="row mt">${insight([i.trend, i.loyalty].filter(Boolean).join(' '))}</div>` : ''}

      ${multiDay ? html`
        <div class="section-title"><h2>Évolution journalière</h2></div>
        <div class="card">
          <div class="card-head"><div class="desc">Auditeurs uniques et connexions par jour, avec le temps d'écoute cumulé en minutes (barres vertes, axe de droite).</div></div>
          <div class="chart-box lg"><canvas id="c-days"></canvas></div>
          ${insight(i.days)}
        </div>` : ''}

      <div class="section-title"><h2>Audience simultanée</h2></div>
      <div class="card">
        <div class="card-head"><div class="desc">Nombre d'auditeurs connectés en même temps (moyenne et maximum par intervalle).</div>
          ${multiMount ? html`<div class="spacer"></div><div class="seg" id="stack-toggle">
            <button data-s="0" class="${stacked ? '' : 'active'}">Total</button><button data-s="1" class="${stacked ? 'active' : ''}">Par flux</button></div>` : ''}</div>
        <div class="chart-box"><canvas id="c-audience"></canvas></div>
      </div>

      <div class="section-title"><h2>Quand vous écoute-t-on ?</h2></div>
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h3>Distribution horaire</h3><div class="desc">Auditeurs uniques et connexions selon l'heure de la journée, cumulés sur la période.</div></div>
          <div class="chart-box"><canvas id="c-hours"></canvas></div>
          ${insight(i.hours)}
        </div>
        <div class="card">
          <div class="card-head"><h3>Jours de la semaine</h3><div class="desc">Répartition des écoutes selon le jour de la semaine.</div></div>
          <div class="chart-box"><canvas id="c-weekdays"></canvas></div>
          ${insight(i.weekdays)}
        </div>
      </div>
      <div class="card mt">
        <div class="card-head"><h3>Carte de chaleur</h3><div class="desc">Auditeurs simultanés en moyenne, par jour et par heure (heure de ${d.range.tz}).</div></div>
        ${V.heatmap(d.heatmap)}
      </div>

      <div class="section-title"><h2>D'où vous écoute-t-on ?</h2></div>
      <div class="card">
        <div class="card-head"><h3>Carte du monde des écoutes</h3><div class="desc">Chaque point est une ville où la radio est écoutée ; sa taille reflète le nombre d'auditeurs uniques.</div></div>
        ${V.mapBlock(d, d.geo)}
        ${insight(V.countryInsight(i.countries))}
      </div>
      <div class="grid wide-left mt">
        <div class="card flush">
          <div class="card-head"><h3>Top pays</h3><div class="desc">Classement par auditeurs uniques.</div></div>
          <div class="mt">${V.topCountriesTable(d)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Villes</h3><div class="desc">Les villes qui vous écoutent le plus.</div></div>
          ${d.cities.length ? V.listBlock(d.cities.map((c) => ({ ...c, label: html`${country(c.country).flag} ${c.city || 'Inconnue'}` })), k.uniqueListeners)
            : html`<div class="empty">Pas encore de villes localisées</div>`}
        </div>
      </div>

      <div class="section-title"><h2>Comment vous écoute-t-on ?</h2></div>
      <div class="grid cols-3">
        <div class="card">
          <div class="card-head"><h3>Supports d'écoute</h3><div class="desc">Type d'appareil, d'après le user-agent.</div></div>
          <div class="chart-box sm"><canvas id="c-devices"></canvas></div>
          ${insight(i.devices)}
        </div>
        <div class="card">
          <div class="card-head"><h3>Lecteurs et applis</h3><div class="desc">Auditeurs uniques.</div></div>
          ${V.listBlock(d.players, k.uniqueListeners)}
        </div>
        <div class="card">
          <div class="card-head"><h3>Systèmes</h3><div class="desc">Auditeurs uniques.</div></div>
          ${V.listBlock(d.os, k.uniqueListeners)}
        </div>
      </div>
      <div class="grid cols-2 mt">
        <div class="card">
          <div class="card-head"><h3>Durée des sessions</h3><div class="desc">Combien de temps restent vos auditeurs (sessions de plus de 5 s).</div></div>
          <div class="chart-box sm"><canvas id="c-durations"></canvas></div>
          ${insight(i.durations)}
        </div>
        <div class="card flush">
          <div class="card-head"><h3>Par flux</h3></div>
          <div class="table-wrap mt"><table>
            <thead><tr><th>Flux</th><th class="num">Auditeurs uniques</th><th class="num">Connexions</th><th class="num">Heures d'écoute</th></tr></thead>
            <tbody>${d.mounts.length ? d.mounts.map((m) => html`<tr>
              <td><code>${m.mount}</code></td><td class="num"><b>${fmtNum(m.unique)}</b></td>
              <td class="num">${fmtNum(m.connections)}</td><td class="num">${fmtDec(m.hours)}</td></tr>`)
              : html`<tr><td colspan="4" class="empty">Pas encore de données</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>

      <div class="section-title"><h2>Historique des sessions</h2></div>
      <div class="card flush">
        <div class="card-head"><div class="desc">Chaque connexion d'auditeur de plus de 5 secondes.</div><div class="spacer"></div>
          <a class="btn sm" href="/api/stats/sessions.csv?${qs()}" download>${icon('download')} Exporter en CSV</a></div>
        <div id="sessions"></div>
      </div>
      <p class="dim small mt">Données : ${fmtNum(k.connections)} connexions du ${fmtDateTime(d.range.from)} au ${fmtDateTime(d.range.to)}.
        Géolocalisation : <a href="https://db-ip.com" target="_blank" rel="noopener">IP Geolocation by DB-IP</a>.</p>`);

    if (multiDay) V.dailyChart($('#c-days', view), d);
    V.audienceChart($('#c-audience', view), d, { stacked });
    V.hoursChart($('#c-hours', view), d);
    V.weekdaysChart($('#c-weekdays', view), d);
    V.devicesChart($('#c-devices', view), d);
    V.durationsChart($('#c-durations', view), d);
    V.renderMap(view, d, { light: document.documentElement.dataset.theme === 'light' });
    loadSessions();
  }

  async function loadSessions() {
    const box = $('#sessions', view);
    if (!box) return;
    const r = await api(`/stats/sessions?${qs()}&limit=${PAGE}&offset=${page * PAGE}`);
    const pages = Math.max(1, Math.ceil(r.total / PAGE));
    box.innerHTML = String(html`
      <div class="table-wrap mt"><table>
        <thead><tr><th>Début</th><th class="num">Durée</th><th>Flux</th><th>Localisation</th><th>Appareil</th><th>Lecteur</th><th>IP</th></tr></thead>
        <tbody>${r.rows.length ? r.rows.map((s) => {
          const c = country(s.country);
          return html`<tr>
            <td class="nowrap">${fmtDateTime(s.started_at)}</td>
            <td class="num nowrap">${fmtDuration(s.duration / 1000)}${s.active ? html` <span class="badge live">en cours</span>` : ''}</td>
            <td><code>${s.mount}</code></td>
            <td class="nowrap">${c.flag} ${s.city ? `${s.city}, ` : ''}${c.name}</td>
            <td>${s.device || '—'}</td>
            <td title="${s.user_agent}">${s.player}</td>
            <td><code>${s.ip}</code></td></tr>`;
        }) : html`<tr><td colspan="7" class="empty">Aucune session sur cette période</td></tr>`}</tbody>
      </table></div>
      <div class="row between" style="padding:12px 20px">
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
    if (b) {
      page += Number(b.dataset.page);
      loadSessions();
    }
    const s = e.target.closest('#stack-toggle button');
    if (s) {
      stacked = s.dataset.s === '1';
      $$stack(view, stacked);
      V.audienceChart($('#c-audience', view), data, { stacked });
    }
  });

  api('/mounts').then((r) => { mounts = [...new Set(r.mounts.map((m) => m.name))]; }).catch(() => {}).finally(load);
  // Rafraîchissement auto uniquement sur les périodes courtes (évite de recentrer la carte en pleine lecture)
  const refresh = setInterval(() => { if (!document.hidden && !custom && ['1h', '6h', '24h'].includes(range)) load(); }, 120_000);
  return () => clearInterval(refresh);
}

function $$stack(view, stacked) {
  view.querySelectorAll('#stack-toggle button').forEach((b) => b.classList.toggle('active', (b.dataset.s === '1') === stacked));
}

