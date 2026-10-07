import { api, html, $, fmtNum, fmtDec, fmtDuration, fmtKbps, fmtTime, fmtBytes } from '../lib.js';
import { lineChart } from '../charts.js';
import { mountCard, eventItem } from './components.js';
import { bindMountActions } from './mounts.js';

export default function dashboard(view, { store, onLive }) {
  let configured = [];
  let day = null;
  let events = [];
  let liveChart = null;

  view.innerHTML = String(html`
    <div class="grid kpis" id="kpis"></div>
    <div class="card mt">
      <div class="card-head"><h2>Audience en direct</h2><span class="dim small">60 dernières minutes</span></div>
      <div class="chart-box sm"><canvas id="live-chart"></canvas></div>
    </div>
    <div class="row between mt-l"><h2>Vos flux</h2><a class="btn sm" href="#/flux">Gérer les flux</a></div>
    <div class="grid mounts mt" id="mounts"></div>
    <div class="grid cols-2 mt-l">
      <div class="card">
        <div class="card-head"><h2>Dernières 24 heures</h2><div class="spacer"></div><a class="small" href="#/stats">Statistiques détaillées →</a></div>
        <div class="chart-box sm"><canvas id="day-chart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Activité récente</h2><div class="spacer"></div><a class="small" href="#/journal">Journal →</a></div>
        <div id="events"></div>
      </div>
    </div>`);

  bindMountActions(view, () => load());

  function mergedMounts() {
    const live = new Map((store.live?.mounts || []).map((m) => [m.mount, m]));
    const list = configured.map((m) => ({ ...m, live: live.get(m.name) || null }));
    for (const [name, l] of live) {
      if (!configured.some((m) => m.name === name)) list.push({ id: null, name, configured: false, live: l });
    }
    return list.sort((a, b) => (b.live?.listeners ?? -1) - (a.live?.listeners ?? -1));
  }

  function renderKpis() {
    const t = store.live?.totals || {};
    const k = day?.kpis || {};
    $('#kpis', view).innerHTML = String(html`
      <div class="card kpi accent"><div class="kpi-label">Auditeurs en direct</div><div class="kpi-value">${fmtNum(t.listeners || 0)}</div>
        <div class="kpi-sub">record : ${fmtNum(t.record || 0)}</div></div>
      <div class="card kpi"><div class="kpi-label">Pic sur 24 h</div><div class="kpi-value">${fmtNum(k.peak)}</div>
        <div class="kpi-sub">${k.peakAt ? `à ${fmtTime(k.peakAt).slice(0, 5)}` : '—'}</div></div>
      <div class="card kpi"><div class="kpi-label">Auditeurs uniques 24 h</div><div class="kpi-value">${fmtNum(k.uniqueListeners)}</div>
        <div class="kpi-sub">${fmtNum(k.sessions)} sessions</div></div>
      <div class="card kpi"><div class="kpi-label">Heures d'écoute 24 h</div><div class="kpi-value">${fmtDec(k.listeningHours)}</div>
        <div class="kpi-sub">moyenne ${fmtDec(k.avgListeners)} simultanés</div></div>
      <div class="card kpi"><div class="kpi-label">Durée moyenne d'écoute</div><div class="kpi-value">${k.avgDurationSec != null ? fmtDuration(k.avgDurationSec, true) : '—'}</div>
        <div class="kpi-sub">par session (24 h)</div></div>
      <div class="card kpi"><div class="kpi-label">Débit sortant</div><div class="kpi-value">${fmtKbps(t.kbps || 0)}</div>
        <div class="kpi-sub">${fmtBytes(k.bytesSent)} envoyés en 24 h</div></div>`);
  }

  function renderMounts() {
    const list = mergedMounts();
    $('#mounts', view).innerHTML = list.length
      ? list.map((m) => String(mountCard(m))).join('')
      : String(html`<div class="card empty">Aucun flux. <a href="#/flux">Créez votre premier point de montage</a>.</div>`);
  }

  function renderLiveChart() {
    const hist = store.history || [];
    const names = [...new Set(hist.flatMap((p) => Object.keys(p.mounts || {})))];
    const series = [{ label: 'Total', data: hist.map((p) => ({ x: p.ts, y: p.total })) }];
    if (names.length > 1) {
      names.forEach((n) => series.push({ label: n, fill: false, data: hist.map((p) => ({ x: p.ts, y: p.mounts?.[n] ?? 0 })) }));
    }
    if (liveChart && liveChart.data.datasets.length === series.length) {
      series.forEach((s, i) => { liveChart.data.datasets[i].data = s.data; });
      liveChart.options.scales.x.min = Date.now() - 3600_000;
      liveChart.options.scales.x.max = Date.now();
      liveChart.update('none');
    } else {
      liveChart = lineChart($('#live-chart', view), series, { stepped: true, min: Date.now() - 3600_000, max: Date.now() });
    }
  }

  function renderDay() {
    if (!day) return;
    lineChart($('#day-chart', view), [
      { label: 'Moyenne', data: day.series.map((p) => ({ x: p.t, y: p.avg })) },
      { label: 'Maximum', data: day.series.map((p) => ({ x: p.t, y: p.max })), fill: false, dashed: true },
    ]);
  }

  function renderEvents() {
    $('#events', view).innerHTML = events.length
      ? events.map((e) => String(eventItem(e))).join('')
      : '<div class="empty">Rien pour le moment</div>';
  }

  async function load() {
    const [m, d, e] = await Promise.all([
      api('/mounts').catch(() => null),
      api('/stats/overview?range=24h').catch(() => null),
      api('/events?limit=8').catch(() => []),
    ]);
    if (m) configured = m.mounts.filter((x) => x.configured);
    day = d;
    events = e;
    renderKpis();
    renderMounts();
    renderDay();
    renderEvents();
  }

  renderKpis();
  renderMounts();
  renderLiveChart();
  load();

  let lastMountKey = '';
  const off = onLive(() => {
    renderKpis();
    renderLiveChart();
    // On ne redessine les cartes que si quelque chose a changé
    const key = JSON.stringify((store.live?.mounts || []).map((m) => [m.mount, m.listeners, m.title, m.peak, Math.round(m.kbps / 8)]));
    if (key !== lastMountKey) {
      lastMountKey = key;
      renderMounts();
    }
  });
  const refresh = setInterval(load, 60_000);
  return () => { off(); clearInterval(refresh); };
}
