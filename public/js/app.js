import { api, html, raw, icon, $, $$, toast, run, fmtNum } from './lib.js';
import { destroyCharts } from './charts.js';
import { player, links } from './player.js';
import dashboard from './pages/dashboard.js';
import mounts from './pages/mounts.js';
import listeners from './pages/listeners.js';
import statsPage from './pages/stats.js';
import tracks from './pages/tracks.js';
import journal from './pages/journal.js';
import server from './pages/server.js';
import report from './pages/report.js';

const PAGES = [
  { path: '', label: 'Tableau de bord', icon: 'dashboard', page: dashboard },
  { path: 'flux', label: 'Flux', icon: 'radio', page: mounts },
  { path: 'auditeurs', label: 'Auditeurs', icon: 'users', page: listeners, count: true },
  { path: 'stats', label: 'Statistiques', icon: 'chart', page: statsPage },
  { path: 'rapport', label: 'Rapport d\'audience', icon: 'file', page: report },
  { path: 'titres', label: 'Titres diffusés', icon: 'music', page: tracks, sep: true },
  { path: 'journal', label: 'Journal', icon: 'list', page: journal },
  { path: 'serveur', label: 'Serveur', icon: 'server', page: server },
];

// ---------- État temps réel ----------

export const store = { live: null, history: [], process: null, branding: { name: 'RadioSMP', slogan: '' } };
const subscribers = new Set();
export function onLive(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function emit() {
  for (const fn of subscribers) {
    try { fn(store); } catch (err) { console.error(err); }
  }
  renderChrome();
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('live', (e) => {
    const data = JSON.parse(e.data);
    store.live = data;
    store.process = data.process;
    if (data.links) Object.assign(links, data.links);
    if (data.point) {
      store.history.push(data.point);
      const cutoff = Date.now() - 3600_000;
      while (store.history.length && store.history[0].ts < cutoff) store.history.shift();
    }
    emit();
  });
  es.addEventListener('process', (e) => {
    store.process = JSON.parse(e.data);
    emit();
  });
}

// ---------- Mise en page ----------

let cleanup = null;

function layout() {
  document.body.innerHTML = String(html`
    <div class="app">
      <aside class="sidebar">
        <a class="brand" href="#/">
          <img src="/img/logo.png" alt="${store.branding.name}">
          <span class="brand-sub">Studio · Icecast</span>
        </a>
        <nav class="nav">
          ${PAGES.map((p) => html`${p.sep ? raw('<div class="nav-sep"></div>') : ''}<a href="#/${p.path}" data-path="${p.path}">${icon(p.icon)}<span>${p.label}</span>${p.count ? raw('<span class="count" data-count>0</span>') : ''}</a>`)}
        </nav>
        <div class="sidebar-foot">
          <div class="server-pill" id="server-pill"></div>
          <button class="btn ghost" id="theme-btn">${icon('settings')} Thème</button>
          <button class="btn ghost" id="logout">${icon('logout')} Déconnexion</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <button class="btn icon menu-btn" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
          <h1 id="page-title"></h1>
          <div class="spacer"></div>
          <div id="topbar-extra" class="row"></div>
        </div>
        <div id="banner"></div>
        <div id="view"></div>
      </main>
    </div>`);

  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
  $('#menu-btn').addEventListener('click', () => $('.app').classList.toggle('menu-open'));
  $('.nav').addEventListener('click', () => $('.app').classList.remove('menu-open'));
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('flux-theme', next); } catch {}
    route();
  });
  $('#banner').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-apply]');
    if (!b) return;
    await run(b, () => api('/server/restart', { method: 'POST' }), 'Icecast redémarré avec la nouvelle configuration');
  });
}

const STATE_LABEL = {
  running: ['ok', 'En ligne'],
  starting: ['warn', 'Démarrage…'],
  stopping: ['warn', 'Arrêt…'],
  stopped: ['danger', 'Arrêté'],
  crashed: ['danger', 'Planté'],
  external: ['ok', 'Externe'],
};

/** Ne remplace le contenu que s'il a changé (évite de perdre un clic en cours). */
function setHtml(el, content) {
  const next = String(content);
  if (el.dataset.html === next) return;
  el.dataset.html = next;
  el.innerHTML = next;
}

function renderChrome() {
  const live = store.live;
  const proc = store.process;
  const count = $('[data-count]');
  if (count) count.textContent = fmtNum(live?.totals?.listeners || 0);

  const pill = $('#server-pill');
  if (pill && proc) {
    let [cls, label] = STATE_LABEL[proc.state] || ['', proc.state];
    if (live && !live.online && (proc.state === 'running' || proc.state === 'external')) [cls, label] = ['danger', 'Injoignable'];
    setHtml(pill, html`<span class="dot ${cls}"></span><div><b>Icecast ${label}</b>
      <span class="dim">${live?.online ? `${live.mounts.length} flux · ${fmtNum(live.totals.listeners)} auditeurs` : 'aucune donnée'}</span></div>`);
  }

  const banner = $('#banner');
  if (!banner) return;
  if (proc?.pendingRestart) {
    setHtml(banner, html`<div class="banner"><div class="grow"><b>Modifications en attente.</b>
      <span class="muted">Icecast doit redémarrer pour appliquer la nouvelle configuration (les auditeurs et sources seront coupés quelques secondes).</span></div>
      <button class="btn primary" data-apply>${icon('refresh')} Appliquer maintenant</button></div>`);
  } else if (proc && ['stopped', 'crashed'].includes(proc.state) && proc.managed) {
    setHtml(banner, html`<div class="banner error"><div class="grow"><b>Icecast est arrêté.</b>
      <span class="muted">${proc.lastError || 'Démarrez-le depuis la page Serveur.'}</span></div>
      <a class="btn" href="#/serveur">${icon('server')} Page serveur</a></div>`);
  } else if (live && !live.online && live.error) {
    setHtml(banner, html`<div class="banner error"><div class="grow"><b>Icecast ne répond pas.</b> <span class="muted">${live.error}</span></div></div>`);
  } else {
    setHtml(banner, '');
  }
}

function fresh(sel) {
  const old = $(sel);
  const el = old.cloneNode(false);
  old.replaceWith(el);
  return el;
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, ...rest] = hash.split('/');
  const entry = PAGES.find((p) => p.path === path) || PAGES[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === entry.path));
  $('#page-title').textContent = entry.label;
  document.title = `${entry.label} · ${store.branding.name}`;

  if (typeof cleanup === 'function') cleanup();
  destroyCharts($('#view'));
  // Conteneurs neufs : les écouteurs posés par la page précédente disparaissent avec eux
  const view = fresh('#view');
  const topbar = fresh('#topbar-extra');
  view.innerHTML = '<div class="skeleton">Chargement…</div>';
  cleanup = entry.page(view, { store, onLive, params: rest, topbar });
  player.refresh();
}

// ---------- Connexion ----------

function authScreen(needsSetup) {
  document.body.innerHTML = String(html`
    <div class="auth">
      <div class="card">
        <img class="logo" src="/img/logo.png" alt="${store.branding.name}">
        <div class="tagline">Studio · Gestion de la diffusion</div>
        ${needsSetup
          ? html`<h2>Bienvenue !</h2><p class="muted">Choisissez le mot de passe qui protégera votre dashboard.</p>`
          : html`<h2>Connexion</h2><p class="muted">Entrez le mot de passe du dashboard.</p>`}
        <form id="auth-form">
          <label class="field">Mot de passe<input type="password" name="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required minlength="${needsSetup ? 8 : 1}" autofocus></label>
          ${needsSetup ? html`<label class="field">Confirmation<input type="password" name="confirm" autocomplete="new-password" required></label>` : ''}
          <div class="error-text" id="auth-error"></div>
          <button class="btn primary" type="submit">${needsSetup ? 'Créer le mot de passe' : 'Se connecter'}</button>
        </form>
      </div>
    </div>`);
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (needsSetup && f.password.value !== f.confirm.value) {
      $('#auth-error').textContent = 'Les deux mots de passe ne correspondent pas';
      return;
    }
    try {
      await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body: { password: f.password.value } });
      start();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });
}

async function start() {
  layout();
  try {
    const live = await api('/live');
    store.live = live;
    store.history = live.history || [];
    store.process = live.process;
    Object.assign(links, live.links || {});
  } catch {}
  connectStream();
  window.addEventListener('hashchange', route);
  route();
  renderChrome();
}

async function boot() {
  try {
    const t = localStorage.getItem('flux-theme');
    if (t) document.documentElement.dataset.theme = t;
  } catch {}
  const state = await api('/auth/state');
  if (state.branding?.name) store.branding = state.branding;
  if (state.authed) start();
  else authScreen(state.needsSetup);
}

boot();
