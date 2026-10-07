import { EventEmitter } from 'node:events';
import { db, tx, logEvent } from './db.js';
import { parseUserAgent } from './useragent.js';
import { lookupCountry } from './geo.js';

const MINUTE = 60_000;
const HISTORY_MS = 60 * MINUTE;

const q = {
  insertSample: db.prepare(`INSERT INTO samples (mount, ts, listeners_avg, listeners_max, bytes_sent) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (mount, ts) DO UPDATE SET listeners_avg = excluded.listeners_avg,
      listeners_max = MAX(listeners_max, excluded.listeners_max), bytes_sent = bytes_sent + excluded.bytes_sent`),
  openSessions: db.prepare('SELECT id, mount, client_key, ip, user_agent, player, os, country, started_at, last_seen FROM sessions WHERE ended_at IS NULL'),
  insertSession: db.prepare(`INSERT INTO sessions (mount, client_key, ip, user_agent, player, os, country, referer, started_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
  closeSession: db.prepare('UPDATE sessions SET ended_at = last_seen WHERE id = ?'),
  openTracks: db.prepare('SELECT id, mount, title, listeners_peak FROM tracks WHERE ended_at IS NULL'),
  insertTrack: db.prepare(`INSERT INTO tracks (mount, title, started_at, last_seen, listeners_start, listeners_end, listeners_peak)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  touchTrack: db.prepare('UPDATE tracks SET last_seen = ?, listeners_end = ?, listeners_peak = MAX(listeners_peak, ?) WHERE id = ?'),
  closeTrack: db.prepare('UPDATE tracks SET ended_at = last_seen WHERE id = ?'),
  record: db.prepare('SELECT MAX(t) AS r FROM (SELECT SUM(listeners_max) AS t FROM samples GROUP BY ts)'),
};

/**
 * Interroge Icecast à intervalle régulier et enregistre :
 * - les échantillons d'audience (agrégés par minute),
 * - chaque session d'auditeur (IP, lecteur, pays, durée),
 * - l'historique des titres, les connexions/déconnexions de sources.
 */
export class Collector extends EventEmitter {
  constructor({ api, proc, getSettings }) {
    super();
    this.api = api;
    this.proc = proc;
    this.getSettings = getSettings;
    this.live = { online: false, updatedAt: null, error: null, server: null, mounts: [], listeners: [], totals: { listeners: 0, kbps: 0 } };
    this.history = [];
    this.sessions = new Map(); // client_key -> session
    this.tracks = new Map(); // mount -> track
    this.minutes = new Map(); // mount -> accumulateur de la minute en cours
    this.prev = new Map(); // mount -> { bytesSent, ts }
    this.firstTick = true;
    this.wasOnline = null;
    this.record = q.record.get().r || 0;
    this.restore();
  }

  restore() {
    for (const s of q.openSessions.all()) this.sessions.set(s.client_key, { ...s, seen: false });
    for (const t of q.openTracks.all()) this.tracks.set(t.mount, t);
    // Courbe "en direct" : on reprend la dernière heure enregistrée (à la minute)
    const rows = db.prepare('SELECT ts, mount, listeners_avg FROM samples WHERE ts >= ? ORDER BY ts')
      .all(Date.now() - HISTORY_MS);
    const byTs = new Map();
    for (const r of rows) {
      const p = byTs.get(r.ts) || { ts: r.ts, total: 0, mounts: {} };
      p.mounts[r.mount] = Math.round(r.listeners_avg);
      p.total += Math.round(r.listeners_avg);
      byTs.set(r.ts, p);
    }
    this.history = [...byTs.values()];
  }

  start() {
    const loop = async () => {
      await this.tick().catch((err) => console.error('Collecteur :', err));
      this.timer = setTimeout(loop, Math.max(2, this.getSettings().collector.intervalSec) * 1000);
    };
    loop();
    this.purge();
    this.purgeTimer = setInterval(() => this.purge(), 6 * 3600_000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.purgeTimer);
  }

  purge() {
    const days = this.getSettings().collector.retentionDays;
    if (!days) return;
    const cutoff = Date.now() - days * 86400_000;
    db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff);
    db.prepare('DELETE FROM tracks WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff);
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  }

  async tick() {
    const now = Date.now();
    let stats;
    try {
      stats = await this.api.stats();
    } catch (err) {
      return this.offline(now, err.message);
    }

    const clients = {};
    await Promise.all(stats.mounts.map(async (m) => {
      const hasOpen = [...this.sessions.values()].some((s) => s.mount === m.mount);
      if (m.listeners === 0 && !hasOpen) {
        clients[m.mount] = [];
        return;
      }
      try {
        clients[m.mount] = await this.api.listClients(m.mount);
      } catch {
        clients[m.mount] = null; // inconnu : on ne touche pas aux sessions de ce montage
      }
    }));

    tx(() => this.record_(now, stats, clients));
    this.firstTick = false;
    this.emit('update', this.live);
  }

  record_(now, stats, clients) {
    if (this.wasOnline === false) logEvent('info', 'server_online', 'Icecast répond de nouveau');
    this.wasOnline = true;

    const liveListeners = [];
    const mounts = [];
    const current = new Set(stats.mounts.map((m) => m.mount));
    let totalKbps = 0;

    for (const m of stats.mounts) {
      // Connexion d'une source
      if (!this.prev.has(m.mount) && !this.firstTick) {
        logEvent('info', 'source_connect', `Source connectée${m.encoder ? ` (${m.encoder})` : ''}${m.sourceIp ? ` depuis ${m.sourceIp}` : ''}`, m.mount);
      }
      const prev = this.prev.get(m.mount);
      const deltaBytes = prev && m.bytesSent >= prev.bytesSent ? m.bytesSent - prev.bytesSent : 0;
      const kbps = prev && now > prev.ts ? (deltaBytes * 8) / ((now - prev.ts) / 1000) / 1000 : 0;
      totalKbps += kbps;
      this.prev.set(m.mount, { bytesSent: m.bytesSent, ts: now });

      this.accumulate(m.mount, now, m.listeners, deltaBytes);
      this.trackTitle(m.mount, (m.title || '').trim(), m.listeners, now);
      const list = this.reconcile(m.mount, clients[m.mount], stats.instance, now);
      liveListeners.push(...list);

      mounts.push({ ...m, kbps: Math.round(kbps) });
    }

    // Sources déconnectées
    for (const mount of [...this.prev.keys()]) {
      if (current.has(mount)) continue;
      this.prev.delete(mount);
      logEvent('warning', 'source_disconnect', 'Source déconnectée', mount);
      this.trackTitle(mount, '', 0, now);
    }
    // Sessions dont le montage a disparu
    for (const [key, s] of this.sessions) {
      if (!current.has(s.mount)) this.closeSession(key, s);
    }
    this.flushMinutes(now);

    const total = stats.mounts.reduce((a, m) => a + m.listeners, 0);
    if (total > this.record && total >= 10) {
      logEvent('info', 'record', `Nouveau record : ${total} auditeurs simultanés`);
    }
    this.record = Math.max(this.record, total);

    this.pushHistory(now, total, Object.fromEntries(stats.mounts.map((m) => [m.mount, m.listeners])));
    this.live = {
      online: true,
      updatedAt: now,
      error: null,
      server: {
        id: stats.serverId,
        start: stats.serverStart,
        host: stats.host,
        location: stats.location,
        clients: stats.clients,
        connections: stats.connections,
        sources: stats.sources,
      },
      mounts,
      listeners: liveListeners,
      totals: { listeners: total, kbps: Math.round(totalKbps), record: this.record },
    };
  }

  accumulate(mount, now, listeners, bytes) {
    const bucket = Math.floor(now / MINUTE) * MINUTE;
    let acc = this.minutes.get(mount);
    if (acc && acc.bucket !== bucket) {
      this.writeMinute(mount, acc);
      acc = null;
    }
    if (!acc) {
      acc = { bucket, sum: 0, n: 0, max: 0, bytes: 0 };
      this.minutes.set(mount, acc);
    }
    acc.sum += listeners;
    acc.n += 1;
    acc.max = Math.max(acc.max, listeners);
    acc.bytes += bytes;
  }

  writeMinute(mount, acc) {
    if (!acc.n) return;
    q.insertSample.run(mount, acc.bucket, acc.sum / acc.n, acc.max, acc.bytes);
  }

  flushMinutes(now, force = false) {
    const bucket = Math.floor(now / MINUTE) * MINUTE;
    for (const [mount, acc] of this.minutes) {
      if (force || acc.bucket < bucket || !this.prev.has(mount)) {
        this.writeMinute(mount, acc);
        this.minutes.delete(mount);
      }
    }
  }

  trackTitle(mount, title, listeners, now) {
    const cur = this.tracks.get(mount);
    if (cur && cur.title === title) {
      q.touchTrack.run(now, listeners, listeners, cur.id);
      return;
    }
    if (cur) {
      q.closeTrack.run(cur.id);
      this.tracks.delete(mount);
    }
    if (title) {
      const { lastInsertRowid } = q.insertTrack.run(mount, title, now, now, listeners, listeners, listeners);
      this.tracks.set(mount, { id: Number(lastInsertRowid), mount, title });
    }
  }

  reconcile(mount, list, instance, now) {
    const out = [];
    if (list === null) {
      // listclients a échoué : on garde l'état précédent
      for (const s of this.sessions.values()) if (s.mount === mount) out.push(this.view(s, now));
      return out;
    }
    const seen = new Set();
    for (const l of list) {
      const key = `${instance}|${mount}|${l.id}`;
      seen.add(key);
      let s = this.sessions.get(key);
      if (!s) {
        const { player, os } = parseUserAgent(l.userAgent);
        const country = lookupCountry(l.ip);
        const startedAt = now - l.connected * 1000;
        const { lastInsertRowid } = q.insertSession.run(mount, key, l.ip, l.userAgent, player, os, country, l.referer || null, startedAt, now);
        s = { id: Number(lastInsertRowid), mount, client_key: key, ip: l.ip, user_agent: l.userAgent, player, os, country, started_at: startedAt };
        this.sessions.set(key, s);
      } else {
        q.touchSession.run(now, s.id);
      }
      s.last_seen = now;
      s.clientId = l.id;
      out.push(this.view(s, now));
    }
    for (const [key, s] of this.sessions) {
      if (s.mount === mount && !seen.has(key)) this.closeSession(key, s);
    }
    return out;
  }

  view(s, now) {
    return {
      mount: s.mount,
      id: s.clientId ?? s.client_key.split('|').pop(),
      ip: s.ip,
      userAgent: s.user_agent,
      player: s.player,
      os: s.os,
      country: s.country,
      startedAt: s.started_at,
      duration: Math.round((now - s.started_at) / 1000),
    };
  }

  closeSession(key, s) {
    q.closeSession.run(s.id);
    this.sessions.delete(key);
  }

  offline(now, error) {
    const stoppedOnPurpose = this.getSettings().icecast.managed && ['stopped', 'stopping', 'starting'].includes(this.proc.state);
    if (this.wasOnline !== false && !stoppedOnPurpose) {
      logEvent(this.wasOnline ? 'error' : 'warning', 'server_offline', `Icecast ne répond pas : ${error}`);
    }
    this.wasOnline = false;
    tx(() => {
      for (const [key, s] of this.sessions) this.closeSession(key, s);
      for (const t of this.tracks.values()) q.closeTrack.run(t.id);
      this.tracks.clear();
      this.flushMinutes(now, true);
    });
    this.prev.clear();
    this.firstTick = false;
    this.pushHistory(now, 0, {});
    this.live = { online: false, updatedAt: now, error, server: null, mounts: [], listeners: [], totals: { listeners: 0, kbps: 0, record: this.record } };
    this.proc.checkAlive();
    this.emit('update', this.live);
  }

  pushHistory(ts, total, mounts) {
    this.history.push({ ts, total, mounts });
    while (this.history.length && this.history[0].ts < ts - HISTORY_MS) this.history.shift();
  }
}
