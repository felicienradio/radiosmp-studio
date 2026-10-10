// Connexion au dashboard : comptes avec pseudo et mot de passe (voir users.js), session dans un cookie signé.
import crypto from 'node:crypto';
import { getSettings, updateSettings } from './settings.js';
import { branding } from './branding.js';
import {
  ROLES, can, findUser, getUserRow, publicUser, userCount, createUser, verifyPassword, markLogin,
  migrateLegacyPassword, changeOwnPassword, listUsers, updateUser, deleteUser,
} from './users.js';

const COOKIE = 'flux_session';
const MAX_AGE = 30 * 86400_000;

function sign(payload) {
  const { sessionSecret } = getSettings().dashboard;
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// « v » change quand le mot de passe du compte change : ses sessions ouvertes sont alors fermées
const passwordVersion = (u) => u.password_hash.slice(-12);

/** Compte connecté (ou null). */
export function currentUser(req) {
  const value = readCookie(req);
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data.uid || data.exp <= Date.now()) return null;
  const u = getUserRow(data.uid);
  return u && data.v === passwordVersion(u) ? u : null;
}

function setSession(req, res, u) {
  const payload = Buffer.from(JSON.stringify({ uid: u.id, exp: Date.now() + MAX_AGE, v: passwordVersion(u) })).toString('base64url');
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

const sendError = (res, err) => res.status(err.status || 400).json({ error: err.message });

export function authRoutes(app, { logEvent }) {
  // Ancienne version : le mot de passe unique devient le compte « admin »
  if (migrateLegacyPassword(getSettings().dashboard.passwordHash)) {
    updateSettings((s) => { s.dashboard.legacyAdmin = true; });
  }

  app.get('/api/auth/state', (req, res) => {
    const { name, slogan, theme } = branding();
    const u = currentUser(req);
    res.json({
      needsSetup: !userCount(),
      authed: !!u,
      user: u ? publicUser(u) : null,
      // après la mise à jour, le mot de passe d'avant se saisit avec le pseudo « admin »
      legacyHint: !!getSettings().dashboard.legacyAdmin,
      branding: { name, slogan, theme },
    });
  });

  // Première installation : création du compte administrateur
  app.post('/api/auth/setup', (req, res) => {
    if (userCount()) return res.status(400).json({ error: 'Le dashboard est déjà configuré' });
    try {
      const u = createUser({ username: req.body?.username, password: req.body?.password, role: 'admin' });
      setSession(req, res, getUserRow(u.id));
      markLogin(u.id);
      logEvent('info', 'auth', `Compte administrateur « ${u.username} » créé`);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/auth/login', (req, res) => {
    if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes' });
    const { username, password } = req.body || {};
    const u = findUser(username);
    if (!u || !password || !verifyPassword(password, u.password_hash)) {
      failures.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
    }
    failures.delete(req.ip);
    setSession(req, res, u);
    markLogin(u.id);
    if (getSettings().dashboard.legacyAdmin) updateSettings((s) => { delete s.dashboard.legacyAdmin; });
    logEvent('info', 'auth', `Connexion de ${u.username}`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });
}

export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Non connecté' });
  req.user = u;
  next();
}

/** Vérifie que le rôle du compte autorise la requête. */
export function authorize(req, res, next) {
  if (can(req.user.role, req.method, req.baseUrl + req.path)) return next();
  res.status(403).json({ error: 'Action réservée à un administrateur' });
}

/** Mon compte et gestion des utilisateurs (administrateurs). */
export function accountRoutes(app, { wrap, logEvent }) {
  app.get('/api/account', wrap((req) => ({ user: publicUser(req.user), roles: ROLES })));
  app.post('/api/account/password', (req, res) => {
    try {
      changeOwnPassword(req.user.id, req.body?.current, req.body?.password);
      setSession(req, res, getUserRow(req.user.id));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/users', wrap(() => ({ users: listUsers(), roles: ROLES })));
  app.post('/api/users', wrap((req) => {
    const u = createUser(req.body || {});
    logEvent('info', 'auth', `Compte « ${u.username} » (${ROLES[u.role]}) créé par ${req.user.username}`);
    return u;
  }));
  app.put('/api/users/:id', (req, res) => {
    try {
      const u = updateUser(req.params.id, req.body || {});
      logEvent('info', 'auth', `Compte « ${u.username} » modifié par ${req.user.username}`);
      // Son propre mot de passe changé : la session est renouvelée pour rester connecté
      if (u.id === req.user.id) setSession(req, res, getUserRow(u.id));
      res.json(u);
    } catch (err) {
      sendError(res, err);
    }
  });
  app.delete('/api/users/:id', wrap((req) => {
    if (Number(req.params.id) === req.user.id) throw Object.assign(new Error('Vous ne pouvez pas supprimer votre propre compte'), { status: 400 });
    const u = deleteUser(req.params.id);
    logEvent('info', 'auth', `Compte « ${u.username} » supprimé par ${req.user.username}`);
  }));
}
