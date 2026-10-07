import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.FLUX_DATA || path.join(ROOT, 'data'));
const FILE = path.join(DATA_DIR, 'settings.json');

const ICECAST_CANDIDATES = [
  'C:\\Program Files\\Icecast\\bin\\icecast.exe',
  'C:\\Program Files (x86)\\Icecast\\bin\\icecast.exe',
  'C:\\Program Files\\Icecast2 Win32\\icecast2.exe',
  '/usr/bin/icecast2',
  '/usr/bin/icecast',
  '/usr/local/bin/icecast',
];

export function randomPassword(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function detectBinary() {
  return ICECAST_CANDIDATES.find((p) => fs.existsSync(p)) || ICECAST_CANDIDATES[0];
}

// Dossiers web/admin d'Icecast selon l'installation (Windows : à côté de l'exécutable,
// Debian/Ubuntu : /usr/share/icecast2)
export function detectIcecastPaths(binary) {
  const dir = path.dirname(binary);
  const home = path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
  const roots = [home, '/usr/share/icecast2', '/usr/share/icecast', '/usr/local/share/icecast', '/opt/icecast/share/icecast'];
  const root = roots.find((r) => fs.existsSync(path.join(r, 'web')) && fs.existsSync(path.join(r, 'admin'))) || home;
  return { webroot: path.join(root, 'web'), adminroot: path.join(root, 'admin') };
}

function defaults() {
  const binary = detectBinary();
  return {
    timezone: process.env.FLUX_TZ || 'Europe/Paris',
    branding: {
      name: 'RadioSMP',
      slogan: 'All The Hits, All The Music!',
      website: 'https://radiosmp.fr',
    },
    dashboard: {
      host: process.env.FLUX_HOST || '127.0.0.1',
      port: Number(process.env.FLUX_PORT) || 3000,
      passwordHash: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    },
    icecast: {
      managed: true,
      binary,
      ...detectIcecastPaths(binary),
      autoStart: true,
      autoRestart: true,
      // Adresse utilisée par le dashboard pour interroger Icecast (mode externe)
      apiUrl: 'http://127.0.0.1:8000',
      hostname: process.env.FLUX_PUBLIC_HOST || 'localhost',
      port: 8000,
      location: 'France',
      adminEmail: 'admin@localhost',
      adminUser: 'admin',
      adminPassword: randomPassword(),
      sourcePassword: randomPassword(),
      relayPassword: randomPassword(),
      limits: {
        clients: 500,
        sources: 10,
        queueSize: 524288,
        burstSize: 65535,
        clientTimeout: 30,
        headerTimeout: 15,
        sourceTimeout: 10,
      },
      mounts: [
        {
          id: crypto.randomUUID(),
          name: '/live',
          streamName: 'RadioSMP',
          description: 'All The Hits, All The Music!',
          genre: 'Hits',
          url: 'https://radiosmp.fr',
          maxListeners: 0,
          username: 'source',
          password: randomPassword(),
          fallbackMount: '',
          fallbackOverride: true,
          fallbackWhenFull: false,
          hidden: false,
          public: false,
          relayUrl: '',
          onDemand: false,
        },
      ],
    },
    collector: {
      intervalSec: 5,
      retentionDays: 365,
    },
  };
}

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null
      ? merge(base[k], v)
      : v;
  }
  return out;
}

let current = null;

export function loadSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let stored = {};
  if (fs.existsSync(FILE)) stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  current = merge(defaults(), stored);
  // Dossiers web/admin : déduits de l'exécutable choisi s'ils n'ont pas été réglés
  if (!stored.icecast?.webroot) Object.assign(current.icecast, detectIcecastPaths(current.icecast.binary));
  // Variables d'environnement prioritaires (service systemd, conteneur)
  if (process.env.FLUX_HOST) current.dashboard.host = process.env.FLUX_HOST;
  if (process.env.FLUX_PORT) current.dashboard.port = Number(process.env.FLUX_PORT);
  if (!fs.existsSync(FILE)) saveSettings();
  return current;
}

export function getSettings() {
  return current || loadSettings();
}

export function saveSettings() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, FILE);
}

export function updateSettings(mutator) {
  mutator(current);
  saveSettings();
  return current;
}
