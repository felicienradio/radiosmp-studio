import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import maxmind from 'maxmind';
import { DATA_DIR } from './settings.js';

// Géolocalisation optionnelle avec les bases gratuites DB-IP Lite (licence CC BY 4.0, https://db-ip.com),
// téléchargées depuis le dashboard. La base "villes" permet la carte du monde des écoutes.
const GEO_DIR = path.join(DATA_DIR, 'geoip');
const FILES = {
  city: { file: path.join(GEO_DIR, 'city.mmdb'), url: (m) => `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`, size: '60 Mo' },
  country: { file: path.join(GEO_DIR, 'country.mmdb'), url: (m) => `https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`, size: '4 Mo' },
};

let reader = null;
let kind = null;

export async function initGeo() {
  reader = null;
  kind = null;
  for (const k of ['city', 'country']) {
    if (!fs.existsSync(FILES[k].file)) continue;
    try {
      reader = await maxmind.open(FILES[k].file);
      kind = k;
      return true;
    } catch (err) {
      console.error(`GeoIP : lecture impossible de ${FILES[k].file}`, err.message);
    }
  }
  return false;
}

function isPrivate(ip) {
  if (!net.isIP(ip)) return true;
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80)/i.test(ip);
}

/**
 * Localise une IP : { country: "FR" | "LAN" | null, city, lat, lon }.
 */
export function lookup(ip) {
  const empty = { country: null, city: null, lat: null, lon: null };
  if (!ip) return empty;
  ip = ip.replace(/^::ffff:/, '');
  if (isPrivate(ip)) return { ...empty, country: 'LAN' };
  if (!reader) return empty;
  try {
    const r = reader.get(ip);
    if (!r) return empty;
    return {
      country: r.country?.iso_code || null,
      city: r.city?.names?.fr || r.city?.names?.en || null,
      lat: r.location?.latitude ?? null,
      lon: r.location?.longitude ?? null,
    };
  } catch {
    return empty;
  }
}

export function geoStatus() {
  const f = kind ? FILES[kind].file : null;
  return {
    installed: !!reader,
    kind,
    hasCities: kind === 'city',
    updatedAt: f && fs.existsSync(f) ? fs.statSync(f).mtimeMs : null,
    sizes: { city: FILES.city.size, country: FILES.country.size },
    source: 'IP Geolocation by DB-IP (CC BY 4.0)',
  };
}

/** Télécharge la base DB-IP Lite du mois (ou du mois précédent si elle n'est pas encore publiée). */
export async function downloadGeo(which = 'city') {
  const target = FILES[which] || FILES.city;
  fs.mkdirSync(GEO_DIR, { recursive: true });
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  let lastError;
  for (const month of months) {
    const url = target.url(month);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = target.file + '.tmp';
      await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), fs.createWriteStream(tmp));
      fs.renameSync(tmp, target.file);
      // la base villes contient aussi les pays : l'ancienne base pays devient inutile
      if (which === 'city' && fs.existsSync(FILES.country.file)) fs.unlinkSync(FILES.country.file);
      await initGeo();
      return { month, url };
    } catch (err) {
      lastError = `${url} : ${err.message}`;
    }
  }
  throw new Error(`Téléchargement GeoIP impossible (${lastError})`);
}
