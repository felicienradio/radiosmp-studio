import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { ROOT, loadSettings, getSettings, updateSettings, randomPassword, detectIcecastPaths } from './settings.js';
import { db, tx, logEvent, backfillSessions } from './db.js';
import { parseUserAgent } from './useragent.js';
import { IcecastApi, IcecastError } from './icecast/api.js';
import { IcecastProcess, LOG_DIR, readTail } from './icecast/process.js';
import { Collector } from './collector.js';
import * as stats from './stats.js';
import { initGeo, geoStatus, downloadGeo, lookup } from './geo.js';
import { authRoutes, requireAuth, authorize, accountRoutes } from './auth.js';
import { relayStream, relayStatus, playlist, relayCount } from './streamproxy.js';
import { updateStatus, requestUpdate, watchUpdates } from './update.js';
import { brandingRoutes } from './branding.js';
import { AutoDJManager } from './autodj/manager.js';
import { autodjRoutes } from './autodj/routes.js';
import { migrateStations, stationsUsingMount, updateStation, setEnabled } from './autodj/stations.js';

// Stabilité : une erreur imprévue est journalisée au lieu d'arrêter le dashboard (et donc l'AutoDJ)
process.on('unhandledRejection', (err) => {
  console.error('Erreur non gérée :', err);
  try { logEvent('error', 'dashboard', `Erreur interne : ${err?.message || err}`); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('Exception non gérée :', err);
  try { logEvent('error', 'dashboard', `Erreur interne : ${err?.message || err}`); } catch {}
});

const settings = loadSettings();
const ice = () => getSettings().icecast;
const proc = new IcecastProcess(ice, (level, type, msg) => logEvent(level, type, msg));
// Tant qu'Icecast n'a pas été redémarré, on l'interroge avec les réglages qu'il utilise réellement
const api = new IcecastApi(() => (ice().managed && proc.state === 'running' && proc.applied) || ice());
const collector = new Collector({ api, proc, getSettings });
// L'AutoDJ unique des versions précédentes devient la première station
migrateStations(settings.autodj, `${settings.branding?.name || 'Radio'} AutoDJ`);
const autodj = new AutoDJManager({
  // réglages avec lesquels Icecast tourne réellement (port, mots de passe des flux)
  getIcecast: () => (proc.state === 'running' && proc.applied) || ice(),
  api,
  log: (level, type, msg) => logEvent(level, type, msg),
});

await initGeo();
// Sessions enregistrées avant l'ajout du type d'appareil
const filled = backfillSessions({ parseUserAgent, lookup });
if (filled) console.log(`${filled} sessions complétées (type d'appareil)`);

const app = express();
app.disable('x-powered-by');
// Reverse proxy (Caddy, Nginx…) sur la machine ou le réseau local : on lit l'IP réelle des visiteurs
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    const status = err.status || (err instanceof IcecastError ? 502 : 400);
    if (status >= 500 && !(err instanceof IcecastError)) console.error(err);
    res.status(status).json({ error: err.message });
  }
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

authRoutes(app, { logEvent });
// Toute l'API demande d'être connecté, et chaque rôle n'a accès qu'à ce qui le concerne (voir users.js)
app.use('/api', requireAuth, authorize);
accountRoutes(app, { wrap, logEvent });
brandingRoutes(app, { requireAuth, logEvent });

// Adresse publique des flux : déduite automatiquement la première fois que le dashboard est ouvert
// en HTTPS par un nom de domaine (ex. https://icecast.radiosmp.fr) → liens https://domaine/<mount>
app.use('/api', (req, res, next) => {
  const host = req.get('host') || '';
  if (!ice().publicUrl && req.secure && host && !/^(localhost|\[|\d+\.\d+\.\d+\.\d+)/i.test(host)) {
    updateSettings((s) => { s.icecast.publicUrl = `https://${host}`; });
    logEvent('info', 'config', `Adresse publique des flux détectée : https://${host}`);
  }
  next();
});

// ---------- Temps réel ----------

const clients = new Set();
function links() {
  const i = ice();
  const publicBase = i.publicUrl || (i.managed ? `http://${i.hostname}:${i.publicPort || i.port}` : i.apiUrl.replace(/\/+$/, ''));
  return { publicBase, managed: i.managed, port: i.port, relay: i.managed };
}
app.get('/api/live', (req, res) => res.json({ ...collector.live, history: collector.history, process: proc.status(), links: links() }));
app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
collector.on('update', (live) => broadcast('live', { ...live, point: collector.history.at(-1), process: proc.status(), links: links() }));
let autodjTimer = null;
autodj.on('change', () => {
  clearTimeout(autodjTimer);
  autodjTimer = setTimeout(() => broadcast('autodj', autodj.status()), 150);
});
proc.on('state', (status) => broadcast('process', status));
setInterval(() => broadcast('ping', Date.now()), 25_000);
// Nouvelle version sur GitHub : notification en direct dans le dashboard et ligne dans le journal
watchUpdates((u, { first }) => {
  // Envoyé à tous les comptes connectés : seulement l'état, pas le journal ni la clé de déploiement
  broadcast('update', { state: u.state, latest: u.latest, commits: u.commits, supported: u.supported });
  if (!first && u.state === 'available') {
    logEvent('info', 'config', `Nouvelle version disponible : ${u.commits[0]?.subject || u.latest?.slice(0, 7) || ''}`);
  }
});

// ---------- Statistiques ----------

app.get('/api/stats/overview', wrap((req) => ({ ...stats.overview(req.query), geo: geoStatus() })));
app.get('/api/stats/tracks', wrap((req) => stats.tracks(req.query)));
app.get('/api/stats/sessions', wrap((req) => stats.sessions(req.query)));
app.get('/api/stats/sessions.csv', (req, res) => {
  try {
    const csv = stats.sessionsCsv(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sessions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/events', wrap((req) => stats.events(req.query)));

// ---------- Auditeurs ----------

app.post('/api/listeners/kick', wrap(async (req) => {
  const { mount, id } = req.body;
  await api.killClient(mount, id);
  logEvent('info', 'listener_kick', `Auditeur ${id} déconnecté manuellement`, mount);
}));

app.post('/api/listeners/move', wrap(async (req) => {
  const { mount, destination } = req.body;
  await api.moveClients(mount, destination);
  logEvent('info', 'listeners_move', `Auditeurs déplacés vers ${destination}`, mount);
}));

// ---------- Points de montage ----------

const MOUNT_FIELDS = {
  name: 'string', streamName: 'string', description: 'string', genre: 'string', url: 'string',
  maxListeners: 'number', username: 'string', password: 'string', fallbackMount: 'string',
  fallbackOverride: 'boolean', fallbackWhenFull: 'boolean', hidden: 'boolean', public: 'boolean',
  relayUrl: 'string', onDemand: 'boolean', startMode: 'string',
};

function cleanMount(input, existingId) {
  const m = { id: existingId || crypto.randomUUID() };
  for (const [k, type] of Object.entries(MOUNT_FIELDS)) {
    const v = input[k];
    if (type === 'string') m[k] = String(v ?? '').trim();
    else if (type === 'number') m[k] = Math.max(0, Math.floor(Number(v) || 0));
    else m[k] = !!v;
  }
  // Buffer : « instant » = le son part au clic (quelques secondes d'avance), « lowlatency » = buffer 0, au plus près du direct
  if (!['instant', 'lowlatency'].includes(m.startMode)) m.startMode = 'lowlatency';
  if (!m.name.startsWith('/')) m.name = '/' + m.name;
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(m.name) || m.name.includes('..') || m.name.startsWith('/admin')) {
    throw fail('Nom de point de montage invalide (lettres, chiffres, . _ - / uniquement, ex. /live ou /radio.mp3)');
  }
  if (m.fallbackMount && !m.fallbackMount.startsWith('/')) m.fallbackMount = '/' + m.fallbackMount;
  if (m.fallbackMount === m.name) throw fail('Le flux de secours doit être un autre point de montage');
  if (m.relayUrl && !/^https?:\/\/.+/i.test(m.relayUrl)) throw fail('L\'URL du relais doit commencer par http:// ou https://');
  // Chaque point de montage a son propre mot de passe de diffusion
  if (!m.relayUrl && !m.password) m.password = randomPassword();
  if (!m.username) m.username = 'source';
  if (m.password && m.password.length < 4) throw fail('Le mot de passe de diffusion doit faire au moins 4 caractères');
  if (/[<>&"\s]/.test(m.password) || /[<>&"\s:]/.test(m.username)) {
    throw fail('Mot de passe et utilisateur : pas d\'espaces ni de < > & " (ni : pour l\'utilisateur)');
  }
  return m;
}

function mountsView() {
  const live = new Map(collector.live.mounts.map((m) => [m.mount, m]));
  const configured = ice().mounts.map((m) => ({ ...m, configured: true, live: live.get(m.name) || null }));
  const extra = [...live.values()]
    .filter((l) => !ice().mounts.some((m) => m.name === l.mount))
    .map((l) => ({ id: null, name: l.mount, configured: false, live: l }));
  return [...configured, ...extra];
}

/** Flux qui n'existent plus que dans les statistiques (ni configurés, ni en direct). */
function archivedMounts() {
  const known = new Set(mountsView().map((m) => m.name));
  return db.prepare(`SELECT mount, COUNT(*) AS sessions, MAX(COALESCE(ended_at, last_seen)) AS last FROM sessions GROUP BY mount
    UNION ALL SELECT mount, 0, MAX(ts) FROM samples GROUP BY mount`).all()
    .reduce((acc, r) => {
      if (known.has(r.mount)) return acc;
      const a = acc.find((x) => x.mount === r.mount) || (acc.push({ mount: r.mount, sessions: 0, last: 0 }), acc[acc.length - 1]);
      a.sessions += r.sessions;
      a.last = Math.max(a.last, r.last || 0);
      return acc;
    }, [])
    .sort((a, b) => b.last - a.last);
}

app.get('/api/mounts', wrap((req) => {
  const role = req.user.role;
  const connection = connectionInfo();
  // Le mot de passe source global n'est montré qu'aux administrateurs ; les comptes en lecture seule ne voient aucun mot de passe
  if (role !== 'admin') delete connection.sourcePassword;
  const mounts = role === 'viewer' ? mountsView().map((m) => ({ ...m, password: m.password ? '••••••••' : '' })) : mountsView();
  return { mounts, archived: archivedMounts(), process: proc.status(), connection };
}));

app.post('/api/mounts', wrap((req) => {
  const m = cleanMount(req.body);
  if (ice().mounts.some((x) => x.name === m.name)) throw fail('Ce point de montage existe déjà');
  updateSettings((s) => s.icecast.mounts.push(m));
  logEvent('info', 'config', `Point de montage ${m.name} créé`, m.name);
  return { mount: m, process: proc.status() };
}));

app.put('/api/mounts/:id', wrap((req) => {
  const idx = ice().mounts.findIndex((x) => x.id === req.params.id);
  if (idx < 0) throw fail('Point de montage introuvable', 404);
  const m = cleanMount(req.body, req.params.id);
  if (ice().mounts.some((x, i) => i !== idx && x.name === m.name)) throw fail('Ce point de montage existe déjà');
  updateSettings((s) => { s.icecast.mounts[idx] = m; });
  logEvent('info', 'config', `Point de montage ${m.name} modifié`, m.name);
  return { mount: m, process: proc.status() };
}));

app.post('/api/mounts/:id/password', wrap((req) => {
  const idx = ice().mounts.findIndex((x) => x.id === req.params.id);
  if (idx < 0) throw fail('Point de montage introuvable', 404);
  const password = randomPassword();
  updateSettings((s) => { s.icecast.mounts[idx].password = password; });
  logEvent('info', 'config', 'Nouveau mot de passe de diffusion généré', ice().mounts[idx].name);
  return { password, process: proc.status() };
}));

/** Efface l'historique d'un flux (auditeurs, courbes, titres, journal). */
function purgeMountStats(name) {
  tx(() => {
    for (const t of ['samples', 'sessions', 'tracks', 'events']) db.prepare(`DELETE FROM ${t} WHERE mount = ?`).run(name);
  });
}

app.delete('/api/mounts/:id', wrap(async (req) => {
  const m = ice().mounts.find((x) => x.id === req.params.id);
  if (!m) throw fail('Point de montage introuvable', 404);
  updateSettings((s) => {
    s.icecast.mounts = s.icecast.mounts.filter((x) => x.id !== m.id);
    // Les flux qui l'utilisaient comme secours n'en ont plus
    for (const x of s.icecast.mounts) if (x.fallbackMount === m.name) x.fallbackMount = '';
  });
  // Une station AutoDJ diffusait sur ce flux : il est retiré de ses sorties (et la station s'arrête s'il n'en reste aucune)
  for (const st of stationsUsingMount(m.name)) {
    const outputs = st.outputs.filter((o) => o.mount !== m.name);
    if (outputs.length) {
      updateStation(st.id, { outputs });
      await autodj.restart(st.id);
    } else {
      setEnabled(st.id, false);
      await autodj.player(st.id).stop();
    }
  }
  // Un encodeur encore connecté est déconnecté
  if (collector.live.mounts.some((l) => l.mount === m.name)) await api.killSource(m.name).catch(() => {});
  if (req.query.stats === '1') purgeMountStats(m.name);
  logEvent('info', 'config', `Point de montage ${m.name} supprimé${req.query.stats === '1' ? ' avec ses statistiques' : ''}`);
  return { process: proc.status() };
}));

// Flux qui n'existe plus que dans les statistiques (ancien point de montage) : on efface son historique
app.delete('/api/mounts-stats', wrap((req) => {
  const name = String(req.query.mount || '');
  if (!name.startsWith('/')) throw fail('Point de montage invalide');
  if (ice().mounts.some((x) => x.name === name)) throw fail('Ce flux est encore configuré : supprimez-le depuis la page Points de montage');
  purgeMountStats(name);
  logEvent('info', 'config', `Statistiques du flux ${name} effacées`);
}));

app.post('/api/mounts/metadata', wrap(async (req) => {
  const { mount, song } = req.body;
  if (!song?.trim()) throw fail('Titre vide');
  await api.updateMetadata(mount, song.trim());
}));

app.post('/api/mounts/kill-source', wrap(async (req) => {
  await api.killSource(req.body.mount);
  logEvent('warning', 'source_kick', 'Source coupée depuis le dashboard', req.body.mount);
}));

app.post('/api/mounts/fallback', wrap(async (req) => {
  await api.setFallback(req.body.mount, req.body.fallback || '');
}));

function connectionInfo() {
  const i = ice();
  return {
    host: i.hostname, port: i.port, publicPort: i.publicPort || i.port, sourceUser: 'source', sourcePassword: i.sourcePassword,
    managed: i.managed, apiUrl: i.apiUrl, publicUrl: i.publicUrl || '',
  };
}

// ---------- Serveur Icecast ----------

function serverView() {
  const i = ice();
  return {
    process: proc.status(),
    live: { online: collector.live.online, error: collector.live.error, server: collector.live.server },
    settings: {
      managed: i.managed, binary: i.binary, autoStart: i.autoStart, autoRestart: i.autoRestart, apiUrl: i.apiUrl,
      hostname: i.hostname, port: i.port, publicPort: i.publicPort || 0, location: i.location, adminEmail: i.adminEmail, publicUrl: i.publicUrl || '',
      adminUser: i.adminUser, adminPassword: i.adminPassword, sourcePassword: i.sourcePassword, relayPassword: i.relayPassword,
      limits: i.limits,
    },
    collector: getSettings().collector,
    timezone: getSettings().timezone,
    branding: getSettings().branding,
    platform: process.platform,
    dashboard: { host: getSettings().dashboard.host, port: getSettings().dashboard.port },
    geo: geoStatus(),
    relayListeners: relayCount(),
    icecastAdminUrl: `http://${i.managed ? '127.0.0.1:' + i.port : i.apiUrl.replace(/^https?:\/\//, '')}/admin/`,
  };
}

app.get('/api/server', wrap(serverView));

app.put('/api/server/settings', wrap((req) => {
  const b = req.body;
  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const int = (v, min, max) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw fail(`Valeur hors limites (${min}–${max})`);
    return n;
  };
  const pwd = (v, label) => {
    const p = str(v, 100);
    if (p.length < 4) throw fail(`${label} : 4 caractères minimum`);
    if (/[<>&"\s]/.test(p)) throw fail(`${label} : pas d'espaces ni de < > & "`);
    return p;
  };
  updateSettings((s) => {
    const i = s.icecast;
    if ('managed' in b) i.managed = !!b.managed;
    if ('binary' in b && str(b.binary, 500) !== i.binary) {
      i.binary = str(b.binary, 500);
      Object.assign(i, detectIcecastPaths(i.binary));
    }
    if ('autoStart' in b) i.autoStart = !!b.autoStart;
    if ('autoRestart' in b) i.autoRestart = !!b.autoRestart;
    if ('apiUrl' in b) i.apiUrl = str(b.apiUrl, 300);
    if ('hostname' in b) i.hostname = str(b.hostname) || 'localhost';
    if ('publicUrl' in b) {
      const u = str(b.publicUrl, 300).replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u)) throw fail('Adresse publique des flux invalide (ex. https://icecast.radiosmp.fr)');
      i.publicUrl = u;
    }
    if ('port' in b) i.port = int(b.port, 1, 65535);
    // Port vu depuis Internet (redirection de la box ou NAT différente) : 0 = le même que celui d'Icecast
    if ('publicPort' in b) i.publicPort = b.publicPort === '' || b.publicPort === null ? 0 : int(b.publicPort, 0, 65535);
    if ('location' in b) i.location = str(b.location);
    if ('adminEmail' in b) i.adminEmail = str(b.adminEmail);
    if ('adminUser' in b) i.adminUser = str(b.adminUser, 50) || 'admin';
    if ('adminPassword' in b) i.adminPassword = pwd(b.adminPassword, 'Mot de passe admin');
    if ('sourcePassword' in b) i.sourcePassword = pwd(b.sourcePassword, 'Mot de passe source');
    if ('relayPassword' in b) i.relayPassword = pwd(b.relayPassword, 'Mot de passe relais');
    if (b.limits) {
      const l = b.limits;
      if ('clients' in l) i.limits.clients = int(l.clients, 1, 100000);
      if ('sources' in l) i.limits.sources = int(l.sources, 1, 1000);
      if ('burstSize' in l) i.limits.burstSize = int(l.burstSize, 0, 10_000_000);
      if ('queueSize' in l) i.limits.queueSize = int(l.queueSize, 1024, 100_000_000);
      if ('clientTimeout' in l) i.limits.clientTimeout = int(l.clientTimeout, 1, 3600);
      if ('headerTimeout' in l) i.limits.headerTimeout = int(l.headerTimeout, 1, 3600);
      if ('sourceTimeout' in l) i.limits.sourceTimeout = int(l.sourceTimeout, 1, 3600);
    }
    if ('timezone' in b) {
      try {
        new Intl.DateTimeFormat('fr-FR', { timeZone: b.timezone });
      } catch {
        throw fail('Fuseau horaire inconnu (exemple : Europe/Paris)');
      }
      s.timezone = b.timezone;
    }
    if (b.branding) {
      if ('name' in b.branding) s.branding.name = str(b.branding.name, 60) || 'Ma radio';
      if ('slogan' in b.branding) s.branding.slogan = str(b.branding.slogan, 120);
      if ('website' in b.branding) s.branding.website = str(b.branding.website, 200);
    }
    if (b.collector) {
      if ('intervalSec' in b.collector) s.collector.intervalSec = int(b.collector.intervalSec, 2, 300);
      if ('retentionDays' in b.collector) s.collector.retentionDays = int(b.collector.retentionDays, 0, 3650);
    }
  });
  logEvent('info', 'config', 'Réglages du serveur modifiés');
  return serverView();
}));

app.post('/api/server/generate-password', wrap(() => ({ password: randomPassword() })));

app.post('/api/server/:action', wrap(async (req) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) throw fail('Action inconnue', 404);
  await proc[action]();
  return serverView();
}));

app.get('/api/server/logs', wrap((req) => {
  const files = { error: 'error.log', access: 'access.log', console: 'console.log' };
  const file = files[req.query.file] || files.error;
  const lines = Math.min(Number(req.query.lines) || 300, 5000);
  const text = readTail(path.join(LOG_DIR, file), 512 * 1024).split(/\r?\n/).filter(Boolean).slice(-lines);
  return { file, lines: text };
}));

app.get('/api/server/config', wrap(() => ({
  file: proc.configFile,
  xml: fs.existsSync(proc.configFile) ? fs.readFileSync(proc.configFile, 'utf8') : '',
})));

app.post('/api/geo/download', wrap(async (req) => {
  const kind = req.body?.kind === 'country' ? 'country' : 'city';
  const r = await downloadGeo(kind);
  // Localise aussi les auditeurs déjà enregistrés
  const n = backfillSessions({ parseUserAgent, lookup, geo: true });
  logEvent('info', 'config', `Base GeoIP ${kind === 'city' ? 'villes' : 'pays'} installée (${r.month}), ${n} sessions localisées`);
  return geoStatus();
}));


app.get('/api/update', wrap(() => updateStatus()));
app.post('/api/update/check', wrap(() => { requestUpdate('check'); return updateStatus(); }));
app.post('/api/update/run', wrap(() => {
  requestUpdate('update');
  logEvent('info', 'config', 'Mise à jour depuis GitHub lancée');
  return updateStatus();
}));

// ---------- Interface ----------

autodjRoutes(app, { wrap, autodj, logEvent, proc });

// ---------- Flux relayés ----------
// https://<domaine du dashboard>/live → Icecast, pour servir les flux en HTTPS via le reverse proxy du dashboard.

function streamMounts() {
  const names = new Map(ice().mounts.map((m) => [m.name, m.streamName]));
  for (const m of collector.live.mounts) if (!names.has(m.mount)) names.set(m.mount, m.name);
  return names;
}

app.use((req, res, next) => {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) return next();
  let p;
  try { p = decodeURIComponent(req.path); } catch { return next(); }
  const i = ice();
  const icePort = (proc.state === 'running' && proc.applied?.port) || i.port;
  if (p === '/status-json.xsl' && i.managed) return relayStatus(req, res, { port: icePort });
  const mounts = streamMounts();
  const base = i.publicUrl || `${req.protocol}://${req.get('host')}`;
  const m3u = p.match(/^(.+)\.m3u8?$/);
  if (m3u && mounts.has(m3u[1])) return playlist(res, `${base}${m3u[1]}`, mounts.get(m3u[1]));
  if (!mounts.has(p)) return next();
  if (!i.managed) return res.redirect(302, `${i.apiUrl.replace(/\/+$/, '')}${p}`);
  relayStream(req, res, { port: icePort, mount: p });
});

app.use('/vendor/chart.js', express.static(path.join(ROOT, 'node_modules/chart.js/dist')));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));
// Fond de carte embarqué (Natural Earth via world-atlas) : aucune dépendance à un service de tuiles
app.use('/vendor/world-atlas', express.static(path.join(ROOT, 'node_modules/world-atlas'), { maxAge: '7d' }));
app.use('/vendor/topojson', express.static(path.join(ROOT, 'node_modules/topojson-client/dist')));
app.use('/vendor/flag-icons', express.static(path.join(ROOT, 'node_modules/flag-icons'), { maxAge: '7d' }));
// Pages et scripts du dashboard : toujours revérifiés, pour qu'une mise à jour soit prise en compte sans vider le cache
app.use(express.static(path.join(ROOT, 'public'), {
  index: 'index.html',
  setHeaders: (res, file) => {
    if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));
app.get(/^\/(?!api\/).*/, (req, res) => res.set('Cache-Control', 'no-cache, must-revalidate').sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------- Démarrage ----------

const { host, port } = settings.dashboard;
const server = app.listen(port, host, async () => {
  console.log(`\n  Flux — dashboard Icecast : http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
  logEvent('info', 'dashboard', 'Dashboard démarré');
  await proc.init().catch((err) => console.error(err.message));
  collector.start();
  autodj.startEnabled().catch((err) => console.error('AutoDJ :', err.message));
});
server.on('error', (err) => {
  console.error(`Impossible d'écouter sur ${host}:${port} : ${err.message}`);
  process.exit(1);
});

function shutdown() {
  collector.stop();
  server.close();
  // Icecast continue de tourner : il sera repris au prochain démarrage du dashboard
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
