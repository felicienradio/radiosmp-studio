/* global L, topojson */
import { html, $, fmtNum, fmtDec, fmtDuration, fmtDateTime, fmtBytes, fmtHours, trend, insight, barList, country } from '../lib.js';
import { lineChart, doughnutChart, barChart, comboChart, stackedArea } from '../charts.js';

const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const fmtDayLabel = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function countryInsight(c) {
  if (!c) return '';
  const { name } = country(c.code);
  return `${name} est votre 1er pays (${c.share} % des auditeurs · ${fmtNum(c.unique)}).`;
}

/** Les 4 indicateurs phares d'un rapport d'audience. */
export function headlineKpis(d) {
  const k = d.kpis;
  const p = d.previous;
  return html`
    <div class="card kpi hero"><div class="kpi-label">Auditeurs uniques</div><div class="kpi-value">${fmtNum(k.uniqueListeners)}</div>
      <div class="kpi-sub">${trend(k.uniqueListeners, p?.uniqueListeners)}</div></div>
    <div class="card kpi"><div class="kpi-label">Connexions totales</div><div class="kpi-value">${fmtNum(k.connections)}</div>
      <div class="kpi-sub">${trend(k.connections, p?.connections)}</div></div>
    <div class="card kpi"><div class="kpi-label">Temps d'écoute</div><div class="kpi-value">${fmtHours(k.listeningMs)}</div>
      <div class="kpi-sub">${trend(k.listeningMs, p?.listeningMs)}</div></div>
    <div class="card kpi"><div class="kpi-label">Pays touchés</div><div class="kpi-value">${fmtNum(k.countries)}</div>
      <div class="kpi-sub">${trend(k.countries, p?.countries)}</div></div>`;
}

export function secondaryKpis(d) {
  const k = d.kpis;
  const p = d.previous;
  const loyalty = pct(k.returningListeners, k.uniqueListeners);
  return html`
    <div class="card kpi"><div class="kpi-label">Pic simultané</div><div class="kpi-value">${fmtNum(k.peak)}</div>
      <div class="kpi-sub">${k.peakAt ? fmtDateTime(k.peakAt).slice(0, -3) : '—'}</div></div>
    <div class="card kpi"><div class="kpi-label">Moyenne simultanés</div><div class="kpi-value">${fmtDec(k.avgListeners)}</div>
      <div class="kpi-sub">${trend(k.avgListeners, p?.avgListeners)}</div></div>
    <div class="card kpi"><div class="kpi-label">Durée moyenne</div><div class="kpi-value">${fmtDuration(k.avgDurationSec, true)}</div>
      <div class="kpi-sub">médiane ${fmtDuration(k.medianDurationSec, true)}</div></div>
    <div class="card kpi"><div class="kpi-label">Fidélité</div><div class="kpi-value">${loyalty} %</div>
      <div class="kpi-sub">${fmtNum(k.newListeners)} nouveaux auditeurs</div></div>
    <div class="card kpi"><div class="kpi-label">Données diffusées</div><div class="kpi-value">${fmtBytes(k.bytesSent)}</div>
      <div class="kpi-sub">${fmtNum(k.sessions)} sessions de plus de 5 s</div></div>`;
}

export function dailyChart(canvas, d) {
  return comboChart(canvas, d.days.map((x) => fmtDayLabel(x.day)), [
    { type: 'line', label: 'Auditeurs uniques', data: d.days.map((x) => x.unique), color: '#c05ef0', fill: true },
    { type: 'line', label: 'Connexions', data: d.days.map((x) => x.connections), color: '#f472b6', dashed: true },
    { type: 'bar', label: 'Minutes d\'écoute', data: d.days.map((x) => Math.round(x.hours * 60)), color: '#2ecc71', axis: 'y2', soft: true },
  ], { y2Label: 'minutes' });
}

export function hoursChart(canvas, d) {
  return comboChart(canvas, d.hours.map((x) => `${String(x.hour).padStart(2, '0')}h`), [
    { label: 'Auditeurs uniques', data: d.hours.map((x) => x.unique), color: '#c05ef0' },
    { label: 'Connexions', data: d.hours.map((x) => x.connections), color: '#f472b6', soft: true },
  ]);
}

export function weekdaysChart(canvas, d) {
  return comboChart(canvas, d.weekdays.map((x) => DAY_SHORT[x.dow]), [
    { label: 'Auditeurs uniques', data: d.weekdays.map((x) => x.unique), color: '#c05ef0' },
    { label: 'Connexions', data: d.weekdays.map((x) => x.connections), color: '#f472b6', soft: true },
  ]);
}

export function audienceChart(canvas, d, { stacked = false } = {}) {
  const t = d.range.to - d.range.from;
  const timeFormat = t > 3 * 86400_000 ? 'day' : t > 26 * 3600_000 ? 'dayhour' : 'time';
  const opts = { timeFormat, min: d.range.from, max: d.range.to };
  const names = Object.keys(d.mountSeries || {});
  if (stacked && names.length > 1) {
    return stackedArea(canvas, d.series.map((p) => p.t), names.map((n) => ({ label: n, data: d.mountSeries[n] })), opts);
  }
  return lineChart(canvas, [
    { label: 'Moyenne', data: d.series.map((p) => ({ x: p.t, y: p.avg })) },
    { label: 'Maximum', data: d.series.map((p) => ({ x: p.t, y: p.max })), fill: false, dashed: true },
  ], opts);
}

export function devicesChart(canvas, d) {
  const list = d.devices.slice(0, 7);
  if (!list.length) {
    canvas.parentElement.innerHTML = '<div class="empty">Pas encore de données</div>';
    return null;
  }
  return doughnutChart(canvas, list.map((x) => `${x.label} (${pct(x.unique, d.kpis.uniqueListeners)} %)`), list.map((x) => x.unique));
}

export function durationsChart(canvas, d) {
  return barChart(canvas, d.durations.map((x) => x.label), d.durations.map((x) => x.sessions));
}

export function topCountriesTable(d, limit = 15) {
  const list = d.countries.slice(0, limit);
  const total = d.kpis.uniqueListeners;
  if (!list.length) return html`<div class="empty">Pas encore de données</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Pays</th><th class="num">Auditeurs uniques</th><th style="width:28%">Part</th><th class="num">Heures d'écoute</th></tr></thead>
    <tbody>${list.map((c, i) => {
      const { flag, name } = country(c.code);
      const share = pct(c.unique, total);
      return html`<tr>
        <td class="nowrap"><span class="rank">${String(i + 1).padStart(2, '0')}</span>${flag} ${name}</td>
        <td class="num"><b>${fmtNum(c.unique)}</b></td>
        <td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="meter" style="flex:1"><div style="width:${share}%;background:var(--accent)"></div></div><span class="small dim" style="width:34px;text-align:right">${share} %</span></div></td>
        <td class="num">${fmtDec(c.hours)}</td></tr>`;
    })}</tbody></table></div>`;
}

export function heatmap(grid) {
  const days = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']];
  const max = Math.max(...grid.flat(), 0.01);
  return html`<div class="heatmap">
    <span></span>${Array.from({ length: 24 }, (_, h) => html`<span class="hlbl">${h % 3 === 0 ? `${h}h` : ''}</span>`)}
    ${days.map(([d, label]) => html`<span class="lbl">${label}</span>${grid[d].map((v, h) => html`<span class="cell"
      title="${label} ${h}h–${h + 1}h : ${fmtDec(v)} auditeurs en moyenne"
      style="${v ? `background:color-mix(in srgb, var(--accent) ${Math.round(12 + (v / max) * 88)}%, var(--panel-2))` : ''}"></span>`)}`)}
  </div>`;
}

export function listBlock(items, total) {
  return barList(items.slice(0, 8), {
    value: (x) => x.unique,
    fmt: (v) => `${fmtNum(v)} · ${pct(v, total)} %`,
  });
}

// ---------- Carte du monde ----------
// Fond de carte vectoriel embarqué (Natural Earth, domaine public) : pas de clé API ni de service de tuiles.

const maps = new WeakMap();
let world = null;

function loadWorld() {
  world ??= fetch('/vendor/world-atlas/countries-50m.json')
    .then((r) => r.json())
    .then((topo) => topojson.feature(topo, topo.objects.countries));
  return world;
}

export async function worldMap(el, d, { light = false } = {}) {
  maps.get(el)?.remove();
  if (typeof L === 'undefined' || typeof topojson === 'undefined') {
    el.innerHTML = '<div class="empty">Carte indisponible (bibliothèques non chargées)</div>';
    return null;
  }
  const colors = light
    ? { ocean: '#f7f6fb', land: '#e4e1ec', border: '#ffffff', fill: '#9b3fd1' }
    : { ocean: '#0c0c0f', land: '#202027', border: '#2e2e37', fill: '#c05ef0' };
  el.style.background = colors.ocean;
  const map = L.map(el, {
    scrollWheelZoom: false, zoomSnap: 0.25, minZoom: 1, maxZoom: 10,
    maxBounds: [[-75, -220], [88, 220]], worldCopyJump: false,
  });
  maps.set(el, map);
  map.setView([30, 0], 2); // Leaflet exige une vue avant d'ajouter des formes
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('Fond : Natural Earth · Géolocalisation : <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a>');

  const byNum = new Map(d.countries.filter((c) => c.num).map((c) => [c.num, c]));
  const maxCountry = Math.max(...d.countries.filter((c) => c.num).map((c) => c.unique), 1);
  const total = d.kpis.uniqueListeners;

  const features = await loadWorld();
  if (!el.isConnected || maps.get(el) !== map) return null;
  const countries = L.geoJSON(features, {
    style: (f) => {
      const c = byNum.get(String(f.id));
      return {
        color: colors.border,
        weight: 0.7,
        fillColor: c ? colors.fill : colors.land,
        fillOpacity: c ? 0.18 + 0.6 * Math.sqrt(c.unique / maxCountry) : 1,
      };
    },
    onEachFeature: (f, layer) => {
      const c = byNum.get(String(f.id));
      if (!c) return;
      const { flag, name } = country(c.code);
      layer.bindTooltip(`${flag} <b>${name}</b><br>${fmtNum(c.unique)} auditeurs uniques · ${pct(c.unique, total)} %`, { className: 'map-tip', sticky: true });
    },
  }).addTo(map);

  const maxCity = Math.max(...d.cities.map((c) => c.unique), 1);
  const markers = d.cities.map((c) => {
    const { flag, name } = country(c.country);
    return L.circleMarker([c.lat, c.lon], {
      radius: 3.5 + Math.sqrt(c.unique / maxCity) * 20,
      color: light ? '#7c3aed' : '#e9b8ff',
      weight: 1.2,
      fillColor: light ? '#9b3fd1' : '#c05ef0',
      fillOpacity: 0.65,
    }).bindTooltip(`${flag} <b>${c.city || 'Ville inconnue'}</b>, ${name}<br>${fmtNum(c.unique)} auditeur${c.unique > 1 ? 's' : ''} unique${c.unique > 1 ? 's' : ''}`,
      { className: 'map-tip', direction: 'top' }).addTo(map);
  });

  // Cadrage : sur les villes, sinon sur les pays qui écoutent, sinon le monde
  const lit = [];
  countries.eachLayer((layer) => { if (byNum.has(String(layer.feature.id))) lit.push(layer); });
  if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.35), { maxZoom: 6 });
  else if (lit.length) map.fitBounds(L.featureGroup(lit).getBounds().pad(0.1), { maxZoom: 5 });
  else map.fitWorld();
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

export function mapBlock(d, geo) {
  if (!d.cities.length) {
    return html`<div class="map" data-map></div>
      <p class="dim small" style="margin:10px 0 0">${geo?.hasCities === false
        ? html`Aucune ville localisée. Installez la base « villes » sur la page <a href="#/serveur">Serveur</a> pour afficher les points sur la carte.`
        : 'Aucune écoute localisée sur cette période.'}</p>`;
  }
  return html`<div class="map" data-map></div>`;
}

export function renderMap(root, d, opts) {
  const el = $('[data-map]', root);
  if (el) worldMap(el, d, opts);
}
