import { api, html, icon, $, $$, run, toast, confirmDialog } from '../lib.js';

const ASSETS = [
  ['logo', 'Logo', 'Sur fond sombre (barre latérale, page de connexion). PNG transparent ou SVG conseillé.', '/branding/logo'],
  ['logoLight', 'Logo pour fond clair', 'Thème clair et rapport PDF imprimé. Si vide, le logo principal est utilisé.', '/branding/logo-light'],
  ['favicon', 'Icône d\'onglet', 'Carré, 64 × 64 px ou plus.', '/branding/favicon'],
];

const THEMES = [['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Automatique (selon l\'appareil)']];

function reloadBranding() {
  const link = $('#branding-css');
  if (link) link.href = `/branding.css?v=${Date.now()}`;
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = `/branding/favicon?v=${Date.now()}`;
  $$('img[src^="/branding/"]').forEach((img) => { img.src = `${img.src.split('?')[0]}?v=${Date.now()}`; });
}

export default function brandingPage(view, { store }) {
  let b = null;

  function render() {
    view.innerHTML = String(html`
      <p class="muted" style="margin-top:-8px">Adaptez le dashboard à l'identité de votre radio : nom, logos, couleurs, police et thème.
        Les changements s'appliquent à tout le dashboard, aux graphiques, à la page de connexion et au rapport PDF.</p>
      <div class="grid wide-left">
        <form class="card" id="brand-form">
          <div class="card-head"><h2>Identité</h2><div class="spacer"></div>
            <button class="btn" type="button" id="reset">Couleurs d'origine</button>
            <button class="btn primary" type="submit">Enregistrer</button></div>
          <div class="form-grid">
            <label class="field">Nom de la radio<input name="name" value="${b.name}" required maxlength="60"></label>
            <label class="field">Site web<input name="website" value="${b.website}" placeholder="https://"></label>
            <label class="field full">Slogan<input name="slogan" value="${b.slogan}"></label>
          </div>
          <fieldset class="mt">
            <legend>Couleurs</legend>
            <div class="form-grid">
              ${[['accent', 'Couleur principale', 'Boutons, menus, graphiques'], ['accent2', 'Couleur secondaire', 'Dégradés'],
                ['background', 'Fond (thème sombre)', 'Fond de la page et des cartes']].map(([k, label, hint]) => html`
                <label class="field">${label}<div class="input-group">
                  <input type="color" data-color="${k}" value="${b[k]}" style="width:52px;padding:3px;flex:none">
                  <input name="${k}" value="${b[k]}" pattern="#[0-9a-fA-F]{6}" maxlength="7"></div>
                  <span class="hint">${hint}</span></label>`)}
            </div>
          </fieldset>
          <fieldset class="mt">
            <legend>Texte et thème</legend>
            <div class="form-grid">
              <label class="field">Police<select name="font" style="width:100%">${b.fonts.map((f) => html`<option ${f === b.font ? 'selected' : ''}>${f}</option>`)}</select></label>
              <label class="field">Thème par défaut<select name="theme" style="width:100%">${THEMES.map(([v, l]) => html`<option value="${v}" ${v === b.theme ? 'selected' : ''}>${l}</option>`)}</select>
                <span class="hint">Chaque utilisateur peut encore basculer avec le bouton « Thème »</span></label>
            </div>
          </fieldset>
        </form>
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Aperçu</h2></div>
            <div style="background:var(--sidebar-bg);border-radius:var(--radius-sm);padding:18px;display:flex;flex-direction:column;gap:12px">
              <img src="/branding/logo" alt="" style="max-width:180px;max-height:80px;object-fit:contain;object-position:left">
              <div class="nav"><a class="active">${icon('chart')}<span>Statistiques</span></a><a>${icon('radio')}<span>Flux</span></a></div>
            </div>
            <div class="row mt"><button class="btn primary" type="button">Bouton principal</button><span class="badge accent">Badge</span>
              <span class="grad-text" style="font-size:26px;font-weight:800">${b.name}</span></div>
          </div>
          ${ASSETS.map(([kind, label, hint, url]) => html`
            <div class="card">
              <div class="card-head"><h3>${label}</h3><div class="spacer"></div>
                ${b[kind] ? html`<button class="btn sm ghost" data-del="${kind}">Revenir à l'image d'origine</button>` : html`<span class="badge">image d'origine</span>`}</div>
              <div class="row" style="align-items:center">
                <div style="background:${kind === 'logoLight' ? '#f5f4f8' : 'var(--sidebar-bg)'};border-radius:var(--radius-sm);padding:12px;min-width:120px;display:grid;place-items:center">
                  <img src="${url}" alt="" style="max-width:${kind === 'favicon' ? '48px' : '200px'};max-height:70px;object-fit:contain"></div>
                <div class="stack" style="gap:6px;flex:1;min-width:180px">
                  <span class="dim small">${hint}</span>
                  <label class="btn sm" style="align-self:flex-start">${icon('upload')} Choisir une image
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon" data-upload="${kind}" hidden></label>
                </div>
              </div>
            </div>`)}
        </div>
      </div>`);
  }

  // Aperçu immédiat des couleurs, avant enregistrement
  function preview() {
    const f = $('#brand-form', view);
    const root = document.documentElement.style;
    const ok = (v) => /^#[0-9a-f]{6}$/i.test(v);
    if (ok(f.accent.value)) {
      root.setProperty('--accent', f.accent.value);
      root.setProperty('--c1', f.accent.value);
      root.setProperty('--accent-soft', `color-mix(in srgb, ${f.accent.value} 15%, transparent)`);
    }
    if (ok(f.accent.value) && ok(f.accent2.value)) root.setProperty('--grad', `linear-gradient(135deg, ${f.accent.value} 0%, ${f.accent2.value} 100%)`);
  }
  function clearPreview() {
    ['--accent', '--c1', '--accent-soft', '--grad'].forEach((p) => document.documentElement.style.removeProperty(p));
  }

  view.addEventListener('input', (e) => {
    const picker = e.target.closest('[data-color]');
    if (picker) $(`[name="${picker.dataset.color}"]`, view).value = picker.value;
    const field = e.target.closest('input[name]');
    if (field && ['accent', 'accent2', 'background'].includes(field.name) && /^#[0-9a-f]{6}$/i.test(field.value)) {
      $(`[data-color="${field.name}"]`, view).value = field.value;
    }
    preview();
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(['name', 'website', 'slogan', 'accent', 'accent2', 'background', 'font', 'theme'].map((k) => [k, f[k].value]));
    b = await run(f.querySelector('[type=submit]'), () => api('/branding', { method: 'PUT', body }), 'Personnalisation enregistrée');
    store.branding = { ...store.branding, name: b.name, slogan: b.slogan, theme: b.theme };
    clearPreview();
    reloadBranding();
    render();
  });

  view.addEventListener('click', async (e) => {
    if (e.target.closest('#reset')) {
      if (!await confirmDialog('Revenir aux couleurs d\'origine ?', 'Couleurs, fond, police et thème reprennent les valeurs d\'origine (les logos ne changent pas).', { confirm: 'Rétablir' })) return;
      b = await run(null, () => api('/branding', { method: 'PUT', body: { accent: '#c05ef0', accent2: '#7c3aed', background: '#09090b', font: 'Outfit', theme: 'dark' } }), 'Couleurs d\'origine rétablies');
      clearPreview();
      reloadBranding();
      render();
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      b = await run(del, () => api(`/branding/assets/${del.dataset.del}`, { method: 'DELETE' }), 'Image d\'origine rétablie');
      reloadBranding();
      render();
    }
  });

  view.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-upload]');
    if (!input?.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 5 * 1024 * 1024) {
      toast('Image trop lourde (5 Mo maximum)', 'error');
      return;
    }
    try {
      const res = await fetch(`/api/branding/assets/${input.dataset.upload}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Envoi impossible');
      b = data;
      toast('Image mise à jour');
      reloadBranding();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  api('/branding').then((data) => { b = data; render(); });
  return clearPreview;
}
