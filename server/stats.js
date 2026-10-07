import isoCountries from 'i18n-iso-countries';
import { db } from './db.js';
import { parts, bucketStart, startOfDay, daysBetween, fmtDate, tz } from './time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Les connexions plus courtes sont des sondes de lecteurs / prévisualisations : elles comptent
// comme connexions, mais pas dans les durées d'écoute moyennes ni dans la répartition des durées.
export const MIN_SESSION_MS = 5_000;

db.exec('CREATE INDEX IF NOT EXISTS sessions_ip ON sessions(ip)');

const ROLLING = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY };
const CALENDAR = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

export function parseRange(query) {
  const now = Date.now();
  let from;
  let to = now;
  if (query.from && query.to) {
    from = Number(query.from);
    to = Math.min(Number(query.to), now);
  } else if (CALENDAR[query.range]) {
    // Périodes en jours : journées complètes, aujourd'hui inclus (comme un rapport d'audience)
    from = startOfDay(now - (CALENDAR[query.range] - 1) * DAY);
  } else {
    from = now - (ROLLING[query.range] || DAY);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Période invalide');
  const span = to - from;
  const bucket = span <= 2 * HOUR ? MIN
    : span <= 6 * HOUR ? 2 * MIN
    : span <= 26 * HOUR ? 5 * MIN
    : span <= 8 * DAY ? HOUR
    : span <= 31 * DAY ? 4 * HOUR
    : DAY;
  return { from, to, bucket, mount: query.mount || null, tz: tz() };
}

const mountFilter = (mount, col = 'mount') => (mount ? ` AND ${col} = :mount` : '');
function params(r, extra = {}) {
  const p = { from: r.from, to: r.to, ...extra };
  if (r.mount) p.mount = r.mount;
  return p;
}

function bucketsOf(r) {
  if (r.bucket >= DAY) return daysBetween(r.from, r.to);
  const out = [];
  for (let t = bucketStart(r.from, r.bucket); t < r.to; t += r.bucket) out.push(t);
  return out;
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// Audience (échantillons minute par minute)
// ---------------------------------------------------------------------------

function audience(r) {
  const rows = db.prepare(`
    SELECT ts, mount, listeners_avg AS a, listeners_max AS m, bytes_sent AS b
    FROM samples WHERE ts >= :from AND ts < :to${mountFilter(r.mount)} ORDER BY ts`).all(params(r));

  const perTs = new Map();
  const mountNames = new Set();
  for (const x of rows) {
    let p = perTs.get(x.ts);
    if (!p) perTs.set(x.ts, (p = { a: 0, m: 0, b: 0, mounts: {} }));
    p.a += x.a;
    p.m += x.m;
    p.b += x.b;
    p.mounts[x.mount] = x.a;
    mountNames.add(x.mount);
  }

  const buckets = bucketsOf(r);
  const idx = new Map(buckets.map((t, i) => [t, i]));
  const sumA = new Array(buckets.length).fill(0);
  const maxM = new Array(buckets.length).fill(0);
  const bytes = new Array(buckets.length).fill(0);
  const perMount = Object.fromEntries([...mountNames].map((m) => [m, new Array(buckets.length).fill(0)]));
  const heatSum = Array.from({ length: 7 }, () => new Array(24).fill(0));

  let peak = 0;
  let peakAt = null;
  let listenerMinutes = 0;
  let totalBytes = 0;
  for (const [ts, p] of perTs) {
    const i = idx.get(bucketStart(ts, r.bucket));
    if (i !== undefined) {
      sumA[i] += p.a;
      maxM[i] = Math.max(maxM[i], p.m);
      bytes[i] += p.b;
      for (const [m, a] of Object.entries(p.mounts)) perMount[m][i] += a;
    }
    const lp = parts(ts);
    heatSum[lp.dow][lp.hour] += p.a;
    if (p.m > peak || (p.m === peak && p.m > 0)) { peak = p.m; peakAt = ts; }
    listenerMinutes += p.a;
    totalBytes += p.b;
  }

  // Minutes réellement couvertes par chaque intervalle (le dernier est souvent incomplet)
  const covered = buckets.map((t, i) => {
    const end = i + 1 < buckets.length ? buckets[i + 1] : (r.bucket >= DAY ? startOfDay(t + 36 * HOUR) : t + r.bucket);
    return Math.max(1, (Math.min(end, r.to) - Math.max(t, r.from)) / MIN);
  });

  const heatMinutes = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let t = Math.floor(r.from / HOUR) * HOUR; t < r.to; t += HOUR) {
    const lp = parts(t);
    heatMinutes[lp.dow][lp.hour] += (Math.min(t + HOUR, r.to) - Math.max(t, r.from)) / MIN;
  }

  return {
    series: buckets.map((t, i) => ({ t, avg: round(sumA[i] / covered[i]), max: maxM[i], bytes: bytes[i] })),
    mountSeries: Object.fromEntries(Object.entries(perMount).map(([m, arr]) => [m, arr.map((s, i) => round(s / covered[i]))])),
    heatmap: heatSum.map((row, d) => row.map((s, h) => (heatMinutes[d][h] ? round(s / heatMinutes[d][h]) : 0))),
    peak,
    peakAt,
    avgListeners: round(listenerMinutes / ((r.to - r.from) / MIN)),
    bytesSent: totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Sessions (chaque connexion d'auditeur)
// ---------------------------------------------------------------------------

class Group {
  constructor() { this.ips = new Set(); this.connections = 0; this.ms = 0; }
  add(s, ms, started) {
    this.ips.add(s.ip);
    if (started) this.connections += 1;
    this.ms += ms;
  }
  out(extra = {}) {
    return { ...extra, unique: this.ips.size, connections: this.connections, hours: round(this.ms / HOUR) };
  }
}

function groupBy(map, key) {
  let g = map.get(key);
  if (!g) map.set(key, (g = new Group()));
  return g;
}

function sorted(map, label, limit = 30) {
  return [...map.entries()].map(([k, g]) => g.out(label(k)))
    .sort((a, b) => b.unique - a.unique || b.connections - a.connections).slice(0, limit);
}

function listening(r) {
  const rows = db.prepare(`
    SELECT ip, mount, started_at AS s, COALESCE(ended_at, last_seen) AS e, device, player, os, country, city, lat, lon
    FROM sessions WHERE started_at < :to AND COALESCE(ended_at, last_seen) >= :from${mountFilter(r.mount)}`).all(params(r));

  const total = new Group();
  const days = new Map(daysBetween(r.from, r.to).map((d) => [d, new Group()]));
  const hours = Array.from({ length: 24 }, () => new Group());
  const weekdays = Array.from({ length: 7 }, () => new Group());
  const countries = new Map();
  const cities = new Map();
  const devices = new Map();
  const players = new Map();
  const systems = new Map();
  const mounts = new Map();
  const durations = [];
  let qualified = 0;
  let qualifiedMs = 0;

  for (const s of rows) {
    const started = s.s >= r.from;
    const dur = Math.max(0, s.e - s.s);
    const ms = Math.max(0, Math.min(s.e, r.to) - Math.max(s.s, r.from));
    total.add(s, ms, started);
    groupBy(countries, s.country || '?').add(s, ms, started);
    groupBy(devices, s.device || 'Inconnu').add(s, ms, started);
    groupBy(players, s.player || 'Inconnu').add(s, ms, started);
    groupBy(systems, s.os || 'Autre').add(s, ms, started);
    groupBy(mounts, s.mount).add(s, ms, started);
    if (s.lat !== null && s.lon !== null) {
      const key = `${s.city || '?'}|${s.country || '?'}`;
      let c = cities.get(key);
      if (!c) cities.set(key, (c = { city: s.city, country: s.country, lat: s.lat, lon: s.lon, ips: new Set() }));
      c.ips.add(s.ip);
    }
    if (started) {
      // Répartitions temporelles : selon l'heure de début, dans le fuseau de la station
      const lp = parts(s.s);
      days.get(startOfDay(s.s))?.add(s, dur, true);
      hours[lp.hour].add(s, dur, true);
      weekdays[lp.dow].add(s, dur, true);
    }
    if (dur >= MIN_SESSION_MS) {
      qualified += 1;
      qualifiedMs += dur;
      durations.push(dur);
    }
  }

  durations.sort((a, b) => a - b);
  const limits = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, Infinity];
  const labels = ['< 1 min', '1–5 min', '5–15 min', '15–30 min', '30–60 min', '1–2 h', '> 2 h'];
  const dist = labels.map((label) => ({ label, sessions: 0 }));
  for (const d of durations) dist[limits.findIndex((l) => d < l)].sessions += 1;

  return {
    total,
    qualified,
    avgDurationSec: qualified ? Math.round(qualifiedMs / qualified / 1000) : 0,
    medianDurationSec: durations.length ? Math.round(durations[Math.floor(durations.length / 2)] / 1000) : 0,
    durations: dist,
    days: [...days.entries()].map(([day, g]) => g.out({ day })),
    hours: hours.map((g, hour) => g.out({ hour })),
    // lundi en premier
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((dow) => weekdays[dow].out({ dow })),
    // num : code ISO numérique, pour relier aux formes de pays de la carte
    countries: sorted(countries, (code) => ({ code, num: isoCountries.alpha2ToNumeric(code) || null }), 250),
    cities: [...cities.values()].map((c) => ({ city: c.city, country: c.country, lat: c.lat, lon: c.lon, unique: c.ips.size }))
      .sort((a, b) => b.unique - a.unique).slice(0, 500),
    devices: sorted(devices, (label) => ({ label })),
    players: sorted(players, (label) => ({ label })),
    os: sorted(systems, (label) => ({ label })),
    mounts: sorted(mounts, (mount) => ({ mount })),
  };
}

function returningListeners(r) {
  return db.prepare(`
    SELECT COUNT(DISTINCT s.ip) AS n FROM sessions s
    WHERE s.started_at < :to AND COALESCE(s.ended_at, s.last_seen) >= :from${mountFilter(r.mount, 's.mount')}
      AND EXISTS (SELECT 1 FROM sessions p WHERE p.ip = s.ip AND p.started_at < :from)`).get(params(r)).n || 0;
}

function kpisOf(a, l, returning) {
  const countriesReached = l.countries.filter((c) => c.code !== '?' && c.code !== 'LAN').length;
  return {
    uniqueListeners: l.total.ips.size,
    connections: l.total.connections,
    sessions: l.qualified,
    listeningMs: Math.round(l.total.ms),
    listeningHours: round(l.total.ms / HOUR, 1),
    countries: countriesReached,
    peak: a.peak,
    peakAt: a.peakAt,
    avgListeners: a.avgListeners,
    avgDurationSec: l.avgDurationSec,
    medianDurationSec: l.medianDurationSec,
    returningListeners: returning,
    newListeners: Math.max(0, l.total.ips.size - returning),
    bytesSent: a.bytesSent,
  };
}

// ---------------------------------------------------------------------------
// « À retenir » : lectures automatiques, comme dans un rapport d'audience
// ---------------------------------------------------------------------------

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const nf = (n) => n.toLocaleString('fr-FR');

function insights(k, l, prev, r) {
  const out = {};
  const days = l.days.filter((d) => d.unique > 0);
  if (days.length) {
    const best = days.reduce((a, b) => (b.unique > a.unique ? b : a));
    const avg = Math.round(l.days.reduce((s, d) => s + d.unique, 0) / l.days.length);
    out.days = `Pic d'audience le ${fmtDate(best.day, { day: 'numeric', month: 'short' })} avec ${nf(best.unique)} auditeurs uniques · moyenne de ${nf(avg)} / jour.`;
  }
  const hour = l.hours.reduce((a, b) => (b.unique > a.unique ? b : a));
  if (hour.unique) out.hours = `Créneau le plus écouté : ${hour.hour}h (${nf(hour.unique)} auditeurs uniques).`;
  const wd = l.weekdays.reduce((a, b) => (b.unique > a.unique ? b : a));
  if (wd.unique) out.weekdays = `Journée la plus active : le ${DAY_NAMES[wd.dow]} (${nf(wd.unique)} auditeurs uniques).`;
  const top = l.countries.find((c) => c.code !== '?');
  if (top) out.countries = { code: top.code, share: pct(top.unique, k.uniqueListeners), unique: top.unique };
  const dev = l.devices.find((d) => d.label !== 'Inconnu');
  if (dev) out.devices = `${dev.label} est le support dominant (${pct(dev.unique, k.uniqueListeners)} % des auditeurs).`;
  if (k.medianDurationSec) {
    out.durations = `La moitié des sessions dure plus de ${k.medianDurationSec >= 3600
      ? `${Math.floor(k.medianDurationSec / 3600)} h ${String(Math.floor((k.medianDurationSec % 3600) / 60)).padStart(2, '0')}`
      : k.medianDurationSec >= 60 ? `${Math.round(k.medianDurationSec / 60)} min` : `${k.medianDurationSec} s`}.`;
  }
  if (prev && prev.uniqueListeners) {
    const d = pct(k.uniqueListeners - prev.uniqueListeners, prev.uniqueListeners);
    out.trend = d > 999
      ? `Auditeurs uniques multipliés par ${(k.uniqueListeners / prev.uniqueListeners).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} par rapport à la période précédente.`
      : `${d >= 0 ? '+' : ''}${d} % d'auditeurs uniques par rapport à la période précédente.`;
  }
  if (k.uniqueListeners) {
    out.loyalty = `${pct(k.returningListeners, k.uniqueListeners)} % de vos auditeurs étaient déjà venus avant cette période.`;
  }
  return out;
}

export function overview(query) {
  const r = parseRange(query);
  const a = audience(r);
  const l = listening(r);
  const k = kpisOf(a, l, returningListeners(r));

  // Période précédente de même durée, pour les tendances
  const pr = { ...r, from: r.from - (r.to - r.from), to: r.from };
  const pa = audience({ ...pr, bucket: DAY });
  const pl = listening(pr);
  const prev = kpisOf(pa, pl, returningListeners(pr));

  return {
    range: r,
    kpis: k,
    previous: prev,
    insights: insights(k, l, prev, r),
    series: a.series,
    mountSeries: a.mountSeries,
    heatmap: a.heatmap,
    days: l.days,
    hours: l.hours,
    weekdays: l.weekdays,
    countries: l.countries,
    cities: l.cities,
    devices: l.devices,
    players: l.players,
    os: l.os,
    durations: l.durations,
    mounts: l.mounts,
  };
}

// ---------------------------------------------------------------------------
// Titres, sessions, événements
// ---------------------------------------------------------------------------

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
  const limit = Math.min(Number(query.limit) || 100, 1_000_000);
  const offset = Number(query.offset) || 0;
  const minDur = query.all === '1' ? 0 : MIN_SESSION_MS;
  const where = `started_at < :to AND COALESCE(ended_at, last_seen) >= :from${mountFilter(r.mount)}
    AND (COALESCE(ended_at, last_seen) - started_at) >= :minDur`;
  const rows = db.prepare(`
    SELECT id, mount, ip, user_agent, player, os, device, country, city, referer, started_at,
           COALESCE(ended_at, last_seen) AS ended_at, ended_at IS NULL AS active,
           (COALESCE(ended_at, last_seen) - started_at) AS duration
    FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT :limit OFFSET :offset`)
    .all(params(r, { minDur, limit, offset }));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${where}`).get(params(r, { minDur })).n;
  return { range: r, total, rows };
}

export function sessionsCsv(query) {
  const { rows } = sessions({ ...query, limit: 1_000_000, offset: 0 });
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const iso = (t) => new Date(t).toISOString();
  const lines = ['debut;fin;duree_s;point_de_montage;ip;pays;ville;appareil;lecteur;systeme;user_agent'];
  for (const x of rows) {
    lines.push([iso(x.started_at), iso(x.ended_at), Math.round(x.duration / 1000), x.mount, x.ip, x.country, x.city,
      x.device, x.player, x.os, x.user_agent].map(csvEsc).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

export function events(query) {
  const limit = Math.min(Number(query.limit) || 200, 1000);
  const type = query.type || null;
  return db.prepare(`SELECT * FROM events ${type ? 'WHERE type = :type' : ''} ORDER BY ts DESC LIMIT :limit`)
    .all(type ? { type, limit } : { limit });
}
