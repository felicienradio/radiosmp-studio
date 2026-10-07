// Playlists (musique ou jingles) et grille horaire de l'AutoDJ.
import { db, tx } from '../db.js';
import { parts } from '../time.js';
import { fail } from './library.js';

export function listPlaylists() {
  return db.prepare(`
    SELECT p.*, COUNT(i.media_id) AS count, COALESCE(SUM(m.duration), 0) AS duration
    FROM playlists p
    LEFT JOIN playlist_items i ON i.playlist_id = p.id
    LEFT JOIN media m ON m.id = i.media_id
    GROUP BY p.id ORDER BY p.kind, p.name COLLATE NOCASE`).all();
}

export function getPlaylist(id) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
  if (!p) return null;
  p.items = db.prepare(`
    SELECT m.* FROM playlist_items i JOIN media m ON m.id = i.media_id
    WHERE i.playlist_id = ? ORDER BY i.position`).all(p.id);
  return p;
}

/** Identifiants des titres d'une playlist, dans l'ordre. */
export function playlistMediaIds(id) {
  return db.prepare('SELECT media_id FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(Number(id)).map((r) => r.media_id);
}

function clean(b) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw fail('Donnez un nom à la playlist');
  return { name, kind: b.kind === 'jingle' ? 'jingle' : 'music', shuffle: b.shuffle === false || b.shuffle === 0 ? 0 : 1 };
}

export function createPlaylist(b) {
  const p = clean(b);
  const { lastInsertRowid } = db.prepare('INSERT INTO playlists (name, kind, shuffle, created_at) VALUES (?, ?, ?, ?)')
    .run(p.name, p.kind, p.shuffle, Date.now());
  return getPlaylist(lastInsertRowid);
}

export function updatePlaylist(id, b) {
  const cur = getPlaylist(id);
  if (!cur) throw fail('Playlist introuvable', 404);
  const p = clean({ ...cur, ...b });
  db.prepare('UPDATE playlists SET name = ?, kind = ?, shuffle = ? WHERE id = ?').run(p.name, p.kind, p.shuffle, cur.id);
  return getPlaylist(id);
}

export function deletePlaylist(id) {
  tx(() => {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(Number(id));
    db.prepare('DELETE FROM schedule WHERE playlist_id = ?').run(Number(id));
    db.prepare('DELETE FROM playlists WHERE id = ?').run(Number(id));
  });
}

/** Remplace le contenu (et l'ordre) de la playlist. */
export function setItems(id, mediaIds) {
  if (!getPlaylist(id)) throw fail('Playlist introuvable', 404);
  const ids = [...new Set((mediaIds || []).map(Number).filter(Number.isInteger))];
  const exists = db.prepare('SELECT 1 FROM media WHERE id = ?');
  const insert = db.prepare('INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)');
  tx(() => {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(Number(id));
    ids.filter((m) => exists.get(m)).forEach((m, i) => insert.run(Number(id), m, i));
  });
  return getPlaylist(id);
}

export function addItems(id, mediaIds) {
  return setItems(id, [...playlistMediaIds(id), ...(mediaIds || [])]);
}

// ---------- Grille horaire ----------
// days : jours ISO séparés par des virgules (1 = lundi … 7 = dimanche) ; start/end : « HH:MM » (heure de la radio)

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function listSchedule() {
  return db.prepare(`SELECT s.*, p.name AS playlist_name FROM schedule s LEFT JOIN playlists p ON p.id = s.playlist_id
    ORDER BY s.start, s.id`).all();
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

export function createRule(b) {
  const r = cleanRule(b);
  db.prepare('INSERT INTO schedule (playlist_id, days, start, end, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(r.playlist_id, r.days, r.start, r.end, r.enabled);
  return listSchedule();
}

export function updateRule(id, b) {
  const r = cleanRule(b);
  db.prepare('UPDATE schedule SET playlist_id = ?, days = ?, start = ?, end = ?, enabled = ? WHERE id = ?')
    .run(r.playlist_id, r.days, r.start, r.end, r.enabled, Number(id));
  return listSchedule();
}

export function deleteRule(id) {
  db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(id));
  return listSchedule();
}

/** Règle active à l'instant donné (la première qui correspond), ou null. */
export function activeRule(ts = Date.now()) {
  const p = parts(ts);
  const isoDay = p.dow === 0 ? 7 : p.dow;
  const prevDay = isoDay === 1 ? 7 : isoDay - 1;
  const minute = (p.minuteBase + Math.floor((ts % 3600_000) / 60_000)) % 60;
  const now = `${String(p.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  for (const r of listSchedule()) {
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
