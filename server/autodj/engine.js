// Moteur d'une station AutoDJ.
//
// Un encodeur ffmpeg permanent lit de l'audio brut (PCM 44,1 kHz stéréo) sur son entrée, au rythme réel (-re),
// et le diffuse vers les flux de sortie de la station (un format et un débit par flux). Chaque titre est lu par une « platine » : un ffmpeg qui
// décode le fichier entre son cue in et son cue out. Le mélangeur additionne les platines actives avec leurs fondus :
// au point d'enchaînement (mix) d'un titre, le suivant démarre par-dessus sa fin. Sans rien à jouer, il envoie du
// silence pour garder la connexion avec Icecast.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { getMedia, mediaPath, markPlayed, displayTitle, cuesOf } from './library.js';
import { getPlaylist } from './playlists.js';
import { activeRule } from './stations.js';

const RATE = 44100;
const FRAME = 4; // 16 bits x 2 canaux
const BYTES_PER_SEC = RATE * FRAME;
const CHUNK = RATE / 20; // le mélangeur avance par blocs de 50 ms
const PREROLL = 4; // s : la platine suivante se prépare 4 s avant son départ
const SKIP_FADE = 1.5; // s : fondu de sortie quand on passe un titre

// Réglages communs à toutes les stations
export const AUTODJ_DEFAULTS = {
  autoCue: true, // points cue détectés automatiquement à l'import
};

const insertSource = (link) => (link.kind === 'jingle' ? 'jingle' : 'insert');

export function ffmpegAvailable() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Une platine : décode un titre (de son cue in à son cue out) et garde quelques secondes d'avance en mémoire. */
class Deck {
  constructor(media, item, { crossfade }) {
    const c = cuesOf(media);
    this.media = media;
    this.item = item;
    this.length = c.cueOut > c.cueIn ? (c.cueOut - c.cueIn) * RATE : Infinity; // en échantillons
    this.mixAt = crossfade && Number.isFinite(this.length) ? (c.mix - c.cueIn) * RATE : this.length;
    this.fadeIn = c.fadeIn * RATE;
    this.fadeOut = Number.isFinite(this.length) ? c.fadeOut * RATE : 0;
    this.pos = 0;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.forced = null; // fondu de sortie imposé (« Passer »)
    this.waiters = [];
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (c.cueIn > 0) args.push('-ss', c.cueIn.toFixed(3));
    args.push('-i', mediaPath(media), '-vn');
    if (Number.isFinite(this.length)) args.push('-t', (c.cueOut - c.cueIn).toFixed(3));
    args.push('-f', 's16le', '-ar', String(RATE), '-ac', '2', 'pipe:1');
    this.proc = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc.on('error', () => this.finish());
    this.proc.stdout.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered > 6 * BYTES_PER_SEC) this.proc.stdout.pause();
      this.wake();
    });
    this.proc.stdout.on('end', () => this.finish());
  }

  finish() {
    this.ended = true;
    this.wake();
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Attend d'avoir `bytes` octets en mémoire (ou la fin du fichier), au plus `ms` millisecondes. */
  ready(bytes, ms) {
    const deadline = Date.now() + ms;
    const loop = () => {
      if (this.ended || this.buffered >= bytes || Date.now() >= deadline) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, deadline - Date.now());
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      }).then(loop);
    };
    return loop();
  }

  read(bytes) {
    const parts = [];
    let need = bytes;
    while (need > 0 && this.chunks.length) {
      const c = this.chunks[0];
      if (c.length <= need) {
        parts.push(c);
        this.chunks.shift();
        need -= c.length;
      } else {
        parts.push(c.subarray(0, need));
        this.chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    const out = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.buffered -= out.length;
    if (this.buffered < 3 * BYTES_PER_SEC && !this.ended) this.proc.stdout.resume();
    // Fin de fichier : on ne garde que des échantillons complets
    if (out.length % FRAME) {
      this.chunks = [];
      this.buffered = 0;
      return out.subarray(0, out.length - (out.length % FRAME));
    }
    return out;
  }

  /** Volume (0..1) à l'échantillon f : fondus d'entrée et de sortie, et fondu imposé par « Passer ». */
  gain(f) {
    let g = 1;
    if (this.fadeIn && f < this.fadeIn) g *= f / this.fadeIn;
    if (this.fadeOut && f > this.length - this.fadeOut) g *= Math.max(0, (this.length - f) / this.fadeOut);
    if (this.forced) g *= Math.max(0, 1 - (f - this.forced.start) / this.forced.len);
    return g;
  }

  /** Moment (en échantillons) où le titre suivant doit démarrer. */
  get nextAt() {
    return Math.min(this.forced ? this.forced.start : this.mixAt, this.length);
  }

  get done() {
    return (this.ended && this.buffered < FRAME) || this.pos >= this.length
      || (!!this.forced && this.pos >= this.forced.start + this.forced.len);
  }

  kill() {
    this.proc.stdout.removeAllListeners('data');
    this.proc.kill();
    this.chunks = [];
    this.buffered = 0;
    this.finish();
  }
}

export class AutoDJ extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.stationId
   * @param {() => object} o.getStation  station (flux de sortie, playlists, enchaînements) lue en base
   * @param {() => object} o.getIcecast  réglages Icecast en vigueur (port, mots de passe, flux)
   * @param {object} o.api               client IcecastApi (mise à jour du titre)
   * @param {(level, type, msg) => void} o.log
   */
  constructor({ stationId, getStation, getIcecast, api, log }) {
    super();
    Object.assign(this, { stationId, getStation, getIcecast, api, log });
    this.state = 'stopped';
    this.encoder = null;
    this.decks = []; // platines en cours de lecture (plusieurs pendant un enchaînement)
    this.main = null; // platine du titre en cours
    this.nextDeck = null; // platine du titre suivant, préparée quelques secondes avant son départ
    this.current = null; // { media, startedAt, source, duration, mixAt }
    this.queue = []; // titres demandés à la main (« jouer ensuite »)
    this.upcoming = []; // titres déjà choisis automatiquement
    this.history = [];
    this.cycles = new Map(); // playlist -> titres pas encore joués dans le cycle aléatoire
    this.cursors = new Map(); // playlist -> position en ordre fixe
    this.counters = new Map(); // playlist « tous les N titres » -> titres joués depuis son dernier passage
    this.lastInsert = new Map(); // playlist « toutes les N minutes » -> heure de son dernier passage
    this.startedAt = Date.now();
    this.lastError = null;
    this.restarts = [];
    this.lastEmpty = 0; // dernière fois qu'il n'y avait rien à jouer
    this.ffmpeg = null;
  }

  /** Station lue en base (valeurs vides si elle vient d'être supprimée). */
  station() {
    return this.getStation() || { id: this.stationId, name: '', enabled: false, outputs: [], liveMount: '', crossfade: true, links: [] };
  }

  status() {
    const st = this.station();
    const rule = activeRule(st.id);
    this.fillUpcoming();
    const label = (u) => (u.playlistId ? getPlaylist(u.playlistId)?.name : null);
    return {
      ...st,
      mount: st.outputs[0]?.mount || null,
      state: this.state,
      ffmpeg: this.ffmpeg,
      lastError: this.lastError,
      current: this.current && {
        media: this.current.media,
        title: displayTitle(this.current.media),
        startedAt: this.current.startedAt,
        source: this.current.source,
        playlist: this.current.playlist,
        duration: this.current.duration,
        mixAt: this.current.mixAt,
      },
      queue: this.queue.map((id) => getMedia(id)).filter(Boolean),
      upcoming: [...(this.nextDeck ? [this.nextDeck.item] : []), ...this.upcoming].slice(0, 8)
        .map((u) => ({ ...getMedia(u.id), source: u.source, playlist: label(u) })).filter((m) => m.id),
      history: this.history.slice(0, 15),
      activeRule: rule,
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

  /** Tirage pondéré parmi les playlists en rotation (poids 1 à 10, comme AzuraCast). */
  pickRotation(links) {
    const total = links.reduce((n, l) => n + l.weight, 0);
    let r = Math.random() * total;
    for (const l of links) {
      r -= l.weight;
      if (r < 0) return l;
    }
    return links[links.length - 1] || null;
  }

  /**
   * Prépare les prochains titres (affichés dans « À suivre ») :
   * insertions « une fois tous les N titres », puis la playlist du créneau de la grille ou, hors créneau,
   * une playlist en rotation tirée selon son poids.
   */
  fillUpcoming() {
    const st = this.station();
    const links = st.links.filter((l) => l.count > 0);
    let guard = 0;
    while (this.upcoming.length < 5 && guard++ < 20) {
      const due = links.find((l) => l.mode === 'tracks' && (this.counters.get(l.playlist_id) || 0) >= l.every);
      if (due) {
        this.counters.set(due.playlist_id, 0);
        const id = this.pickFrom(due.playlist_id);
        if (id) {
          this.upcoming.push({ id, source: insertSource(due), playlistId: due.playlist_id });
          continue;
        }
      }
      const rule = activeRule(st.id);
      const playlistId = rule ? rule.playlist_id : this.pickRotation(links.filter((l) => l.mode === 'rotation'))?.playlist_id;
      const id = playlistId ? this.pickFrom(playlistId) : null;
      if (!id) break;
      this.upcoming.push({ id, source: rule ? 'grille' : 'playlist', playlistId, ruleId: rule?.id ?? null });
      for (const l of links) if (l.mode === 'tracks') this.counters.set(l.playlist_id, (this.counters.get(l.playlist_id) || 0) + 1);
    }
  }

  next() {
    if (this.queue.length) return { id: this.queue.shift(), source: 'demande' };
    const st = this.station();
    // Insertions « une fois toutes les N minutes » (flash, identifiant de la station…)
    const now = Date.now();
    for (const l of st.links) {
      if (l.mode !== 'minutes' || !l.count) continue;
      if (now - (this.lastInsert.get(l.playlist_id) ?? this.startedAt) < l.every * 60_000) continue;
      this.lastInsert.set(l.playlist_id, now);
      const id = this.pickFrom(l.playlist_id);
      if (id) return { id, source: insertSource(l), playlistId: l.playlist_id };
    }
    // La grille a peut-être changé de créneau depuis la préparation : on repart de la bonne playlist
    const rule = activeRule(st.id);
    const head = this.upcoming[0];
    if (head && ['playlist', 'grille'].includes(head.source) && (head.ruleId ?? null) !== (rule?.id ?? null)) this.upcoming = [];
    this.fillUpcoming();
    return this.upcoming.shift() || null;
  }

  // ---------- Diffusion ----------

  async start() {
    const st = this.station();
    if (this.encoder) return;
    if (!st.outputs.length) {
      this.setError('Aucun flux de sortie : ajoutez-en un dans les réglages de la station');
      return;
    }
    this.ffmpeg = await ffmpegAvailable();
    if (!this.ffmpeg) {
      this.setError('ffmpeg est introuvable : installez-le (apt install ffmpeg) pour utiliser l\'AutoDJ');
      return;
    }
    const ice = this.getIcecast();
    // Un seul encodeur, une sortie par flux (chacune avec son format, son débit et son mot de passe)
    const outputs = st.outputs.flatMap((o) => {
      const mount = ice.mounts.find((m) => m.name === o.mount);
      const user = mount?.password ? mount.username || 'source' : 'source';
      const password = mount?.password || ice.sourcePassword;
      const codec = o.format === 'aac'
        ? ['-c:a', 'aac', '-b:a', `${o.bitrate}k`, '-content_type', 'audio/aac', '-f', 'adts']
        : ['-c:a', 'libmp3lame', '-b:a', `${o.bitrate}k`, '-content_type', 'audio/mpeg', '-f', 'mp3'];
      return [...codec,
        '-ice_name', mount?.streamName || st.name, '-ice_genre', mount?.genre || '', '-ice_description', mount?.description || '',
        '-ice_public', '0', `icecast://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${ice.port}${o.mount}`];
    });

    this.state = 'starting';
    this.lastError = null;
    this.startedAt = Date.now();
    this.changed();
    const enc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0',
      ...outputs,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.encoder = enc;
    let stderr = '';
    enc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    enc.stdin.on('error', () => {});
    enc.on('exit', (code) => {
      if (this.encoder !== enc) return;
      this.encoder = null;
      this.killDecks();
      if (this.state !== 'stopping' && this.station().enabled) {
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
    this.log('info', 'autodj', `${st.name} : AutoDJ démarré sur ${st.outputs.map((o) => `${o.mount} (${o.format.toUpperCase()} ${o.bitrate} kbps)`).join(', ')}`);
    this.pump(enc).catch((err) => this.log('error', 'autodj', `Mélangeur : ${err.message}`));
  }

  scheduleRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 5 * 60_000);
    if (this.restarts.length >= 10) {
      this.log('error', 'autodj', `${this.station().name} : trop d'échecs, redémarrage automatique suspendu`);
      return;
    }
    this.restarts.push(now);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { if (this.station().enabled) this.start(); }, 5000);
  }

  setError(message) {
    this.state = 'error';
    this.lastError = message;
    this.log('error', 'autodj', `${this.station().name} : ${message}`);
    this.changed();
  }

  // ---------- Platines et mélangeur ----------

  /** Prépare la platine du titre suivant : le décodage commence, le titre n'est pas encore mélangé. */
  prepareNext() {
    for (let tries = 0; tries < 10; tries++) {
      const item = this.next();
      if (!item) break;
      const media = getMedia(item.id);
      if (!media) continue; // supprimé entre-temps
      if (!fs.existsSync(mediaPath(media))) {
        this.log('warning', 'autodj', `Fichier introuvable : ${displayTitle(media)}`);
        continue;
      }
      this.nextDeck = new Deck(media, item, { crossfade: this.station().crossfade !== false });
      return this.nextDeck;
    }
    this.lastEmpty = Date.now();
    return null;
  }

  /** Le titre préparé démarre : il devient le titre en cours. */
  startDeck(d) {
    this.nextDeck = null;
    this.decks.push(d);
    this.main = d;
    const { media, item } = d;
    const sec = (x) => (Number.isFinite(x) ? Math.round((x / RATE) * 100) / 100 : media.duration || 0);
    this.current = {
      media, startedAt: Date.now(), source: item.source, playlist: item.playlistId ? getPlaylist(item.playlistId)?.name : null,
      duration: sec(d.length), mixAt: sec(d.mixAt),
    };
    this.history.unshift({ id: media.id, title: displayTitle(media), at: Date.now(), source: item.source });
    this.history.length = Math.min(this.history.length, 50);
    markPlayed(media.id);
    // Le titre change sur le flux (et donc dans l'historique des titres et les stats).
    // Au démarrage, la source n'est pas encore connectée à Icecast : on réessaie quelques fois.
    const title = displayTitle(media);
    for (const o of this.station().outputs) {
      const send = (attempt) => this.api.updateMetadata(o.mount, title).catch(() => {
        if (attempt < 6 && this.main === d) setTimeout(() => send(attempt + 1), 1500);
      });
      send(1);
    }
    this.changed();
  }

  /** Démarre le titre suivant quand le titre en cours atteint son point d'enchaînement (ou se termine). */
  transitions() {
    const canLook = Date.now() - this.lastEmpty > 5000; // rien à jouer : on regarde à nouveau toutes les 5 s
    const main = this.main;
    if (!main || main.done) {
      this.main = null;
      if (!this.nextDeck && canLook) this.prepareNext();
      if (this.nextDeck) this.startDeck(this.nextDeck);
      else if (this.current) {
        this.current = null;
        this.changed();
      }
      return;
    }
    if (!this.nextDeck && canLook && main.pos >= main.nextAt - PREROLL * RATE) this.prepareNext();
    if (this.nextDeck && main.pos >= main.nextAt) this.startDeck(this.nextDeck);
  }

  /** Boucle du mélangeur : 50 ms d'audio à la fois, au rythme de l'encodeur (qui lit en temps réel). */
  async pump(enc) {
    const bytes = CHUNK * FRAME;
    const acc = new Float32Array(CHUNK * 2);
    while (this.encoder === enc) {
      this.transitions();
      const active = this.decks;
      // Une platine qui vient de démarrer a parfois besoin de quelques millisecondes pour décoder
      await Promise.all(active.map((d) => d.ready(bytes, 1500)));
      if (this.encoder !== enc) break;
      acc.fill(0);
      for (const d of active) {
        const data = d.read(bytes);
        const frames = data.length / FRAME;
        for (let f = 0; f < frames; f++) {
          const g = d.gain(d.pos + f);
          if (g === 0) continue;
          acc[f * 2] += data.readInt16LE(f * 4) * g;
          acc[f * 2 + 1] += data.readInt16LE(f * 4 + 2) * g;
        }
        d.pos += frames;
      }
      const out = Buffer.allocUnsafe(bytes);
      for (let i = 0; i < acc.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc[i]))), i * 2);
      for (const d of active) if (d.done) d.kill();
      this.decks = this.decks.filter((d) => !d.done);
      if (!enc.stdin.write(out)) {
        await new Promise((resolve) => {
          const done = () => { enc.stdin.off('drain', done); enc.off('exit', done); resolve(); };
          enc.stdin.once('drain', done);
          enc.once('exit', done);
        });
      }
    }
  }

  killDecks() {
    for (const d of this.decks) d.kill();
    this.nextDeck?.kill();
    this.decks = [];
    this.main = null;
    this.nextDeck = null;
  }

  /** Annule le titre préparé (il reprend sa place dans la file). */
  unprepare() {
    const d = this.nextDeck;
    if (!d) return;
    d.kill();
    this.nextDeck = null;
    if (d.item.source === 'demande') this.queue.unshift(d.item.id);
    else this.upcoming.unshift(d.item);
  }

  /** Passe au titre suivant : fondu rapide du titre en cours, le suivant démarre aussitôt. */
  skip() {
    if (!this.encoder) throw Object.assign(new Error('L\'AutoDJ n\'est pas démarré'), { status: 400 });
    const m = this.main;
    if (m && !m.forced) m.forced = { start: m.pos, len: SKIP_FADE * RATE };
    this.lastEmpty = 0;
    if (!this.nextDeck) this.prepareNext();
    this.changed();
  }

  enqueue(id) {
    if (!getMedia(id)) throw Object.assign(new Error('Titre introuvable'), { status: 404 });
    this.queue.push(Number(id));
    this.lastEmpty = 0;
    // Une demande passe avant le titre automatique déjà préparé
    if (this.nextDeck && this.nextDeck.item.source !== 'demande') this.unprepare();
    this.changed();
  }

  dequeue(index) {
    this.queue.splice(Number(index), 1);
    this.changed();
  }

  /** Oublie les titres préparés (après un changement de playlist, de grille ou de points cue). */
  resetUpcoming() {
    if (this.nextDeck && this.nextDeck.item.source !== 'demande') {
      this.nextDeck.kill();
      this.nextDeck = null;
    } else if (this.nextDeck) {
      this.unprepare();
    }
    this.upcoming = [];
    this.lastEmpty = 0;
    this.changed();
  }

  async stop() {
    clearTimeout(this.restartTimer);
    this.state = 'stopping';
    this.killDecks();
    const enc = this.encoder;
    this.encoder = null;
    if (enc) {
      enc.stdin.end();
      enc.kill();
    }
    this.state = 'stopped';
    this.current = null;
    this.log('info', 'autodj', `${this.station().name} : AutoDJ arrêté`);
    this.changed();
  }
}
