import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { ROOT, loadSettings, getSettings, updateSettings, randomPassword } from './settings.js';
import { logEvent } from './db.js';
import { IcecastApi, IcecastError } from './icecast/api.js';
import { IcecastProcess, LOG_DIR, readTail } from './icecast/process.js';
import { Collector } from './collector.js';
import * as stats from './stats.js';
import { initGeo, geoStatus, downloadGeo } from './geo.js';
import { authRoutes, requireAuth, changePassword } from './auth.js';

const settings = loadSettings();
const ice = () => getSettings().icecast;
const proc = new IcecastProcess(ice, (level, type, msg) => logEvent(level, type, msg));
// Tant qu'Icecast n'a pas été redémarré, on l'interroge avec les réglages qu'il utilise réellement
const api = new IcecastApi(() => (ice().managed && proc.state === 'running' && proc.applied) || ice());
const collector = new Collector({ api, proc, getSettings });

await initGeo();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
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

authRoutes(app);
app.use('/api', requireAuth);

// ---------- Temps réel ----------

const clients = new Set();
function links() {
  const i = ice();
  const publicBase = i.managed ? `http://${i.hostname}:${i.port}` : i.apiUrl.replace(/\/+$/, '');
  return { publicBase, managed: i.managed, port: i.port };
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
proc.on('state', (status) => broadcast('process', status));
setInterval(() => broadcast('ping', Date.now()), 25_000);

// ---------- Statistiques ----------

app.get('/api/stats/overview', wrap((req) => stats.overview(req.query)));
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
  relayUrl: 'string', onDemand: 'boolean',
};

function cleanMount(input, existingId) {
  const m = { id: existingId || crypto.randomUUID() };
  for (const [k, type] of Object.entries(MOUNT_FIELDS)) {
    const v = input[k];
    if (type === 'string') m[k] = String(v ?? '').trim();
    else if (type === 'number') m[k] = Math.max(0, Math.floor(Number(v) || 0));
    else m[k] = !!v;
  }
  if (!m.name.startsWith('/')) m.name = '/' + m.name;
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(m.name) || m.name.includes('..') || m.name.startsWith('/admin')) {
    throw fail('Nom de point de montage invalide (lettres, chiffres, . _ - / uniquement, ex. /live ou /radio.mp3)');
  }
  if (m.fallbackMount && !m.fallbackMount.startsWith('/')) m.fallbackMount = '/' + m.fallbackMount;
  if (m.fallbackMount === m.name) throw fail('Le flux de secours doit être un autre point de montage');
  if (m.relayUrl && !/^https?:\/\/.+/i.test(m.relayUrl)) throw fail('L\'URL du relais doit commencer par http:// ou https://');
  if (/[<>&"]/.test(m.password)) throw fail('Le mot de passe ne doit pas contenir < > & "');
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

app.get('/api/mounts', wrap(() => ({ mounts: mountsView(), process: proc.status(), connection: connectionInfo() })));

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

app.delete('/api/mounts/:id', wrap((req) => {
  const m = ice().mounts.find((x) => x.id === req.params.id);
  if (!m) throw fail('Point de montage introuvable', 404);
  updateSettings((s) => { s.icecast.mounts = s.icecast.mounts.filter((x) => x.id !== m.id); });
  logEvent('info', 'config', `Point de montage ${m.name} supprimé`, m.name);
  return { process: proc.status() };
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
  return { host: i.hostname, port: i.port, sourceUser: 'source', sourcePassword: i.sourcePassword, managed: i.managed, apiUrl: i.apiUrl };
}

// ---------- Serveur Icecast ----------

function serverView() {
  const i = ice();
  return {
    process: proc.status(),
    live: { online: collector.live.online, error: collector.live.error, server: collector.live.server },
    settings: {
      managed: i.managed, binary: i.binary, autoStart: i.autoStart, autoRestart: i.autoRestart, apiUrl: i.apiUrl,
      hostname: i.hostname, port: i.port, location: i.location, adminEmail: i.adminEmail,
      adminUser: i.adminUser, adminPassword: i.adminPassword, sourcePassword: i.sourcePassword, relayPassword: i.relayPassword,
      limits: i.limits,
    },
    collector: getSettings().collector,
    dashboard: { host: getSettings().dashboard.host, port: getSettings().dashboard.port },
    geo: geoStatus(),
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
    if ('binary' in b) i.binary = str(b.binary, 500);
    if ('autoStart' in b) i.autoStart = !!b.autoStart;
    if ('autoRestart' in b) i.autoRestart = !!b.autoRestart;
    if ('apiUrl' in b) i.apiUrl = str(b.apiUrl, 300);
    if ('hostname' in b) i.hostname = str(b.hostname) || 'localhost';
    if ('port' in b) i.port = int(b.port, 1, 65535);
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

app.post('/api/geo/download', wrap(async () => {
  const r = await downloadGeo();
  logEvent('info', 'config', `Base GeoIP installée (${r.month})`);
  return geoStatus();
}));

app.post('/api/dashboard/password', changePassword);

// ---------- Interface ----------

app.use('/vendor/chart.js', express.static(path.join(ROOT, 'node_modules/chart.js/dist')));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------- Démarrage ----------

const { host, port } = settings.dashboard;
const server = app.listen(port, host, async () => {
  console.log(`\n  Flux — dashboard Icecast : http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
  logEvent('info', 'dashboard', 'Dashboard démarré');
  await proc.init().catch((err) => console.error(err.message));
  collector.start();
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
