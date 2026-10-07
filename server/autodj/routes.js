// Routes de l'API AutoDJ : bibliothèque, playlists, grille horaire, pilotage.
import crypto from 'node:crypto';
import { getSettings, updateSettings, randomPassword } from '../settings.js';
import * as lib from './library.js';
import * as pl from './playlists.js';
import { AUTODJ_DEFAULTS } from './engine.js';

export function autodjConfig() {
  return { ...AUTODJ_DEFAULTS, ...(getSettings().autodj || {}) };
}

export function autodjRoutes(app, { wrap, autodj, logEvent, proc }) {
  // ---------- Bibliothèque ----------
  app.get('/api/autodj/media', wrap((req) => ({ items: lib.listMedia(String(req.query.q || '')), stats: lib.libraryStats() })));
  app.post('/api/autodj/media', wrap(async (req) => {
    const m = await lib.importUpload(req);
    logEvent('info', 'autodj', `Ajouté à la bibliothèque : ${lib.displayTitle(m)}`);
    return m;
  }));
  app.put('/api/autodj/media/:id', wrap((req) => lib.updateMedia(req.params.id, req.body || {})));
  app.delete('/api/autodj/media/:id', wrap((req) => {
    lib.deleteMedia(req.params.id);
    autodj.resetUpcoming();
  }));
  app.get('/api/autodj/media/:id/audio', (req, res) => {
    const m = lib.getMedia(req.params.id);
    if (!m) return res.status(404).end();
    res.sendFile(lib.mediaPath(m));
  });

  // ---------- Playlists ----------
  app.get('/api/autodj/playlists', wrap(() => pl.listPlaylists()));
  app.post('/api/autodj/playlists', wrap((req) => pl.createPlaylist(req.body || {})));
  app.get('/api/autodj/playlists/:id', wrap((req) => pl.getPlaylist(req.params.id) || Promise.reject(lib.fail('Playlist introuvable', 404))));
  app.put('/api/autodj/playlists/:id', wrap((req) => {
    const p = pl.updatePlaylist(req.params.id, req.body || {});
    autodj.resetUpcoming();
    return p;
  }));
  app.delete('/api/autodj/playlists/:id', wrap((req) => {
    pl.deletePlaylist(req.params.id);
    const id = Number(req.params.id);
    updateSettings((s) => {
      const a = { ...AUTODJ_DEFAULTS, ...(s.autodj || {}) };
      if (a.defaultPlaylist === id) a.defaultPlaylist = null;
      if (a.jinglePlaylist === id) a.jinglePlaylist = null;
      s.autodj = a;
    });
    autodj.resetUpcoming();
  }));
  app.put('/api/autodj/playlists/:id/items', wrap((req) => {
    const p = pl.setItems(req.params.id, req.body?.mediaIds);
    autodj.resetUpcoming();
    return p;
  }));
  app.post('/api/autodj/playlists/:id/items', wrap((req) => {
    const p = pl.addItems(req.params.id, req.body?.mediaIds);
    autodj.resetUpcoming();
    return p;
  }));

  // ---------- Grille horaire ----------
  app.get('/api/autodj/schedule', wrap(() => pl.listSchedule()));
  app.post('/api/autodj/schedule', wrap((req) => { const r = pl.createRule(req.body || {}); autodj.resetUpcoming(); return r; }));
  app.put('/api/autodj/schedule/:id', wrap((req) => { const r = pl.updateRule(req.params.id, req.body || {}); autodj.resetUpcoming(); return r; }));
  app.delete('/api/autodj/schedule/:id', wrap((req) => { const r = pl.deleteRule(req.params.id); autodj.resetUpcoming(); return r; }));

  // ---------- Pilotage ----------
  app.get('/api/autodj', wrap(() => autodj.status()));

  app.put('/api/autodj/settings', wrap(async (req) => {
    const b = req.body || {};
    const before = autodjConfig();
    const next = { ...before };
    if ('mount' in b) {
      let m = String(b.mount || '').trim();
      if (!m.startsWith('/')) m = `/${m}`;
      if (!/^\/[A-Za-z0-9._\-/]+$/.test(m)) throw lib.fail('Point de montage invalide');
      next.mount = m;
    }
    if ('liveMount' in b) next.liveMount = String(b.liveMount || '/live').trim() || '/live';
    if ('format' in b) next.format = b.format === 'aac' ? 'aac' : 'mp3';
    if ('bitrate' in b) {
      const br = Number(b.bitrate);
      if (![64, 96, 128, 160, 192, 256, 320].includes(br)) throw lib.fail('Débit invalide');
      next.bitrate = br;
    }
    for (const k of ['defaultPlaylist', 'jinglePlaylist']) {
      if (k in b) next[k] = b[k] ? Number(b[k]) : null;
    }
    if ('jingleEvery' in b) next.jingleEvery = Math.max(0, Math.min(50, Math.floor(Number(b.jingleEvery) || 0)));
    updateSettings((s) => { s.autodj = next; });
    autodj.resetUpcoming();
    // Changement de point de montage ou de format : on relance l'encodeur
    if (autodj.encoder && (before.mount !== next.mount || before.format !== next.format || before.bitrate !== next.bitrate)) {
      await autodj.stop();
      await autodj.start();
    }
    return autodj.status();
  }));

  /**
   * Prépare Icecast pour l'AutoDJ : point de montage dédié (démarrage instantané) et flux de secours du direct.
   * Un animateur qui se connecte sur le flux direct prend l'antenne ; l'AutoDJ reprend quand il coupe.
   */
  app.post('/api/autodj/setup', wrap(() => {
    const a = autodjConfig();
    updateSettings((s) => {
      const mounts = s.icecast.mounts;
      let auto = mounts.find((m) => m.name === a.mount);
      if (!auto) {
        auto = {
          id: crypto.randomUUID(), name: a.mount, streamName: `${s.branding?.name || 'Radio'} AutoDJ`, description: 'Diffusion automatique',
          genre: '', url: '', maxListeners: 0, username: 'source', password: randomPassword(), fallbackMount: '',
          fallbackOverride: true, fallbackWhenFull: false, hidden: true, public: false, relayUrl: '', onDemand: false, startMode: 'instant',
        };
        mounts.push(auto);
      }
      let live = mounts.find((m) => m.name === a.liveMount);
      if (!live) {
        live = {
          id: crypto.randomUUID(), name: a.liveMount, streamName: s.branding?.name || 'Radio', description: '', genre: '', url: '',
          maxListeners: 0, username: 'source', password: randomPassword(), fallbackMount: '', fallbackOverride: true,
          fallbackWhenFull: false, hidden: false, public: false, relayUrl: '', onDemand: false, startMode: 'lowlatency',
        };
        mounts.push(live);
      }
      live.fallbackMount = a.mount;
      live.fallbackOverride = true;
    });
    logEvent('info', 'autodj', `AutoDJ configuré comme secours de ${a.liveMount}`);
    return { ...autodj.status(), process: proc.status() };
  }));

  app.post('/api/autodj/start', wrap(async () => {
    updateSettings((s) => { s.autodj = { ...autodjConfig(), enabled: true }; });
    await autodj.start();
    return autodj.status();
  }));
  app.post('/api/autodj/stop', wrap(async () => {
    updateSettings((s) => { s.autodj = { ...autodjConfig(), enabled: false }; });
    await autodj.stop();
    return autodj.status();
  }));
  app.post('/api/autodj/skip', wrap(() => { autodj.skip(); return autodj.status(); }));
  app.post('/api/autodj/queue', wrap((req) => { autodj.enqueue(req.body?.mediaId); return autodj.status(); }));
  app.delete('/api/autodj/queue/:index', wrap((req) => { autodj.dequeue(req.params.index); return autodj.status(); }));
}
