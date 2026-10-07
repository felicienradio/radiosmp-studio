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

function defaults() {
  return {
    dashboard: {
      host: '127.0.0.1',
      port: 3000,
      passwordHash: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    },
    icecast: {
      managed: true,
      binary: detectBinary(),
      autoStart: true,
      autoRestart: true,
      // Adresse utilisée par le dashboard pour interroger Icecast (mode externe)
      apiUrl: 'http://127.0.0.1:8000',
      hostname: 'localhost',
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
          streamName: 'Ma Radio',
          description: 'Flux principal',
          genre: 'Variété',
          url: '',
          maxListeners: 0,
          username: '',
          password: '',
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
