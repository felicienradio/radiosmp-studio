// Stations AutoDJ : chaque station diffuse sur ses propres flux de sortie, avec ses playlists
// (rotation pondérée, insertions tous les N titres ou toutes les N minutes) et sa grille horaire.
import { db, tx } from '../db.js';
import { parts } from '../time.js';
import { fail } from './library.js';

export const FORMATS = ['mp3', 'aac'];
export const BITRATES = [64, 96, 128, 160, 192, 256, 320];
export const MODES = ['rotation', 'tracks', 'minutes'];
const MOUNT = /^\/[A-Za-z0-9._\-/]+$/;

function row(s) {
  if (!s) return null;
  let outputs = [];
  try { outputs = JSON.parse(s.outputs) || []; } catch {}
  return {
    id: s.id,
    name: s.name,
    enabled: !!s.enabled,
    outputs,
    liveMount: s.live_mount || '',
    crossfade: !!s.crossfade,
    createdAt: s.created_at,
  };
}

/** Playlists d'une station, avec leur réglage de diffusion. */
export function stationLinks(id) {
  return db.prepare(`
    SELECT l.playlist_id, l.mode, l.weight, l.every, p.name, p.kind, p.shuffle,
      (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS count
    FROM station_playlists l JOIN playlists p ON p.id = l.playlist_id
    WHERE l.station_id = ? ORDER BY l.position, p.name COLLATE NOCASE`).all(Number(id));
}

export function getStation(id) {
  const s = row(db.prepare('SELECT * FROM stations WHERE id = ?').get(Number(id)));
  if (s) s.links = stationLinks(s.id);
  return s;
}

export function listStations() {
  return db.prepare('SELECT * FROM stations ORDER BY id').all().map(row).map((s) => ({ ...s, links: stationLinks(s.id) }));
}

const normMount = (m) => {
  let x = String(m || '').trim();
  if (x && !x.startsWith('/')) x = `/${x}`;
  return x;
};

function clean(b, id = null) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw fail('Donnez un nom à la station');
  const outputs = (Array.isArray(b.outputs) ? b.outputs : []).map((o) => ({
    mount: normMount(o.mount),
    format: FORMATS.includes(o.format) ? o.format : 'mp3',
    bitrate: BITRATES.includes(Number(o.bitrate)) ? Number(o.bitrate) : 128,
  }));
  if (!outputs.length) throw fail('Ajoutez au moins un flux de sortie');
  if (outputs.length > 6) throw fail('6 flux de sortie au maximum par station');
  for (const o of outputs) {
    if (!MOUNT.test(o.mount) || o.mount.includes('..') || o.mount.startsWith('/admin')) throw fail(`Point de montage invalide : ${o.mount || '(vide)'}`);
  }
  if (new Set(outputs.map((o) => o.mount)).size !== outputs.length) throw fail('Chaque flux de sortie doit avoir son propre point de montage');
  const liveMount = normMount(b.liveMount);
  if (liveMount && !MOUNT.test(liveMount)) throw fail('Flux direct invalide');
  if (liveMount && outputs.some((o) => o.mount === liveMount)) throw fail('Le flux direct doit être différent des flux de sortie de l\'AutoDJ');
  // Un point de montage ne peut être alimenté que par une station
  for (const other of listStations()) {
    if (other.id === id) continue;
    const taken = outputs.find((o) => other.outputs.some((x) => x.mount === o.mount));
    if (taken) throw fail(`${taken.mount} est déjà utilisé par la station « ${other.name} »`);
  }
  return { name, outputs, liveMount, crossfade: b.crossfade === false || b.crossfade === 0 ? 0 : 1 };
}

export function createStation(b) {
  const s = clean(b);
  const { lastInsertRowid } = db.prepare('INSERT INTO stations (name, enabled, outputs, live_mount, crossfade, created_at) VALUES (?, 0, ?, ?, ?, ?)')
    .run(s.name, JSON.stringify(s.outputs), s.liveMount || null, s.crossfade, Date.now());
  return getStation(lastInsertRowid);
}

export function updateStation(id, b) {
  const cur = getStation(id);
  if (!cur) throw fail('Station introuvable', 404);
  const s = clean({ ...cur, ...b }, cur.id);
  db.prepare('UPDATE stations SET name = ?, outputs = ?, live_mount = ?, crossfade = ? WHERE id = ?')
    .run(s.name, JSON.stringify(s.outputs), s.liveMount || null, s.crossfade, cur.id);
  return getStation(id);
}

export function setEnabled(id, enabled) {
  db.prepare('UPDATE stations SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
}

export function deleteStation(id) {
  tx(() => {
    db.prepare('DELETE FROM station_playlists WHERE station_id = ?').run(Number(id));
    db.prepare('DELETE FROM schedule WHERE station_id = ?').run(Number(id));
    db.prepare('DELETE FROM stations WHERE id = ?').run(Number(id));
  });
}

/** Remplace les playlists de la station : [{ playlistId, mode, weight, every }]. */
export function setLinks(id, links) {
  if (!getStation(id)) throw fail('Station introuvable', 404);
  const exists = db.prepare('SELECT 1 FROM playlists WHERE id = ?');
  const insert = db.prepare('INSERT INTO station_playlists (station_id, playlist_id, mode, weight, every, position) VALUES (?, ?, ?, ?, ?, ?)');
  const seen = new Set();
  const list = (Array.isArray(links) ? links : []).map((l) => ({
    playlistId: Number(l.playlistId ?? l.playlist_id),
    mode: MODES.includes(l.mode) ? l.mode : 'rotation',
    weight: Math.max(1, Math.min(10, Math.round(Number(l.weight) || 3))),
    every: Math.max(1, Math.min(l.mode === 'minutes' ? 1440 : 100, Math.round(Number(l.every) || 4))),
  })).filter((l) => Number.isInteger(l.playlistId) && exists.get(l.playlistId) && !seen.has(l.playlistId) && seen.add(l.playlistId));
  tx(() => {
    db.prepare('DELETE FROM station_playlists WHERE station_id = ?').run(Number(id));
    list.forEach((l, i) => insert.run(Number(id), l.playlistId, l.mode, l.weight, l.every, i));
  });
  return getStation(id);
}

/** Stations qui diffusent sur ce point de montage. */
export function stationsUsingMount(mount) {
  return listStations().filter((s) => s.outputs.some((o) => o.mount === mount));
}

// ---------- Grille horaire (par station) ----------
// days : jours ISO séparés par des virgules (1 = lundi … 7 = dimanche) ; start/end : « HH:MM » (heure de la radio)

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function listSchedule(stationId) {
  return db.prepare(`SELECT s.*, p.name AS playlist_name FROM schedule s LEFT JOIN playlists p ON p.id = s.playlist_id
    WHERE s.station_id = ? ORDER BY s.start, s.id`).all(Number(stationId));
}

function cleanRule(b) {
  const days = [...new Set(String(b.days ?? '').split(',').map(Number).filter((d) => d >= 1 && d <= 7))].sort().join(',');
  if (!days) throw fail('Choisissez au moins un jour');
  if (!TIME.test(b.start) || !TIME.test(b.end)) throw fail('Heures au format HH:MM');
  if (b.start === b.end) throw fail('L\'heure de fin doit être différente de l\'heure de début');
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ?').get(Number(b.playlist_id));
  if (!pl) throw fail('Choisissez une playlist');
  return { playlist_id: pl.id, days, start: b.start, end: b.end, enabled: b.enabled === false ? 0 : 1 };
}

export function createRule(stationId, b) {
  if (!getStation(stationId)) throw fail('Station introuvable', 404);
  const r = cleanRule(b);
  db.prepare('INSERT INTO schedule (station_id, playlist_id, days, start, end, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(stationId), r.playlist_id, r.days, r.start, r.end, r.enabled);
  return listSchedule(stationId);
}

export function deleteRule(id) {
  const r = db.prepare('SELECT station_id FROM schedule WHERE id = ?').get(Number(id));
  if (!r) throw fail('Créneau introuvable', 404);
  db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(id));
  return listSchedule(r.station_id);
}

/** Créneau actif de la station à l'instant donné (le premier qui correspond), ou null. */
export function activeRule(stationId, ts = Date.now()) {
  const p = parts(ts);
  const isoDay = p.dow === 0 ? 7 : p.dow;
  const prevDay = isoDay === 1 ? 7 : isoDay - 1;
  const minute = (p.minuteBase + Math.floor((ts % 3600_000) / 60_000)) % 60;
  const now = `${String(p.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  for (const r of listSchedule(stationId)) {
    if (!r.enabled) continue;
    const days = r.days.split(',').map(Number);
    if (r.start < r.end) {
      if (days.includes(isoDay) && now >= r.start && now < r.end) return r;
    } else if ((days.includes(isoDay) && now >= r.start) || (days.includes(prevDay) && now < r.end)) {
      // créneau qui passe minuit (ex. 22:00 → 02:00)
      return r;
    }
  }
  return null;
}

/**
 * Première utilisation : l'AutoDJ unique des versions précédentes devient la première station
 * (mêmes flux, playlists, jingles et grille). Sur une nouvelle installation, une station vide est créée.
 */
export function migrateStations(old, defaultName) {
  if (db.prepare('SELECT COUNT(*) AS n FROM stations').get().n) return false;
  const a = old || {};
  const { lastInsertRowid: id } = db.prepare('INSERT INTO stations (name, enabled, outputs, live_mount, crossfade, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(defaultName, a.enabled ? 1 : 0, JSON.stringify([{ mount: a.mount || '/autodj', format: a.format === 'aac' ? 'aac' : 'mp3', bitrate: Number(a.bitrate) || 320 }]),
      a.liveMount || '/live', a.crossfade === false ? 0 : 1, Date.now());
  const links = [];
  if (a.defaultPlaylist) links.push({ playlistId: a.defaultPlaylist, mode: 'rotation', weight: 5 });
  if (a.jinglePlaylist && a.jingleEvery > 0) links.push({ playlistId: a.jinglePlaylist, mode: 'tracks', every: a.jingleEvery });
  setLinks(id, links);
  db.prepare('UPDATE schedule SET station_id = ? WHERE station_id IS NULL').run(id);
  return true;
}
