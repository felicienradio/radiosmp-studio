// Calculs d'heure locale dans le fuseau de la station (et non celui du serveur :
// un conteneur LXC tourne souvent en UTC alors que la radio vit à l'heure de Paris).
import { getSettings } from './settings.js';

const HOUR = 3600_000;
const formatters = new Map();
const cache = new Map();

export function tz() {
  return getSettings().timezone || 'Europe/Paris';
}

function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Composantes locales d'un instant : { year, month, day, hour, minute, dow (0 = dimanche), offset (ms) }. */
export function parts(ts) {
  const zone = tz();
  const key = `${zone}|${Math.floor(ts / HOUR)}`;
  let p = cache.get(key);
  if (!p) {
    const base = Math.floor(ts / HOUR) * HOUR;
    const o = {};
    for (const { type, value } of formatter(zone).formatToParts(new Date(base))) o[type] = value;
    p = {
      year: Number(o.year), month: Number(o.month), day: Number(o.day), hour: Number(o.hour),
      minuteBase: Number(o.minute), dow: DOW[o.weekday],
    };
    p.offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minuteBase) - base;
    if (cache.size > 50_000) cache.clear();
    cache.set(key, p);
  }
  return p;
}

/** Minuit (heure locale) du jour contenant ts. */
export function startOfDay(ts) {
  const p = parts(ts);
  return Date.UTC(p.year, p.month - 1, p.day) - p.offset;
}

/** Début de l'intervalle de taille `size` contenant ts, aligné sur l'heure locale. */
export function bucketStart(ts, size) {
  if (size >= 86400_000) return startOfDay(ts);
  const off = parts(ts).offset;
  return Math.floor((ts + off) / size) * size - off;
}

export function dayKey(ts) {
  const p = parts(ts);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Liste des minuits locaux entre from et to. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = startOfDay(from); d < to; d = startOfDay(d + 36 * HOUR)) out.push(d);
  return out;
}

export function fmtDate(ts, opts = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tz(), ...opts }).format(new Date(ts));
}
