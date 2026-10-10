// Comptes du dashboard : pseudo + mot de passe, avec un rôle.
//  - admin  : tout (serveur, flux, utilisateurs, personnalisation, mises à jour)
//  - dj     : animateur, pilote l'AutoDJ (playlists, bibliothèque, file d'attente), change le titre, voit les stats
//  - viewer : lecture seule (tableau de bord, statistiques, rapport)
import crypto from 'node:crypto';
import { db } from './db.js';

export const ROLES = {
  admin: 'Administrateur',
  dj: 'Animateur',
  viewer: 'Lecture seule',
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'dj',
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
`);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Vue publique d'un compte (sans le mot de passe). */
const pub = (u) => u && { id: u.id, username: u.username, role: u.role, createdAt: u.created_at, lastLogin: u.last_login };

export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
export const findUser = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, username COLLATE NOCASE').all().map(pub);
export const publicUser = pub;

const adminCount = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\'').get().n;

function cleanUsername(v) {
  const name = String(v ?? '').trim();
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(name)) throw fail('Pseudo : 2 à 32 caractères (lettres, chiffres, . _ -), sans espace');
  return name;
}

function cleanPassword(v) {
  const p = String(v ?? '');
  if (p.length < 8) throw fail('Le mot de passe doit faire au moins 8 caractères');
  if (p.length > 200) throw fail('Mot de passe trop long');
  return p;
}

const cleanRole = (r) => (r in ROLES ? r : 'dj');

export function createUser({ username, password, role }) {
  const name = cleanUsername(username);
  if (findUser(name)) throw fail('Ce pseudo est déjà pris');
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(name, hashPassword(cleanPassword(password)), cleanRole(role), Date.now());
  return pub(getUserRow(lastInsertRowid));
}

export function updateUser(id, { username, password, role }) {
  const u = getUserRow(id);
  if (!u) throw fail('Utilisateur introuvable', 404);
  const name = username === undefined ? u.username : cleanUsername(username);
  const other = findUser(name);
  if (other && other.id !== u.id) throw fail('Ce pseudo est déjà pris');
  const newRole = role === undefined ? u.role : cleanRole(role);
  if (u.role === 'admin' && newRole !== 'admin' && adminCount() <= 1) throw fail('Il faut garder au moins un administrateur');
  const hash = password ? hashPassword(cleanPassword(password)) : u.password_hash;
  db.prepare('UPDATE users SET username = ?, role = ?, password_hash = ? WHERE id = ?').run(name, newRole, hash, u.id);
  return pub(getUserRow(id));
}

export function deleteUser(id) {
  const u = getUserRow(id);
  if (!u) throw fail('Utilisateur introuvable', 404);
  if (u.role === 'admin' && adminCount() <= 1) throw fail('Impossible de supprimer le dernier administrateur');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return pub(u);
}

export function changeOwnPassword(id, current, password) {
  const u = getUserRow(id);
  if (!u || !verifyPassword(String(current || ''), u.password_hash)) throw fail('Mot de passe actuel incorrect');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPassword(password)), u.id);
}

export function markLogin(id) {
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), Number(id));
}

/** Ancienne version (un seul mot de passe) : il devient le compte « admin ». */
export function migrateLegacyPassword(passwordHash) {
  if (!passwordHash || userCount()) return false;
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run('admin', passwordHash, 'admin', Date.now());
  return true;
}

// ---------- Droits ----------

const ADMIN_ONLY = /^\/api\/(server|update|users|geo|branding)(\/|$)/;
// Ce que peut modifier un animateur
const DJ_WRITE = [
  /^\/api\/autodj\/(media|playlists|autocue|schedule)(\/|$)/,
  /^\/api\/autodj\/stations\/\d+\/(playlists|schedule|start|stop|skip|queue)(\/|$)/,
  /^\/api\/mounts\/metadata$/,
];

/** Le rôle peut-il faire cette requête ? (path complet, ex. /api/mounts) */
export function can(role, method, path) {
  if (role === 'admin') return true;
  if (/^\/api\/(account|auth)(\/|$)/.test(path)) return true;
  if (path === '/api/branding' && method === 'GET') return true;
  if (ADMIN_ONLY.test(path)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  return role === 'dj' && DJ_WRITE.some((r) => r.test(path));
}
