// Routes de l'API AutoDJ : bibliothèque, playlists, stations (flux de sortie, playlists, grille), pilotage.
import crypto from 'node:crypto';
import { getSettings, updateSettings, randomPassword } from '../settings.js';
import * as lib from './library.js';
import * as pl from './playlists.js';
import * as st from './stations.js';
import { AUTODJ_DEFAULTS } from './engine.js';

export function autodjConfig() {
  return { ...AUTODJ_DEFAULTS, ...(getSettings().autodj || {}) };
}

/** Points de montage Icecast à créer ou régler pour une station (flux de sortie et secours du direct). */
function prepareMounts(station) {
  updateSettings((s) => {
    const mounts = s.icecast.mounts;
    const base = (name) => ({
      id: crypto.randomUUID(), name, streamName: '', description: '', genre: '', url: '', maxListeners: 0,
      username: 'source', password: randomPassword(), fallbackMount: '', fallbackOverride: true, fallbackWhenFull: false,
      hidden: false, public: false, relayUrl: '', onDemand: false, startMode: 'lowlatency',
    });
    for (const o of station.outputs) {
      if (mounts.some((m) => m.name === o.mount)) continue;
      // Avec un flux direct, la sortie de l'AutoDJ sert de secours : on la masque de la page publique d'Icecast
      mounts.push({ ...base(o.mount), streamName: station.name, description: 'Diffusion automatique', hidden: !!station.liveMount, startMode: 'instant' });
    }
    if (station.liveMount) {
      let live = mounts.find((m) => m.name === station.liveMount);
      if (!live) {
        live = { ...base(station.liveMount), streamName: s.branding?.name || station.name };
        mounts.push(live);
      }
      live.fallbackMount = station.outputs[0].mount;
      live.fallbackOverride = true;
    }
  });
}

export function autodjRoutes(app, { wrap, autodj, logEvent, proc }) {
  // ---------- Bibliothèque ----------
  app.get('/api/autodj/media', wrap((req) => ({
    items: lib.listMedia(String(req.query.q || '')), stats: lib.libraryStats(), analysing: lib.analysisPending(),
    autoCue: autodjConfig().autoCue !== false,
  })));
  app.post('/api/autodj/media', wrap(async (req) => {
    const m = await lib.importUpload(req);
    logEvent('info', 'autodj', `Ajouté à la bibliothèque : ${lib.displayTitle(m)}`);
    // Points cue automatiques en tâche de fond
    if (autodjConfig().autoCue !== false) lib.queueAutoCue([m.id]);
    return m;
  }));

  // ---------- Points cue ----------
  app.get('/api/autodj/media/:id/waveform', wrap((req) => lib.mediaWaveform(req.params.id)));
  app.put('/api/autodj/media/:id/cues', wrap((req) => {
    const m = lib.setCues(req.params.id, req.body || {});
    autodj.resetAll();
    return m;
  }));
  app.post('/api/autodj/media/:id/autocue', wrap(async (req) => {
    const m = await lib.autoCue(req.params.id, { force: true });
    autodj.resetAll();
    return m;
  }));
  // Analyse de toute la bibliothèque : les titres réglés à la main ne sont pas modifiés (sauf force)
  app.post('/api/autodj/autocue', wrap((req) => {
    const force = !!req.body?.force;
    const ids = lib.listMedia().filter((m) => force || m.cue_auto).map((m) => m.id);
    lib.queueAutoCue(ids, { force });
    return { queued: ids.length };
  }));
  app.put('/api/autodj/media/:id', wrap((req) => lib.updateMedia(req.params.id, req.body || {})));
  app.delete('/api/autodj/media/:id', wrap((req) => {
    lib.deleteMedia(req.params.id);
    autodj.resetAll();
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
    autodj.resetAll();
    return p;
  }));
  app.delete('/api/autodj/playlists/:id', wrap((req) => {
    pl.deletePlaylist(req.params.id);
    autodj.resetAll();
  }));
  app.put('/api/autodj/playlists/:id/items', wrap((req) => {
    const p = pl.setItems(req.params.id, req.body?.mediaIds);
    autodj.resetAll();
    return p;
  }));
  app.post('/api/autodj/playlists/:id/items', wrap((req) => {
    const p = pl.addItems(req.params.id, req.body?.mediaIds);
    autodj.resetAll();
    return p;
  }));

  // ---------- Stations ----------
  app.get('/api/autodj', wrap(() => ({ ...autodj.status(), autoCue: autodjConfig().autoCue !== false })));

  // Réglages communs (points cue automatiques)
  app.put('/api/autodj/settings', wrap((req) => {
    if ('autoCue' in (req.body || {})) updateSettings((s) => { s.autodj = { ...autodjConfig(), autoCue: !!req.body.autoCue }; });
    return { autoCue: autodjConfig().autoCue !== false };
  }));

  app.post('/api/autodj/stations', wrap((req) => {
    const b = req.body || {};
    const n = st.listStations().length + 1;
    const s = st.createStation({
      name: b.name || `AutoDJ ${n}`,
      outputs: b.outputs || [{ mount: `/autodj${n}`, format: 'mp3', bitrate: 128 }],
      liveMount: b.liveMount || '',
      crossfade: b.crossfade !== false,
    });
    logEvent('info', 'autodj', `Station AutoDJ « ${s.name} » créée`);
    autodj.emit('change');
    return autodj.player(s.id).status();
  }));

  app.put('/api/autodj/stations/:id', wrap(async (req) => {
    const before = st.getStation(req.params.id);
    const s = st.updateStation(req.params.id, req.body || {});
    autodj.player(s.id).resetUpcoming();
    // Flux de sortie modifiés : on relance l'encodeur
    if (JSON.stringify(before.outputs) !== JSON.stringify(s.outputs)) await autodj.restart(s.id);
    return autodj.player(s.id).status();
  }));

  app.delete('/api/autodj/stations/:id', wrap(async (req) => {
    const s = st.getStation(req.params.id);
    if (!s) throw lib.fail('Station introuvable', 404);
    await autodj.remove(s.id);
    st.deleteStation(s.id);
    logEvent('info', 'autodj', `Station AutoDJ « ${s.name} » supprimée`);
    autodj.emit('change');
  }));

  // Playlists de la station : [{ playlistId, mode: rotation|tracks|minutes, weight, every }]
  app.put('/api/autodj/stations/:id/playlists', wrap((req) => {
    st.setLinks(req.params.id, req.body?.links);
    const p = autodj.player(req.params.id);
    p.resetUpcoming();
    return p.status();
  }));

  /**
   * Prépare Icecast pour la station : points de montage des flux de sortie (démarrage instantané) et,
   * s'il y a un flux direct, l'AutoDJ comme secours : un animateur qui s'y connecte prend l'antenne,
   * l'AutoDJ reprend quand il coupe.
   */
  app.post('/api/autodj/stations/:id/setup', wrap((req) => {
    const s = st.getStation(req.params.id);
    if (!s) throw lib.fail('Station introuvable', 404);
    prepareMounts(s);
    logEvent('info', 'autodj', `${s.name} : flux ${s.outputs.map((o) => o.mount).join(', ')} configurés${s.liveMount ? `, secours de ${s.liveMount}` : ''}`);
    return { ...autodj.player(s.id).status(), process: proc.status() };
  }));

  app.post('/api/autodj/stations/:id/start', wrap(async (req) => {
    const p = autodj.player(req.params.id);
    st.setEnabled(p.stationId, true);
    await p.start();
    return p.status();
  }));
  app.post('/api/autodj/stations/:id/stop', wrap(async (req) => {
    const p = autodj.player(req.params.id);
    st.setEnabled(p.stationId, false);
    await p.stop();
    return p.status();
  }));
  app.post('/api/autodj/stations/:id/skip', wrap((req) => {
    const p = autodj.player(req.params.id);
    p.skip();
    return p.status();
  }));
  app.post('/api/autodj/stations/:id/queue', wrap((req) => {
    const p = autodj.player(req.params.id);
    p.enqueue(req.body?.mediaId);
    return p.status();
  }));
  app.delete('/api/autodj/stations/:id/queue/:index', wrap((req) => {
    const p = autodj.player(req.params.id);
    p.dequeue(req.params.index);
    return p.status();
  }));

  // ---------- Grille horaire (par station) ----------
  app.get('/api/autodj/stations/:id/schedule', wrap((req) => st.listSchedule(req.params.id)));
  app.post('/api/autodj/stations/:id/schedule', wrap((req) => {
    const r = st.createRule(req.params.id, req.body || {});
    autodj.player(req.params.id).resetUpcoming();
    return r;
  }));
  app.delete('/api/autodj/schedule/:id', wrap((req) => {
    const r = st.deleteRule(req.params.id);
    autodj.resetAll();
    return r;
  }));

  // Titres jamais analysés (bibliothèque d'avant les points cue) : analyse en tâche de fond après le démarrage
  setTimeout(() => {
    if (autodjConfig().autoCue === false) return;
    const ids = lib.listMedia().filter((m) => !m.analyzed_at).map((m) => m.id);
    if (ids.length) lib.queueAutoCue(ids);
  }, 15_000).unref();
}
