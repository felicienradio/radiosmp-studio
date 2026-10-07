import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import maxmind from 'maxmind';
import { DATA_DIR } from './settings.js';

// Géolocalisation par pays, optionnelle : base DB-IP "IP to Country Lite"
// (gratuite, licence CC BY 4.0, https://db-ip.com), téléchargée depuis le dashboard.
const GEO_DIR = path.join(DATA_DIR, 'geoip');
const DB_FILE = path.join(GEO_DIR, 'country.mmdb');

let reader = null;

export async function initGeo() {
  if (!fs.existsSync(DB_FILE)) return false;
  try {
    reader = await maxmind.open(DB_FILE);
    return true;
  } catch (err) {
    console.error('GeoIP : lecture impossible', err.message);
    reader = null;
    return false;
  }
}

function isPrivate(ip) {
  if (!net.isIP(ip)) return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
}

/** Code pays ISO (ex. "FR"), "LAN" pour un réseau local, null si inconnu. */
export function lookupCountry(ip) {
  if (!ip) return null;
  if (isPrivate(ip)) return 'LAN';
  if (!reader) return null;
  try {
    return reader.get(ip.replace(/^::ffff:/, ''))?.country?.iso_code || null;
  } catch {
    return null;
  }
}

export function geoStatus() {
  const exists = fs.existsSync(DB_FILE);
  return {
    installed: exists && !!reader,
    updatedAt: exists ? fs.statSync(DB_FILE).mtimeMs : null,
    source: 'DB-IP IP to Country Lite (CC BY 4.0)',
  };
}

/** Télécharge la base pays DB-IP Lite du mois (ou du mois précédent). */
export async function downloadGeo() {
  fs.mkdirSync(GEO_DIR, { recursive: true });
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  let lastError;
  for (const month of months) {
    const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gz = Buffer.from(await res.arrayBuffer());
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, zlib.gunzipSync(gz));
      fs.renameSync(tmp, DB_FILE);
      await initGeo();
      return { month, url };
    } catch (err) {
      lastError = `${url} : ${err.message}`;
    }
  }
  throw new Error(`Téléchargement GeoIP impossible (${lastError})`);
}
