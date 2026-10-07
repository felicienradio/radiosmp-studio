// Bibliothèque musicale de l'AutoDJ : fichiers dans data/music, informations dans la table media.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { DATA_DIR } from '../settings.js';
import { envelope, detectCues, waveform } from './cue.js';

export const MUSIC_DIR = path.join(DATA_DIR, 'music');
const EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav'];
const MAX_SIZE = 500 * 1024 * 1024;

const q = {
  insert: db.prepare(`INSERT INTO media (file, original_name, title, artist, album, duration, bitrate, size, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare('SELECT * FROM media WHERE id = ?'),
  remove: db.prepare('DELETE FROM media WHERE id = ?'),
  removeItems: db.prepare('DELETE FROM playlist_items WHERE media_id = ?'),
  played: db.prepare('UPDATE media SET plays = plays + 1, last_played = ? WHERE id = ?'),
};

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function mediaPath(m) {
  return path.join(MUSIC_DIR, m.file);
}

export function getMedia(id) {
  return q.get.get(Number(id)) || null;
}

export function markPlayed(id) {
  q.played.run(Date.now(), id);
}

export function displayTitle(m) {
  if (!m) return '';
  return m.artist && m.title ? `${m.artist} - ${m.title}` : m.title || m.original_name || m.file;
}

/** Informations du fichier (tags, durée, débit) avec ffprobe. */
export function probe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file],
      { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(out);
          if (!j.streams?.length) return reject(new Error('aucune piste audio'));
          const tags = Object.fromEntries(Object.entries({ ...j.format?.tags, ...j.streams[0]?.tags }).map(([k, v]) => [k.toLowerCase(), v]));
          resolve({
            title: tags.title || null,
            artist: tags.artist || tags.album_artist || null,
            album: tags.album || null,
            duration: Number(j.format?.duration) || null,
            bitrate: Math.round((Number(j.format?.bit_rate) || 0) / 1000) || null,
          });
        } catch (e) {
          reject(e);
        }
      });
  });
}

/** Titre et artiste devinés depuis le nom du fichier (« Artiste - Titre.mp3 ») quand il n'y a pas de tags. */
function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: null, title: base };
}

/** Enregistre un fichier envoyé (corps brut de la requête), puis lit ses informations. */
export async function importUpload(req) {
  const original = decodeURIComponent(String(req.get('x-filename') || 'fichier.mp3')).replace(/[\\/]/g, '_').slice(0, 200);
  const ext = path.extname(original).slice(1).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw fail(`Format non pris en charge (.${ext}). Formats acceptés : ${EXTENSIONS.join(', ')}`);
  if (Number(req.get('content-length')) > MAX_SIZE) throw fail('Fichier trop lourd (500 Mo maximum)');

  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const full = path.join(MUSIC_DIR, file);
  await pipeline(req, fs.createWriteStream(full));

  let info;
  try {
    info = await probe(full);
  } catch {
    fs.rmSync(full, { force: true });
    throw fail(`« ${original} » n'est pas un fichier audio lisible`);
  }
  const guess = fromFilename(original);
  const { lastInsertRowid } = q.insert.run(file, original, info.title || guess.title, info.artist || guess.artist, info.album,
    info.duration, info.bitrate, fs.statSync(full).size, Date.now());
  return getMedia(lastInsertRowid);
}

export function listMedia(search = '') {
  const s = `%${search.trim()}%`;
  return db.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.media_id = m.id) AS in_playlists
    FROM media m
    WHERE (:s = '%%' OR m.title LIKE :s OR m.artist LIKE :s OR m.album LIKE :s OR m.original_name LIKE :s)
    ORDER BY m.artist COLLATE NOCASE, m.title COLLATE NOCASE`).all({ s });
}

export function updateMedia(id, { title, artist, album }) {
  const m = getMedia(id);
  if (!m) throw fail('Titre introuvable', 404);
  const str = (v, old) => (v === undefined ? old : String(v).trim().slice(0, 300) || null);
  db.prepare('UPDATE media SET title = ?, artist = ?, album = ? WHERE id = ?')
    .run(str(title, m.title), str(artist, m.artist), str(album, m.album), m.id);
  return getMedia(id);
}

export function deleteMedia(id) {
  const m = getMedia(id);
  if (!m) throw fail('Titre introuvable', 404);
  q.removeItems.run(m.id);
  q.remove.run(m.id);
  fs.rmSync(mediaPath(m), { force: true });
}

// ---------- Points cue ----------

/** Points cue effectifs d'un titre (avec les valeurs par défaut : tout le fichier, sans chevauchement). */
export function cuesOf(m) {
  const duration = m.duration || 0;
  const cueIn = Math.max(0, m.cue_in || 0);
  const cueOut = m.cue_out && m.cue_out > cueIn ? Math.min(m.cue_out, duration || m.cue_out) : duration;
  const mix = m.cue_mix != null && m.cue_mix >= cueIn && m.cue_mix <= cueOut ? m.cue_mix : cueOut;
  return { cueIn, mix, cueOut, fadeIn: m.fade_in || 0, fadeOut: m.fade_out || 0, auto: !!m.cue_auto, analyzed: !!m.analyzed_at };
}

/** Analyse le fichier et place les points cue automatiquement (sauf s'ils ont été réglés à la main et que force est faux). */
export async function autoCue(id, { force = false } = {}) {
  const m = getMedia(id);
  if (!m) throw fail('Titre introuvable', 404);
  const env = await envelope(mediaPath(m));
  const c = detectCues(env);
  const now = Date.now();
  if (m.cue_auto || force) {
    db.prepare('UPDATE media SET cue_in = ?, cue_mix = ?, cue_out = ?, fade_in = 0, fade_out = 0, cue_auto = 1, cue_level = ?, analyzed_at = ?, duration = COALESCE(duration, ?) WHERE id = ?')
      .run(c.cueIn, c.mix, c.cueOut, c.level ?? null, now, env.duration || null, m.id);
  } else {
    db.prepare('UPDATE media SET cue_level = ?, analyzed_at = ? WHERE id = ?').run(c.level ?? null, now, m.id);
  }
  return getMedia(id);
}

/** Enregistre des points cue réglés à la main. */
export function setCues(id, b) {
  const m = getMedia(id);
  if (!m) throw fail('Titre introuvable', 404);
  const dur = m.duration || Infinity;
  const num = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100) / 100);
  const cueIn = Math.max(0, num(b.cueIn) ?? 0);
  const cueOut = num(b.cueOut);
  const mix = num(b.mix);
  const fadeIn = Math.max(0, num(b.fadeIn) ?? 0);
  const fadeOut = Math.max(0, num(b.fadeOut) ?? 0);
  if ([cueIn, cueOut, mix, fadeIn, fadeOut].some((v) => v !== null && !Number.isFinite(v))) throw fail('Valeur invalide');
  const end = cueOut ?? (Number.isFinite(dur) ? dur : null);
  if (end !== null && (end <= cueIn || end > dur + 0.5)) throw fail('Le cue out doit être après le cue in et avant la fin du fichier');
  if (mix !== null && (mix < cueIn || (end !== null && mix > end))) throw fail('Le point d\'enchaînement doit être entre le cue in et le cue out');
  if (fadeIn > 30 || fadeOut > 30) throw fail('Fondu de 30 secondes maximum');
  db.prepare('UPDATE media SET cue_in = ?, cue_mix = ?, cue_out = ?, fade_in = ?, fade_out = ?, cue_auto = 0 WHERE id = ?')
    .run(cueIn, mix, cueOut, fadeIn, fadeOut, m.id);
  return getMedia(id);
}

/** Forme d'onde pour l'éditeur de points cue. */
export async function mediaWaveform(id) {
  const m = getMedia(id);
  if (!m) throw fail('Titre introuvable', 404);
  const env = await envelope(mediaPath(m));
  return { duration: env.duration || m.duration, ...waveform(env), suggested: detectCues(env) };
}

// File d'analyse : un fichier à la fois, en tâche de fond (après un envoi ou « Analyser toute la bibliothèque »)
const pending = [];
let analysing = false;
export function queueAutoCue(ids, opts = {}) {
  for (const id of ids) if (!pending.some((p) => p.id === id)) pending.push({ id, ...opts });
  if (!analysing) drain();
}
async function drain() {
  analysing = true;
  while (pending.length) {
    const { id, force } = pending.shift();
    try { await autoCue(id, { force }); } catch {}
  }
  analysing = false;
}
export const analysisPending = () => pending.length + (analysing ? 1 : 0);

export function libraryStats() {
  return db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(duration), 0) AS duration, COALESCE(SUM(size), 0) AS size FROM media').get();
}
