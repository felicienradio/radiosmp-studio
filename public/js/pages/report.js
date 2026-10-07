import { api, html, icon, $, fmtNum, fmtHours, insight } from '../lib.js';
import { destroyCharts } from '../charts.js';
import * as V from './statviews.js';

const PERIODS = [['7d', '7 jours'], ['30d', '30 jours'], ['90d', '3 mois'], ['365d', '1 an'], ['month', 'Mois précédent']];

const SECTIONS = [
  ['days', 'Évolution journalière'],
  ['hours', 'Distribution horaire'],
  ['weekdays', 'Jours de la semaine'],
  ['map', 'Carte du monde des écoutes'],
  ['countries', 'Top pays'],
  ['devices', 'Supports d\'écoute'],
  ['listening', 'Durée d\'écoute et fidélité'],
];

const fmtLong = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function previousMonth() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const to = new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1;
  return { from, to };
}

export default function reportPage(view, { store, topbar }) {
  let period = '30d';
  let data = null;

  topbar.innerHTML = String(html`
    <div class="seg" id="period">${PERIODS.map(([v, l]) => html`<button data-v="${v}" class="${v === period ? 'active' : ''}">${l}</button>`)}</div>
    <button class="btn primary" id="print">${icon('printer')} Exporter en PDF</button>`);

  topbar.addEventListener('click', (e) => {
    const b = e.target.closest('#period button');
    if (b) {
      period = b.dataset.v;
      topbar.querySelectorAll('#period button').forEach((x) => x.classList.toggle('active', x === b));
      load();
    }
    if (e.target.closest('#print')) window.print();
  });

  function page(n, total, title, body) {
    const name = store.branding.name;
    return html`<section class="page">
      ${title ? html`<div class="row between"><h2>${title}</h2><span class="dim small">${name} — ${fmtLong(data.range.from)} - ${fmtLong(data.range.to)}</span></div>` : ''}
      ${body}
      <div class="page-foot"><span>Rapport généré par ${name} Studio</span><span>Page ${n} / ${total}</span></div>
    </section>`;
  }

  function render() {
    const d = data;
    const k = d.kpis;
    const i = d.insights;
    const total = SECTIONS.length + 1;
    const name = store.branding.name;
    destroyCharts(view);

    view.innerHTML = String(html`<div class="report">
      ${page(1, total, '', html`<div class="report-cover" style="margin:-34px -38px 0;padding:34px 38px;border-radius:var(--radius) var(--radius) 0 0">
          <div class="row between" style="align-items:flex-start">
            <img class="logo" src="/img/logo.png" alt="${name}">
            <div class="right"><div class="kpi-label">Rapport d'audience</div><div class="dim small">Généré le ${new Date().toLocaleDateString('fr-FR')}</div></div>
          </div>
          <h1>Statistiques d'écoute</h1>
          <div class="muted" style="font-size:16px;margin-top:4px">${name} · Période : ${fmtLong(d.range.from)} - ${fmtLong(d.range.to)}</div>
        </div>
        <div class="kpis-big">
          <div><span>Auditeurs uniques</span><b class="grad-text">${fmtNum(k.uniqueListeners)}</b></div>
          <div><span>Connexions totales</span><b>${fmtNum(k.connections)}</b></div>
          <div><span>Temps d'écoute</span><b>${fmtHours(k.listeningMs)}</b></div>
          <div><span>Pays touchés</span><b>${fmtNum(k.countries)}</b></div>
        </div>
        <div class="grid cols-2">
          <div>
            <h3>À propos de ce rapport</h3>
            <p class="muted">Ce rapport résume l'audience de ${name} sur la période choisie. Chaque page détaille un indicateur clé avec une
              lecture synthétique pour orienter la programmation et mieux connaître les auditeurs. Les chiffres proviennent directement du
              serveur de diffusion : chaque connexion d'auditeur est enregistrée.</p>
            ${i.trend ? html`<p class="muted"><b>Tendance :</b> ${i.trend}</p>` : ''}
          </div>
          <div>
            <h3>Au sommaire</h3>
            <div class="toc">${SECTIONS.map(([, label], n) => html`<div><span>${label}</span><span class="dim">p. ${n + 2}</span></div>`)}</div>
          </div>
        </div>`)}

      ${page(2, total, 'Évolution journalière', html`
        <p class="muted">Évolution jour par jour des auditeurs uniques (zone violette), du total des connexions (pointillés roses) et du temps
          d'écoute cumulé en minutes (barres vertes, axe de droite). Les pics correspondent souvent à une émission, un direct ou une campagne de promotion.</p>
        <div class="chart-box lg"><canvas id="r-days"></canvas></div>
        ${insight(i.days)}`)}

      ${page(3, total, 'Distribution horaire', html`
        <p class="muted">Répartition des écoutes selon l'heure de la journée, cumulée sur toute la période. Barres violettes : auditeurs uniques ;
          barres roses : total des connexions. Un repère précieux pour programmer vos directs et vos temps forts.</p>
        <div class="chart-box lg"><canvas id="r-hours"></canvas></div>
        ${insight(i.hours)}`)}

      ${page(4, total, 'Jours de la semaine', html`
        <p class="muted">Répartition des écoutes selon le jour de la semaine, pour repérer les journées les plus porteuses et planifier vos rendez-vous d'antenne.</p>
        <div class="chart-box lg"><canvas id="r-weekdays"></canvas></div>
        ${insight(i.weekdays)}`)}

      ${page(5, total, 'Carte du monde des écoutes', html`
        <p class="muted">Chaque point est une ville où la radio est écoutée ; sa taille reflète le nombre d'auditeurs uniques.</p>
        ${V.mapBlock(d, d.geo)}
        ${insight(V.countryInsight(i.countries))}`)}

      ${page(6, total, 'Top pays', html`
        <p class="muted">Classement des pays d'où provient votre audience, par auditeurs uniques. Utile pour adapter vos contenus, vos langues et vos horaires.</p>
        ${V.topCountriesTable(d, 20)}
        ${insight(V.countryInsight(i.countries))}`)}

      ${page(7, total, 'Supports d\'écoute', html`
        <p class="muted">Répartition estimée des auditeurs par type d'appareil, d'après le user-agent des connexions : smartphone, ordinateur,
          tablette, enceinte connectée, TV…</p>
        <div class="grid cols-2" style="align-items:center">
          <div class="chart-box lg"><canvas id="r-devices"></canvas></div>
          <div>${V.listBlock(d.devices, k.uniqueListeners)}</div>
        </div>
        ${insight(i.devices)}`)}

      ${page(8, total, 'Durée d\'écoute et fidélité', html`
        <p class="muted">Combien de temps vos auditeurs restent à l'écoute, et quelle part d'entre eux revient d'une période à l'autre.</p>
        <div class="grid kpis">${V.secondaryKpis(d)}</div>
        <div class="chart-box mt"><canvas id="r-durations"></canvas></div>
        ${insight(i.durations)}${insight(i.loyalty)}`)}
    </div>`);

    if (d.days.length >= 2) V.dailyChart($('#r-days', view), d);
    else $('#r-days', view).parentElement.innerHTML = '<div class="empty">Choisissez une période de plusieurs jours</div>';
    V.hoursChart($('#r-hours', view), d);
    V.weekdaysChart($('#r-weekdays', view), d);
    V.devicesChart($('#r-devices', view), d);
    V.durationsChart($('#r-durations', view), d);
    V.renderMap(view, d, { light: document.documentElement.dataset.theme === 'light' });
  }

  async function load() {
    view.innerHTML = '<div class="skeleton">Préparation du rapport…</div>';
    const q = period === 'month' ? (({ from, to }) => `from=${from}&to=${to}`)(previousMonth()) : `range=${period}`;
    try {
      data = await api(`/stats/overview?${q}`);
      render();
    } catch (err) {
      view.innerHTML = String(html`<div class="card empty">${err.message}</div>`);
    }
  }

  // Impression : on repasse les graphiques en couleurs claires le temps de l'export PDF
  let previousTheme = null;
  const before = () => {
    previousTheme = document.documentElement.dataset.theme ?? null;
    document.documentElement.dataset.theme = 'light';
    if (data) render();
  };
  const after = () => {
    if (previousTheme) document.documentElement.dataset.theme = previousTheme;
    else delete document.documentElement.dataset.theme;
    if (data) render();
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);

  load();
  return () => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  };
}
