// Playlists de l'AutoDJ (musique ou jingles). Les stations les utilisent (voir stations.js).
import { db, tx } from '../db.js';
import { fail } from './library.js';

export function listPlaylists() {
  return db.prepare(`
    SELECT p.*, COUNT(i.media_id) AS count, COALESCE(SUM(m.duration), 0) AS duration,
      (SELECT GROUP_CONCAT(s.name, ', ') FROM station_playlists l JOIN stations s ON s.id = l.station_id WHERE l.playlist_id = p.id) AS stations
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
    db.prepare('DELETE FROM station_playlists WHERE playlist_id = ?').run(Number(id));
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
