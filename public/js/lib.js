// ---------- API ----------

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith('/auth')) {
    location.reload();
    throw new Error('Session expirée');
  }
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

// ---------- HTML ----------

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Gabarit HTML : les valeurs interpolées sont échappées, sauf si elles viennent de raw(). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Formatage ----------

const nf = new Intl.NumberFormat('fr-FR');
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export const fmtNum = (n) => (n === null || n === undefined ? '—' : nf.format(n));
const nf2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
export const fmtDec = (n) => (n === null || n === undefined ? '—' : (Math.abs(n) < 1 ? nf2 : nf1).format(n));

export function fmtDuration(sec, short = false) {
  sec = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')}`;
  if (m) return short ? `${m} min` : `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtBytes(b) {
  if (!b) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${nf1.format(b / 1024 ** i)} ${u[i]}`;
}

export const fmtKbps = (k) => (k >= 1000 ? `${nf1.format(k / 1000)} Mb/s` : `${nf.format(k || 0)} kb/s`);

const dtf = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const tf = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });
const df = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateTime = (t) => (t ? dtf.format(new Date(t)) : '—');
export const fmtTime = (t) => (t ? tf.format(new Date(t)) : '—');
export const fmtDay = (t) => (t ? df.format(new Date(t)) : '—');

export function fmtAgo(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });
export function country(code) {
  // Drapeaux en SVG (flag-icons) : Windows n'affiche pas les emojis drapeaux
  const make = (flag, name) => ({ flag, name, label: html`${flag} ${name}` });
  if (!code || code === '?') return make(raw('<span class="fi fi-xx"></span>'), 'Inconnu');
  if (code === 'LAN') return make(raw('<span class="fi fi-lan"></span>'), 'Réseau local');
  let name = code;
  try { name = regionNames.of(code) || code; } catch {}
  return make(raw(`<span class="fi fi-${code.toLowerCase().replace(/[^a-z]/g, '')}"></span>`), name);
}

/** Durée d'écoute au format des rapports radio : « 659h12 ». */
export function fmtHours(ms) {
  const min = Math.round((ms || 0) / 60000);
  return `${nf.format(Math.floor(min / 60))}h${String(min % 60).padStart(2, '0')}`;
}

/** Pastille d'évolution par rapport à la période précédente. */
export function trend(cur, prev, { suffix = 'vs période préc.' } = {}) {
  if (prev === null || prev === undefined) return '';
  if (!prev) return cur ? html`<span class="trend up">nouveau</span>` : '';
  const d = Math.round(((cur - prev) / prev) * 100);
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const value = d > 999 ? `×${fmtDec(cur / prev)}` : `${Math.abs(d)} %`;
  return html`<span class="trend ${cls}">${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${value}</span><span>${suffix}</span>`;
}

export function insight(text) {
  if (!text) return '';
  return html`<div class="insight"><b>À retenir</b><span>${text}</span></div>`;
}

// ---------- Icônes (traits 24×24) ----------

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  kick: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5M22 8l-5 5"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  tag: '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  skip: '<path d="M5 4l10 8-10 8V4z" fill="currentColor"/><path d="M19 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  queue: '<path d="M3 6h18M3 12h12M3 18h8M17 15v6M14 18h6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

export function icon(name, cls = '') {
  return raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
}

// ---------- Notifications ----------

export function toast(message, type = 'ok') {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

/** Exécute une action asynchrone avec retour visuel (bouton désactivé + toast). */
export async function run(btn, fn, success) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- Dialogues ----------

export function modal({ title, body, footer = '', wide = false, onMount }) {
  const dlg = document.createElement('dialog');
  if (wide) dlg.style.width = 'min(900px, calc(100vw - 32px))';
  dlg.innerHTML = String(html`
    <div class="dlg-head"><h2>${title}</h2><button class="btn ghost icon" data-close aria-label="Fermer">${icon('x')}</button></div>
    <div class="dlg-body">${raw(String(body))}</div>
    ${footer ? html`<div class="dlg-foot">${raw(String(footer))}</div>` : ''}`);
  document.body.append(dlg);
  const close = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  dlg.showModal();
  onMount?.(dlg, close);
  return { dlg, close };
}

export function confirmDialog(title, message, { confirm = 'Confirmer', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const { dlg } = modal({
      title,
      body: html`<p style="margin:0">${message}</p>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirm}</button>`,
    });
    dlg.querySelector('[data-ok]').addEventListener('click', () => { ok = true; dlg.close(); });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

export function promptDialog(title, label, value = '', { confirm = 'Valider', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const { dlg } = modal({
      title,
      body: html`<form id="pf"><label class="field">${label}<input name="v" value="${value}" placeholder="${placeholder}" autofocus></label></form>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="pf">${confirm}</button>`,
    });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      result = dlg.querySelector('input').value;
      dlg.close();
    });
    dlg.addEventListener('close', () => resolve(result));
  });
}

// ---------- Divers ----------

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copié dans le presse-papiers');
}

/** Délégation des clics sur [data-copy] et [data-reveal] dans tout le document. */
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) copy(c.dataset.copy);
  const r = e.target.closest('[data-reveal]');
  if (r) {
    const el = r.parentElement.querySelector('.secret-value');
    const shown = el.dataset.shown === '1';
    el.textContent = shown ? '••••••••' : el.dataset.value;
    el.dataset.shown = shown ? '0' : '1';
  }
});

export function secret(value) {
  return html`<span class="secret"><code class="secret-value" data-value="${value}">••••••••</code>
    <button class="copy" data-reveal title="Afficher">${icon('eye')}</button>
    <button class="copy" data-copy="${value}" title="Copier">${icon('copy')}</button></span>`;
}

export function copyable(value, display = value) {
  return html`<span class="secret"><code>${display}</code><button class="copy" data-copy="${value}" title="Copier">${icon('copy')}</button></span>`;
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const keys = el.name.split('.');
    let target = out;
    while (keys.length > 1) {
      const k = keys.shift();
      target = target[k] ??= {};
    }
    target[keys[0]] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  return out;
}

export function barList(items, { label = (x) => x.label, value = (x) => x.value, fmt = fmtNum, empty = 'Pas encore de données' } = {}) {
  if (!items.length) return html`<div class="empty">${empty}</div>`;
  const max = Math.max(...items.map(value), 1);
  return html`<div class="bar-list">${items.map((x, i) => html`
    <div class="bar-item">
      <span class="label">${label(x)}</span><span class="val">${fmt(value(x))}</span>
      <div class="track"><div class="fill" style="width:${(value(x) / max) * 100}%;background:var(--c${(i % 6) + 1})"></div></div>
    </div>`)}</div>`;
}
