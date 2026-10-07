import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './settings.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'flux.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  -- Une ligne par minute et par point de montage
  CREATE TABLE IF NOT EXISTS samples (
    mount TEXT NOT NULL,
    ts INTEGER NOT NULL,
    listeners_avg REAL NOT NULL,
    listeners_max INTEGER NOT NULL,
    bytes_sent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mount, ts)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);

  -- Une ligne par connexion d'auditeur
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    mount TEXT NOT NULL,
    client_key TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    player TEXT,
    os TEXT,
    country TEXT,
    referer TEXT,
    started_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen);
  CREATE INDEX IF NOT EXISTS sessions_open ON sessions(ended_at) WHERE ended_at IS NULL;

  -- Historique des titres diffusés
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    mount TEXT NOT NULL,
    title TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ended_at INTEGER,
    listeners_start INTEGER NOT NULL DEFAULT 0,
    listeners_end INTEGER NOT NULL DEFAULT 0,
    listeners_peak INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS tracks_started ON tracks(started_at);

  -- Journal d'événements (connexion/déconnexion de sources, serveur...)
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    mount TEXT,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`);

// Migrations : colonnes ajoutées après la première version
const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
for (const [col, type] of [['device', 'TEXT'], ['city', 'TEXT'], ['lat', 'REAL'], ['lon', 'REAL']]) {
  if (!sessionCols.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Complète les anciennes sessions : type d'appareil manquant, et localisation
 * (après l'installation ou la mise à jour d'une base GeoIP).
 */
export function backfillSessions({ parseUserAgent, lookup, geo = false }) {
  const rows = db.prepare(`SELECT id, ip, user_agent FROM sessions WHERE device IS NULL${geo ? ' OR country IS NULL OR city IS NULL' : ''}`).all();
  if (!rows.length) return 0;
  const update = db.prepare('UPDATE sessions SET device = ?, country = COALESCE(?, country), city = COALESCE(?, city), lat = COALESCE(?, lat), lon = COALESCE(?, lon) WHERE id = ?');
  const cache = new Map();
  tx(() => {
    for (const r of rows) {
      const { device } = parseUserAgent(r.user_agent || '');
      let g = cache.get(r.ip);
      if (!g) cache.set(r.ip, (g = lookup(r.ip)));
      update.run(device, g.country, g.city, g.lat, g.lon, r.id);
    }
  });
  return rows.length;
}

const insertEvent =db.prepare('INSERT INTO events (ts, level, type, mount, message) VALUES (?, ?, ?, ?, ?)');

export function logEvent(level, type, message, mount = null) {
  insertEvent.run(Date.now(), level, type, mount, message);
  console.log(`[${level}] ${mount ? mount + ' ' : ''}${message}`);
}
