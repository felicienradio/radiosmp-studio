import crypto from 'node:crypto';
import { getSettings, updateSettings } from './settings.js';

const COOKIE = 'flux_session';
const MAX_AGE = 30 * 86400_000;

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

function sign(payload) {
  const { sessionSecret } = getSettings().dashboard;
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function isAuthed(req) {
  const value = readCookie(req);
  if (!value) return false;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const { exp, v } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  // "v" change quand le mot de passe change : toutes les sessions existantes sont invalidées
  return exp > Date.now() && v === passwordVersion();
}

function passwordVersion() {
  return (getSettings().dashboard.passwordHash || '').slice(-12);
}

function setSession(req, res) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE, v: passwordVersion() })).toString('base64url');
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE / 1000}${secure}`);
}

// Limitation des tentatives de connexion : 10 échecs / 15 min par IP
const failures = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  failures.set(ip, list);
  return list.length >= 10;
}

export function authRoutes(app) {
  app.get('/api/auth/state', (req, res) => {
    const { name, slogan } = getSettings().branding || {};
    res.json({ needsSetup: !getSettings().dashboard.passwordHash, authed: isAuthed(req), branding: { name, slogan } });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (getSettings().dashboard.passwordHash) return res.status(400).json({ error: 'Le mot de passe est déjà défini' });
    const { password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
    updateSettings((s) => { s.dashboard.passwordHash = hashPassword(password); });
    setSession(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes' });
    const { password } = req.body || {};
    if (!password || !verifyPassword(password, getSettings().dashboard.passwordHash)) {
      failures.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    failures.delete(req.ip);
    setSession(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Non connecté' });
}

export function changePassword(req, res) {
  const { current, password } = req.body || {};
  if (!verifyPassword(current || '', getSettings().dashboard.passwordHash)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  }
  if (!password || password.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
  updateSettings((s) => { s.dashboard.passwordHash = hashPassword(password); });
  setSession(req, res);
  res.json({ ok: true });
}
