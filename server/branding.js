// Personnalisation de l'interface : nom, logos, couleurs, police, thème.
// Les couleurs sont servies dans /branding.css (variables CSS), chargé après la feuille de style principale.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT, DATA_DIR, getSettings, updateSettings } from './settings.js';

const DIR = path.join(DATA_DIR, 'branding');

export const FONTS = ['Outfit', 'Inter', 'Poppins', 'Montserrat', 'Roboto', 'Nunito', 'DM Sans', 'Space Grotesk',
  'Lexend', 'Rubik', 'Sora', 'Plus Jakarta Sans', 'Manrope', 'Archivo', 'Bebas Neue'];

export const DEFAULTS = {
  name: 'RadioSMP',
  slogan: 'All The Hits, All The Music!',
  website: 'https://radiosmp.fr',
  accent: '#c05ef0',
  accent2: '#7c3aed',
  background: '#09090b',
  theme: 'dark',
  font: 'Outfit',
  logo: '',
  logoLight: '',
  favicon: '',
};

// Fichiers par défaut (identité RadioSMP), utilisés tant qu'aucune image n'a été envoyée
const BUNDLED = {
  logo: path.join(ROOT, 'public/img/logo.png'),
  logoLight: path.join(ROOT, 'public/img/logo-light.png'),
  favicon: path.join(ROOT, 'public/img/favicon.png'),
};
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };

export function branding() {
  return { ...DEFAULTS, ...(getSettings().branding || {}) };
}

// ---------- Couleurs ----------

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const rgba = (h, a) => `rgba(${rgb(h).join(', ')}, ${a})`;
const isColor = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

export function brandingCss() {
  const b = branding();
  const A = b.accent;
  const A2 = b.accent2;
  const BG = b.background;
  const font = FONTS.includes(b.font) ? b.font : DEFAULTS.font;
  const accentLight = mix(A, '#000000', 0.2); // plus foncé : lisible sur fond clair
  return `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;500;600;700;800&display=swap');

/* Généré par le dashboard (page Personnalisation) */
:root {
  --font: "${font}", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --accent: ${A};
  --accent-2: ${mix(A, '#ffffff', 0.22)};
  --accent-dim: ${mix(A, '#000000', 0.25)};
  --accent-deep: ${A2};
  --accent-soft: ${rgba(A, 0.15)};
  --accent-glow: ${rgba(A, 0.3)};
  --grad: linear-gradient(135deg, ${A} 0%, ${A2} 100%);
  --c1: ${A};
  --brand-bg: ${BG};
  --sidebar-bg: ${mix(BG, '#ffffff', 0.012)};
  --bg: ${BG};
  --bg-2: ${mix(BG, '#ffffff', 0.022)};
  --panel: ${mix(BG, '#ffffff', 0.045)};
  --panel-2: ${mix(BG, '#ffffff', 0.075)};
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --accent: ${accentLight}; --accent-2: ${A}; --accent-soft: ${rgba(accentLight, 0.1)}; --c1: ${accentLight};
  }
}
:root[data-theme="light"] {
  --accent: ${accentLight}; --accent-2: ${A}; --accent-soft: ${rgba(accentLight, 0.1)}; --c1: ${accentLight};
}
`;
}

// ---------- Routes ----------

function assetFile(kind) {
  const b = branding();
  if (b[kind]) {
    const f = path.join(DIR, b[kind]);
    if (fs.existsSync(f)) return f;
  }
  if (kind === 'logoLight' && b.logo) return assetFile('logo'); // logo envoyé sans version claire
  return BUNDLED[kind];
}

export function brandingRoutes(app, { requireAuth, logEvent }) {
  // Public : la page de connexion et les lecteurs en ont besoin
  app.get('/branding.css', (req, res) => {
    res.type('text/css').set('Cache-Control', 'no-cache').send(brandingCss());
  });
  const serve = (kind) => (req, res) => {
    // Une image SVG ouverte directement ne doit pas pouvoir exécuter de script
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.set('Cache-Control', 'no-cache');
    res.sendFile(assetFile(kind));
  };
  app.get('/branding/logo', serve('logo'));
  app.get('/branding/logo-light', serve('logoLight'));
  app.get('/branding/favicon', serve('favicon'));

  app.get('/api/branding', requireAuth, (req, res) => res.json({ ...branding(), fonts: FONTS }));

  app.put('/api/branding', requireAuth, express.json(), (req, res) => {
    const b = req.body || {};
    const str = (v, max) => String(v ?? '').trim().slice(0, max);
    for (const k of ['accent', 'accent2', 'background']) {
      if (k in b && !isColor(b[k])) return res.status(400).json({ error: 'Couleur invalide (format #RRGGBB)' });
    }
    if ('theme' in b && !['dark', 'light', 'auto'].includes(b.theme)) return res.status(400).json({ error: 'Thème invalide' });
    if ('font' in b && !FONTS.includes(b.font)) return res.status(400).json({ error: 'Police inconnue' });
    updateSettings((s) => {
      s.branding = { ...DEFAULTS, ...(s.branding || {}) };
      if ('name' in b) s.branding.name = str(b.name, 60) || DEFAULTS.name;
      for (const k of ['slogan', 'website']) if (k in b) s.branding[k] = str(b[k], 200);
      for (const k of ['accent', 'accent2', 'background', 'theme', 'font']) if (k in b) s.branding[k] = b[k];
    });
    logEvent('info', 'config', 'Personnalisation modifiée');
    res.json({ ...branding(), fonts: FONTS });
  });

  // Envoi d'une image : le fichier est le corps brut de la requête (Content-Type image/…)
  app.post('/api/branding/assets/:kind', requireAuth, express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const kind = req.params.kind;
    if (!(kind in BUNDLED)) return res.status(404).json({ error: 'Image inconnue' });
    const ext = TYPES[(req.get('content-type') || '').split(';')[0]];
    if (!ext) return res.status(400).json({ error: 'Format accepté : PNG, JPG, WebP, SVG ou ICO' });
    if (!req.body?.length) return res.status(400).json({ error: 'Fichier vide' });
    fs.mkdirSync(DIR, { recursive: true });
    const file = `${kind}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(DIR, file), req.body);
    const previous = branding()[kind];
    updateSettings((s) => { s.branding = { ...DEFAULTS, ...(s.branding || {}), [kind]: file }; });
    if (previous) fs.rmSync(path.join(DIR, previous), { force: true });
    logEvent('info', 'config', `Image de personnalisation mise à jour (${kind})`);
    res.json({ ...branding(), fonts: FONTS });
  });

  app.delete('/api/branding/assets/:kind', requireAuth, (req, res) => {
    const kind = req.params.kind;
    if (!(kind in BUNDLED)) return res.status(404).json({ error: 'Image inconnue' });
    const previous = branding()[kind];
    updateSettings((s) => { s.branding = { ...DEFAULTS, ...(s.branding || {}), [kind]: '' }; });
    if (previous) fs.rmSync(path.join(DIR, previous), { force: true });
    res.json({ ...branding(), fonts: FONTS });
  });
}
