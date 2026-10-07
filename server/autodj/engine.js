// Moteur de l'AutoDJ.
//
// Un encodeur ffmpeg permanent lit de l'audio brut (PCM 44,1 kHz stéréo) sur son entrée, au rythme réel (-re),
// et le diffuse vers le point de montage de l'AutoDJ. Chaque titre est décodé par un ffmpeg séparé dont la sortie
// est injectée dans l'encodeur : le flux ne s'interrompt jamais entre deux titres. Sans rien à jouer, on envoie du
// silence pour garder la connexion avec Icecast.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { getMedia, mediaPath, markPlayed, displayTitle } from './library.js';
import { getPlaylist, playlistMediaIds, activeRule } from './playlists.js';

const RATE = 44100;
const BYTES_PER_SEC = RATE * 2 * 2;
const SILENCE = Buffer.alloc(BYTES_PER_SEC / 4); // 250 ms

export const AUTODJ_DEFAULTS = {
  enabled: false,
  mount: '/autodj',
  format: 'mp3',
  bitrate: 320,
  defaultPlaylist: null,
  jinglePlaylist: null,
  jingleEvery: 4,
  liveMount: '/live',
};

export function ffmpegAvailable() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

export class AutoDJ extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig   réglages de l'AutoDJ
   * @param {() => object} o.getIcecast  réglages Icecast en vigueur (port, mots de passe, flux)
   * @param {object} o.api               client IcecastApi (mise à jour du titre)
   * @param {(level, type, msg) => void} o.log
   */
  constructor({ getConfig, getIcecast, api, log }) {
    super();
    Object.assign(this, { getConfig, getIcecast, api, log });
    this.state = 'stopped';
    this.encoder = null;
    this.decoder = null;
    this.current = null; // { media, startedAt, source }
    this.queue = []; // titres demandés à la main (« jouer ensuite »)
    this.upcoming = []; // titres déjà choisis automatiquement
    this.history = [];
    this.cycles = new Map(); // playlist -> titres pas encore joués dans le cycle aléatoire
    this.cursors = new Map(); // playlist -> position en ordre fixe
    this.sinceJingle = 0;
    this.lastError = null;
    this.restarts = [];
    this.silenceTimer = null;
    this.ffmpeg = null;
  }

  status() {
    const c = this.getConfig();
    const rule = activeRule();
    const playlistId = rule?.playlist_id ?? c.defaultPlaylist;
    this.fillUpcoming();
    return {
      ...c,
      state: this.state,
      ffmpeg: this.ffmpeg,
      lastError: this.lastError,
      current: this.current && {
        media: this.current.media,
        title: displayTitle(this.current.media),
        startedAt: this.current.startedAt,
        source: this.current.source,
      },
      queue: this.queue.map((id) => getMedia(id)).filter(Boolean),
      upcoming: this.upcoming.slice(0, 8).map((u) => ({ ...getMedia(u.id), source: u.source })).filter((m) => m.id),
      history: this.history.slice(0, 15),
      activeRule: rule,
      activePlaylist: playlistId ? getPlaylist(playlistId) && { id: playlistId, name: getPlaylist(playlistId).name } : null,
    };
  }

  changed() {
    this.emit('change');
  }

  // ---------- Choix des titres ----------

  pickFrom(playlistId) {
    const p = getPlaylist(playlistId);
    if (!p || !p.items.length) return null;
    const ids = p.items.map((m) => m.id);
    if (p.shuffle) {
      // aléatoire sans répétition avant d'avoir tout joué
      let left = (this.cycles.get(p.id) || []).filter((id) => ids.includes(id));
      if (!left.length) left = [...ids];
      const recent = new Set(this.history.slice(0, Math.min(3, ids.length - 1)).map((h) => h.id));
      const candidates = left.filter((id) => !recent.has(id));
      const pool = candidates.length ? candidates : left;
      const id = pool[Math.floor(Math.random() * pool.length)];
      this.cycles.set(p.id, left.filter((x) => x !== id));
      return id;
    }
    const pos = (this.cursors.get(p.id) || 0) % ids.length;
    this.cursors.set(p.id, pos + 1);
    return ids[pos];
  }

  /** Prépare les prochains titres (pour les afficher dans « À suivre »). */
  fillUpcoming() {
    const c = this.getConfig();
    let guard = 0;
    while (this.upcoming.length < 5 && guard++ < 20) {
      const jingles = c.jinglePlaylist ? playlistMediaIds(c.jinglePlaylist) : [];
      const jingleDue = jingles.length && c.jingleEvery > 0 && this.sinceJingle >= c.jingleEvery;
      if (jingleDue) {
        const id = this.pickFrom(c.jinglePlaylist);
        if (id) {
          this.upcoming.push({ id, source: 'jingle' });
          this.sinceJingle = 0;
          continue;
        }
      }
      const rule = activeRule();
      const playlistId = rule?.playlist_id ?? c.defaultPlaylist;
      const id = playlistId ? this.pickFrom(playlistId) : null;
      if (!id) break;
      this.upcoming.push({ id, source: rule ? 'grille' : 'playlist', playlistId });
      this.sinceJingle += 1;
    }
  }

  next() {
    if (this.queue.length) return { id: this.queue.shift(), source: 'demande' };
    // La grille a peut-être changé de playlist depuis la préparation : on repart de la playlist active
    const rule = activeRule();
    const playlistId = rule?.playlist_id ?? this.getConfig().defaultPlaylist;
    if (this.upcoming.length && this.upcoming[0].source !== 'jingle' && this.upcoming[0].playlistId !== playlistId) this.upcoming = [];
    this.fillUpcoming();
    return this.upcoming.shift() || null;
  }

  // ---------- Diffusion ----------

  async start() {
    const c = this.getConfig();
    if (this.encoder) return;
    this.ffmpeg = await ffmpegAvailable();
    if (!this.ffmpeg) {
      this.setError('ffmpeg est introuvable : installez-le (apt install ffmpeg) pour utiliser l\'AutoDJ');
      return;
    }
    const ice = this.getIcecast();
    const mount = ice.mounts.find((m) => m.name === c.mount);
    const user = mount?.password ? mount.username || 'source' : 'source';
    const password = mount?.password || ice.sourcePassword;
    const codec = c.format === 'aac'
      ? ['-c:a', 'aac', '-b:a', `${c.bitrate}k`, '-content_type', 'audio/aac', '-f', 'adts']
      : ['-c:a', 'libmp3lame', '-b:a', `${c.bitrate}k`, '-content_type', 'audio/mpeg', '-f', 'mp3'];
    const target = `icecast://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${ice.port}${c.mount}`;

    this.state = 'starting';
    this.lastError = null;
    this.changed();
    const enc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0',
      ...codec,
      '-ice_name', mount?.streamName || 'AutoDJ', '-ice_genre', mount?.genre || '', '-ice_description', mount?.description || '',
      '-ice_public', '0', target,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.encoder = enc;
    let stderr = '';
    enc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    enc.stdin.on('error', () => {});
    enc.on('exit', (code) => {
      if (this.encoder !== enc) return;
      this.encoder = null;
      this.killDecoder();
      this.stopSilence();
      const wanted = this.getConfig().enabled;
      if (this.state !== 'stopping' && wanted) {
        const why = stderr.trim().split('\n').pop() || `code ${code}`;
        this.setError(`L'encodeur s'est arrêté : ${why}`);
        this.scheduleRestart();
      } else {
        this.state = 'stopped';
        this.current = null;
        this.changed();
      }
    });

    this.state = 'playing';
    this.log('info', 'autodj', `AutoDJ démarré sur ${c.mount} (${c.format.toUpperCase()} ${c.bitrate} kbps)`);
    this.playNext();
  }

  scheduleRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 5 * 60_000);
    if (this.restarts.length >= 10) {
      this.log('error', 'autodj', 'AutoDJ : trop d\'échecs, redémarrage automatique suspendu');
      return;
    }
    this.restarts.push(now);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { if (this.getConfig().enabled) this.start(); }, 5000);
  }

  setError(message) {
    this.state = 'error';
    this.lastError = message;
    this.log('error', 'autodj', message);
    this.changed();
  }

  playNext() {
    if (!this.encoder) return;
    this.killDecoder();
    const item = this.next();
    const media = item && getMedia(item.id);
    if (!media || !fs.existsSync(mediaPath(media))) {
      if (item && media) this.log('warning', 'autodj', `Fichier introuvable : ${displayTitle(media)}`);
      if (item) return this.playNext(); // titre supprimé entre-temps : on passe au suivant
      this.current = null;
      this.startSilence();
      this.changed();
      return;
    }
    this.stopSilence();
    const dec = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mediaPath(media), '-vn',
      '-f', 's16le', '-ar', String(RATE), '-ac', '2', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.decoder = dec;
    // Envoi manuel (plutôt que pipe) pour compter les octets : on garde l'alignement des échantillons (4 octets)
    dec.written = 0;
    const enc = this.encoder;
    dec.stdout.on('data', (chunk) => {
      if (this.decoder !== dec || !this.encoder) return;
      dec.written += chunk.length;
      if (!enc.stdin.write(chunk)) {
        dec.stdout.pause();
        enc.stdin.once('drain', () => dec.stdout.resume());
      }
    });
    dec.on('exit', () => {
      if (this.decoder !== dec) return;
      this.decoder = null;
      this.align(dec);
      setImmediate(() => this.playNext());
    });

    this.current = { media, startedAt: Date.now(), source: item.source };
    this.history.unshift({ id: media.id, title: displayTitle(media), at: Date.now(), source: item.source });
    this.history.length = Math.min(this.history.length, 50);
    markPlayed(media.id);
    // Le titre change sur le flux (et donc dans l'historique des titres et les stats).
    // Au démarrage, la source n'est pas encore connectée à Icecast : on réessaie quelques fois.
    const title = displayTitle(media);
    const send = (attempt) => this.api.updateMetadata(this.getConfig().mount, title).catch(() => {
      if (attempt < 6 && this.current?.media.id === media.id) setTimeout(() => send(attempt + 1), 1500);
    });
    send(1);
    this.changed();
  }

  /** Envoie du silence quand il n'y a rien à jouer (Icecast couperait la source sinon). */
  startSilence() {
    if (this.silenceTimer || !this.encoder) return;
    const tick = () => {
      if (!this.encoder) return this.stopSilence();
      this.encoder.stdin.write(SILENCE);
      // Toutes les 5 s, on regarde si une playlist est devenue disponible
      if (++this.silenceTicks % 20 === 0) {
        this.fillUpcoming();
        if (this.queue.length || this.upcoming.length) this.playNext();
      }
    };
    this.silenceTicks = 0;
    this.silenceTimer = setInterval(tick, 250);
  }

  stopSilence() {
    clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  killDecoder() {
    if (!this.decoder) return;
    const d = this.decoder;
    this.decoder = null;
    d.stdout.removeAllListeners('data');
    d.kill();
    this.align(d);
  }

  /** Complète le dernier échantillon d'un titre coupé en plein milieu (sinon le reste du flux serait du bruit). */
  align(dec) {
    const pad = (4 - (dec.written % 4)) % 4;
    if (pad && this.encoder) this.encoder.stdin.write(Buffer.alloc(pad));
    dec.written += pad;
  }

  skip() {
    if (!this.encoder) throw Object.assign(new Error('L\'AutoDJ n\'est pas démarré'), { status: 400 });
    this.playNext();
  }

  enqueue(id) {
    if (!getMedia(id)) throw Object.assign(new Error('Titre introuvable'), { status: 404 });
    this.queue.push(Number(id));
    this.changed();
  }

  dequeue(index) {
    this.queue.splice(Number(index), 1);
    this.changed();
  }

  /** Oublie les titres préparés (après un changement de playlist ou de grille). */
  resetUpcoming() {
    this.upcoming = [];
    this.changed();
  }

  async stop() {
    clearTimeout(this.restartTimer);
    this.state = 'stopping';
    this.stopSilence();
    this.killDecoder();
    const enc = this.encoder;
    if (enc) {
      enc.stdin.end();
      enc.kill();
    }
    this.encoder = null;
    this.state = 'stopped';
    this.current = null;
    this.log('info', 'autodj', 'AutoDJ arrêté');
    this.changed();
  }
}
