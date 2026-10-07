import { api, html, icon, $, $$ } from '../lib.js';
import { eventItem } from './components.js';

const TYPES = [
  ['', 'Tout'], ['source_connect', 'Connexions de sources'], ['source_disconnect', 'Déconnexions de sources'],
  ['server', 'Serveur'], ['server_offline', 'Pannes'], ['config', 'Configuration'], ['record', 'Records'],
];
const LOGS = [['error', 'Journal Icecast'], ['access', 'Accès (auditeurs)'], ['console', 'Console']];

export default function journalPage(view) {
  let tab = 'events';
  let type = '';
  let timer = null;

  view.innerHTML = String(html`
    <div class="tabs">
      <button data-tab="events" class="active">Événements</button>
      ${LOGS.map(([k, l]) => html`<button data-tab="${k}">${l}</button>`)}
    </div>
    <div id="pane"></div>`);

  view.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) {
      tab = t.dataset.tab;
      $$('[data-tab]', view).forEach((b) => b.classList.toggle('active', b === t));
      load();
    }
    if (e.target.closest('[data-reload]')) load();
  });
  view.addEventListener('change', (e) => {
    if (e.target.matches('[data-type]')) { type = e.target.value; load(); }
  });

  async function load() {
    const pane = $('#pane', view);
    if (tab === 'events') {
      const events = await api(`/events?limit=300${type ? `&type=${type}` : ''}`);
      pane.innerHTML = String(html`<div class="card">
        <div class="card-head"><h2>Événements</h2><div class="spacer"></div>
          <select data-type>${TYPES.map(([v, l]) => html`<option value="${v}" ${v === type ? 'selected' : ''}>${l}</option>`)}</select></div>
        ${events.length ? events.map(eventItem) : html`<div class="empty">Aucun événement</div>`}
      </div>`);
      return;
    }
    const r = await api(`/server/logs?file=${tab}&lines=400`);
    const keepBottom = !$('.log', pane) || $('.log', pane).scrollTop + $('.log', pane).clientHeight >= $('.log', pane).scrollHeight - 20;
    pane.innerHTML = String(html`<div class="card">
      <div class="card-head"><h2>${r.file}</h2><span class="dim small">400 dernières lignes · actualisé toutes les 5 s</span><div class="spacer"></div>
        <button class="btn sm" data-reload>${icon('refresh')} Actualiser</button></div>
      <div class="log">${r.lines.length ? r.lines.map((l) => html`<div class="${(l.match(/\] (EROR|WARN|INFO|DBUG)/) || [])[1] || ''}">${l}</div>`) : html`<span class="dim">Fichier vide</span>`}</div>
    </div>`);
    const log = $('.log', pane);
    if (keepBottom) log.scrollTop = log.scrollHeight;
  }

  load();
  timer = setInterval(() => { if (tab !== 'events' && !document.hidden) load(); }, 5000);
  return () => clearInterval(timer);
}

