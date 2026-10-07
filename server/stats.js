import { db } from './db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Les connexions plus courtes sont des sondes de lecteurs / prévisualisations,
// exclues des comptages de sessions (mais comptées dans les heures d'écoute).
export const MIN_SESSION_MS = 5_000;

db.exec('CREATE INDEX IF NOT EXISTS sessions_ip ON sessions(ip)');

const RANGES = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY };

export function parseRange(query) {
  const now = Date.now();
  let from;
  let to = now;
  if (query.from && query.to) {
    from = Number(query.from);
    to = Math.min(Number(query.to), now);
  } else {
    from = now - (RANGES[query.range] || DAY);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Période invalide');
  const span = to - from;
  const bucket = span <= 2 * HOUR ? MIN
    : span <= 6 * HOUR ? 2 * MIN
    : span <= 26 * HOUR ? 5 * MIN
    : span <= 8 * DAY ? HOUR
    : span <= 31 * DAY ? 4 * HOUR
    : DAY;
  return { from, to, bucket, mount: query.mount || null };
}

function tzOffset(ts) {
  return -new Date(ts).getTimezoneOffset() * MIN;
}

const mountFilter = (mount, col = 'mount') => (mount ? ` AND ${col} = :mount` : '');

function params(r, extra = {}) {
  const p = { from: r.from, to: r.to, ...extra };
  if (r.mount) p.mount = r.mount;
  return p;
}

/** Courbe d'audience : moyenne et maximum d'auditeurs simultanés par intervalle. */
export function series(r) {
  const off = r.bucket >= DAY ? tzOffset(r.to) : 0;
  const rows = db.prepare(`
    SELECT CAST((ts + :off) / :b AS INTEGER) * :b - :off AS t, SUM(tot_avg) AS sum_avg, MAX(tot_max) AS max, SUM(bytes) AS bytes
    FROM (SELECT ts, SUM(listeners_avg) AS tot_avg, SUM(listeners_max) AS tot_max, SUM(bytes_sent) AS bytes
          FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)} GROUP BY ts)
    GROUP BY t ORDER BY t`).all(params(r, { b: r.bucket, off }));
  const byT = new Map(rows.map((x) => [x.t, x]));
  const out = [];
  const start = Math.floor((r.from + off) / r.bucket) * r.bucket - off;
  for (let t = start; t < r.to; t += r.bucket) {
    const x = byT.get(t);
    const minutes = Math.max(1, (Math.min(t + r.bucket, r.to) - Math.max(t, r.from)) / MIN);
    out.push({
      t,
      avg: x ? Math.round((x.sum_avg / minutes) * 100) / 100 : 0,
      max: x ? x.max : 0,
      bytes: x ? x.bytes : 0,
    });
  }
  return out;
}

const SESSION_END = 'COALESCE(ended_at, last_seen)';
const OVERLAP = `started_at < :to AND ${SESSION_END} >= :from`;
const CLIPPED = `(MIN(${SESSION_END}, :to) - MAX(started_at, :from))`;

function kpis(r) {
  const peak = db.prepare(`
    SELECT ts, SUM(listeners_max) AS v FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)}
    GROUP BY ts ORDER BY v DESC, ts DESC LIMIT 1`).get(params(r));
  const totals = db.prepare(`
    SELECT SUM(listeners_avg) AS listener_minutes, SUM(bytes_sent) AS bytes
    FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)}`).get(params(r));
  const s = db.prepare(`
    SELECT COUNT(*) AS sessions,
           COUNT(DISTINCT ip) AS unique_listeners,
           AVG(${SESSION_END} - started_at) AS avg_duration,
           SUM(${CLIPPED}) AS listen_ms
    FROM sessions WHERE ${OVERLAP}${mountFilter(r.mount)}
      AND (${SESSION_END} - started_at) >= :minDur`).get(params(r, { minDur: MIN_SESSION_MS }));
  const all = db.prepare(`SELECT SUM(${CLIPPED}) AS listen_ms, COUNT(*) AS n FROM sessions WHERE ${OVERLAP}${mountFilter(r.mount)}`)
    .get(params(r));
  const returning = db.prepare(`
    SELECT COUNT(DISTINCT s.ip) AS n FROM sessions s
    WHERE s.started_at < :to AND COALESCE(s.ended_at, s.last_seen) >= :from${mountFilter(r.mount, 's.mount')}
      AND EXISTS (SELECT 1 FROM sessions p WHERE p.ip = s.ip AND p.started_at < :from)`).get(params(r));
  const minutes = (r.to - r.from) / MIN;
  return {
    peak: peak?.v || 0,
    peakAt: peak?.ts || null,
    avgListeners: Math.round(((totals.listener_minutes || 0) / minutes) * 100) / 100,
    sessions: s.sessions || 0,
    shortSessions: (all.n || 0) - (s.sessions || 0),
    uniqueListeners: s.unique_listeners || 0,
    returningListeners: returning.n || 0,
    avgDurationSec: Math.round((s.avg_duration || 0) / 1000),
    listeningHours: Math.round(((all.listen_ms || 0) / HOUR) * 10) / 10,
    bytesSent: totals.bytes || 0,
  };
}

function breakdown(r, column) {
  return db.prepare(`
    SELECT COALESCE(${column}, '?') AS label, COUNT(*) AS sessions, COUNT(DISTINCT ip) AS listeners,
           ROUND(SUM(${CLIPPED}) / 3600000.0, 2) AS hours
    FROM sessions WHERE ${OVERLAP}${mountFilter(r.mount)} AND (${SESSION_END} - started_at) >= :minDur
    GROUP BY label ORDER BY hours DESC, sessions DESC LIMIT 20`).all(params(r, { minDur: MIN_SESSION_MS }));
}

function durations(r) {
  const row = db.prepare(`
    SELECT
      SUM(d < 60000) AS b0, SUM(d >= 60000 AND d < 300000) AS b1, SUM(d >= 300000 AND d < 900000) AS b2,
      SUM(d >= 900000 AND d < 1800000) AS b3, SUM(d >= 1800000 AND d < 3600000) AS b4,
      SUM(d >= 3600000 AND d < 7200000) AS b5, SUM(d >= 7200000) AS b6
    FROM (SELECT ${SESSION_END} - started_at AS d FROM sessions
          WHERE ${OVERLAP}${mountFilter(r.mount)} AND (${SESSION_END} - started_at) >= :minDur)`)
    .get(params(r, { minDur: MIN_SESSION_MS }));
  const labels = ['< 1 min', '1–5 min', '5–15 min', '15–30 min', '30–60 min', '1–2 h', '> 2 h'];
  return labels.map((label, i) => ({ label, sessions: row[`b${i}`] || 0 }));
}

/** Audience moyenne par jour de la semaine et par heure (heure locale du serveur). */
function heatmap(r) {
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
           CAST(strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
           SUM(tot) AS s
    FROM (SELECT ts, SUM(listeners_avg) AS tot FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)} GROUP BY ts)
    GROUP BY dow, h`).all(params(r));
  // Nombre de minutes de chaque créneau couvertes par la période
  const minutes = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let t = Math.floor(r.from / HOUR) * HOUR; t < r.to; t += HOUR) {
    const d = new Date(t);
    const covered = (Math.min(t + HOUR, r.to) - Math.max(t, r.from)) / MIN;
    if (covered > 0) minutes[d.getDay()][d.getHours()] += covered;
  }
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const x of rows) {
    const m = minutes[x.dow][x.h];
    grid[x.dow][x.h] = m ? Math.round((x.s / m) * 100) / 100 : 0;
  }
  return grid;
}

function daily(r) {
  const off = tzOffset(r.to);
  const samples = db.prepare(`
    SELECT CAST((ts + :off) / 86400000 AS INTEGER) * 86400000 - :off AS day, MAX(tot_max) AS peak, SUM(tot_avg) AS lm, SUM(bytes) AS bytes
    FROM (SELECT ts, SUM(listeners_avg) AS tot_avg, SUM(listeners_max) AS tot_max, SUM(bytes_sent) AS bytes
          FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)} GROUP BY ts)
    GROUP BY day`).all(params(r, { off }));
  const sessions = db.prepare(`
    SELECT CAST((started_at + :off) / 86400000 AS INTEGER) * 86400000 - :off AS day, COUNT(*) AS sessions,
           COUNT(DISTINCT ip) AS listeners, AVG(${SESSION_END} - started_at) AS avg_d,
           SUM(${SESSION_END} - started_at) AS ms
    FROM sessions WHERE started_at >= :from AND started_at < :to${mountFilter(r.mount)}
      AND (${SESSION_END} - started_at) >= :minDur
    GROUP BY day`).all(params(r, { off, minDur: MIN_SESSION_MS }));
  const days = new Map();
  for (const x of samples) {
    const minutes = Math.max(1, (Math.min(x.day + DAY, r.to) - Math.max(x.day, r.from)) / MIN);
    days.set(x.day, { day: x.day, peak: x.peak, avgListeners: Math.round((x.lm / minutes) * 100) / 100, bytes: x.bytes });
  }
  for (const x of sessions) {
    const d = days.get(x.day) || { day: x.day, peak: 0, avgListeners: 0, bytes: 0 };
    Object.assign(d, { sessions: x.sessions, listeners: x.listeners, avgDurationSec: Math.round(x.avg_d / 1000), hours: Math.round((x.ms / HOUR) * 10) / 10 });
    days.set(x.day, d);
  }
  return [...days.values()].sort((a, b) => b.day - a.day);
}

function perMount(r) {
  const s = db.prepare(`
    SELECT mount, MAX(listeners_max) AS peak, SUM(listeners_avg) AS lm, SUM(bytes_sent) AS bytes
    FROM samples WHERE ts >= :from AND ts < :to GROUP BY mount`).all({ from: r.from, to: r.to });
  const ses = db.prepare(`
    SELECT mount, COUNT(*) AS sessions, COUNT(DISTINCT ip) AS listeners, SUM(${CLIPPED}) AS ms
    FROM sessions WHERE ${OVERLAP} AND (${SESSION_END} - started_at) >= :minDur GROUP BY mount`)
    .all({ from: r.from, to: r.to, minDur: MIN_SESSION_MS });
  const minutes = (r.to - r.from) / MIN;
  const map = new Map(s.map((x) => [x.mount, {
    mount: x.mount, peak: x.peak, avgListeners: Math.round((x.lm / minutes) * 100) / 100, bytes: x.bytes, sessions: 0, listeners: 0, hours: 0,
  }]));
  for (const x of ses) {
    const m = map.get(x.mount) || { mount: x.mount, peak: 0, avgListeners: 0, bytes: 0 };
    Object.assign(m, { sessions: x.sessions, listeners: x.listeners, hours: Math.round((x.ms / HOUR) * 10) / 10 });
    map.set(x.mount, m);
  }
  return [...map.values()].sort((a, b) => b.hours - a.hours);
}

export function overview(query) {
  const r = parseRange(query);
  return {
    range: r,
    kpis: kpis(r),
    series: series(r),
    players: breakdown(r, 'player'),
    os: breakdown(r, 'os'),
    countries: breakdown(r, 'country'),
    durations: durations(r),
    heatmap: heatmap(r),
    daily: daily(r),
    mounts: perMount(r),
  };
}

export function tracks(query) {
  const r = parseRange(query);
  const limit = Math.min(Number(query.limit) || 100, 500);
  const offset = Number(query.offset) || 0;
  const history = db.prepare(`
    SELECT id, mount, title, started_at, COALESCE(ended_at, last_seen) AS ended_at, ended_at IS NULL AS playing,
           listeners_start, listeners_end, listeners_peak
    FROM tracks WHERE started_at >= :from AND started_at < :to${mountFilter(r.mount)}
    ORDER BY started_at DESC LIMIT :limit OFFSET :offset`).all(params(r, { limit, offset }));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE started_at >= :from AND started_at < :to${mountFilter(r.mount)}`)
    .get(params(r)).n;
  const top = db.prepare(`
    SELECT title, COUNT(*) AS plays, ROUND(AVG(listeners_peak), 1) AS avg_peak, MAX(listeners_peak) AS max_peak,
           ROUND(AVG(listeners_end - listeners_start), 2) AS avg_delta,
           ROUND(AVG(COALESCE(ended_at, last_seen) - started_at) / 1000) AS avg_duration
    FROM tracks WHERE started_at >= :from AND started_at < :to${mountFilter(r.mount)}
      AND COALESCE(ended_at, last_seen) - started_at >= 30000
    GROUP BY title ORDER BY plays DESC, avg_peak DESC LIMIT 50`).all(params(r));
  return { range: r, total, history, top };
}

export function sessions(query) {
  const r = parseRange(query);
  const limit = Math.min(Number(query.limit) || 100, 1000);
  const offset = Number(query.offset) || 0;
  const minDur = query.all === '1' ? 0 : MIN_SESSION_MS;
  const where = `${OVERLAP}${mountFilter(r.mount)} AND (${SESSION_END} - started_at) >= :minDur`;
  const rows = db.prepare(`
    SELECT id, mount, ip, user_agent, player, os, country, referer, started_at, ${SESSION_END} AS ended_at,
           ended_at IS NULL AS active, (${SESSION_END} - started_at) AS duration
    FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT :limit OFFSET :offset`)
    .all(params(r, { minDur, limit, offset }));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${where}`).get(params(r, { minDur })).n;
  return { range: r, total, rows };
}

export function sessionsCsv(query) {
  const { rows } = sessions({ ...query, limit: 1000000, offset: 0 });
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const iso = (t) => new Date(t).toISOString();
  const lines = ['debut;fin;duree_s;point_de_montage;ip;pays;lecteur;systeme;user_agent'];
  for (const x of rows) {
    lines.push([iso(x.started_at), iso(x.ended_at), Math.round(x.duration / 1000), x.mount, x.ip, x.country, x.player, x.os, x.user_agent]
      .map(csvEsc).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

export function events(query) {
  const limit = Math.min(Number(query.limit) || 200, 1000);
  const type = query.type || null;
  return db.prepare(`SELECT * FROM events ${type ? 'WHERE type = :type' : ''} ORDER BY ts DESC LIMIT :limit`)
    .all(type ? { type, limit } : { limit });
}
