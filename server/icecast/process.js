import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from '../settings.js';
import { buildConfig } from './config.js';

export const ICECAST_DIR = path.join(DATA_DIR, 'icecast');
export const LOG_DIR = path.join(ICECAST_DIR, 'log');
const CONFIG_FILE = path.join(ICECAST_DIR, 'icecast.xml');
const PID_FILE = path.join(ICECAST_DIR, 'icecast.pid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processName(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 0);
        resolve(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
      } catch {
        resolve(null);
      }
      return;
    }
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      resolve(m && Number(m[2]) === pid ? m[1] : null);
    });
  });
}

async function isIcecastPid(pid) {
  const name = await processName(pid);
  return !!name && /icecast/i.test(name);
}

/**
 * Pilote le processus Icecast : génération de la config, démarrage détaché
 * (Icecast continue de tourner si le dashboard redémarre), arrêt, surveillance.
 */
export class IcecastProcess extends EventEmitter {
  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
    this.state = 'stopped';
    this.pid = null;
    this.startedAt = null;
    this.lastError = null;
    this.appliedConfig = null;
    this.applied = null; // réglages avec lesquels Icecast tourne réellement
    this.restarts = [];
    this.busy = null;
  }

  get configFile() {
    return CONFIG_FILE;
  }

  status() {
    const ice = this.getConfig();
    return {
      managed: ice.managed,
      state: ice.managed ? this.state : 'external',
      pid: this.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      binary: ice.binary,
      binaryFound: fs.existsSync(ice.binary),
      configFile: CONFIG_FILE,
      pendingRestart: ice.managed && this.state === 'running' && this.appliedConfig !== null
        && this.appliedConfig !== buildConfig(ice),
    };
  }

  setState(state, error = null) {
    this.state = state;
    if (error) this.lastError = error;
    this.emit('state', this.status());
  }

  writeConfig() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const xml = buildConfig(this.getConfig());
    fs.writeFileSync(CONFIG_FILE, xml);
    return xml;
  }

  async reachable(timeout = 1000) {
    try {
      await fetch(`http://127.0.0.1:${this.getConfig().port}/status-json.xsl`, { signal: AbortSignal.timeout(timeout) });
      return true;
    } catch {
      return false;
    }
  }

  /** Au démarrage du dashboard : reprend un Icecast déjà lancé ou le démarre. */
  async init() {
    const ice = this.getConfig();
    if (!ice.managed) return;
    const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8') : 0);
    if (pid && await isIcecastPid(pid)) {
      this.pid = pid;
      this.startedAt = fs.statSync(PID_FILE).mtimeMs;
      this.appliedConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
      this.applied = structuredClone(ice);
      this.setState('running');
      this.log('info', 'server', `Icecast déjà en cours d'exécution (PID ${pid}), reprise du contrôle`);
      return;
    }
    if (ice.autoStart) await this.start().catch(() => {});
  }

  run(fn) {
    if (this.busy) return this.busy;
    this.busy = fn().finally(() => { this.busy = null; });
    return this.busy;
  }

  start() {
    return this.run(() => this.#start());
  }

  stop() {
    return this.run(() => this.#stop());
  }

  restart() {
    return this.run(async () => {
      await this.#stop();
      await this.#start();
    });
  }

  async #start() {
    const ice = this.getConfig();
    if (!ice.managed) throw new Error('Icecast est en mode externe : il n\'est pas piloté par le dashboard');
    if (this.state === 'running') return;
    if (!fs.existsSync(ice.binary)) {
      this.setState('stopped', `Exécutable Icecast introuvable : ${ice.binary}`);
      throw new Error(this.lastError);
    }
    if (await this.reachable()) {
      this.setState('stopped', `Le port ${ice.port} est déjà utilisé (un autre Icecast tourne peut-être déjà)`);
      throw new Error(this.lastError);
    }

    this.setState('starting');
    this.lastError = null;
    const xml = this.writeConfig();
    const errorLog = path.join(LOG_DIR, 'error.log');
    const consoleLog = path.join(LOG_DIR, 'console.log');
    const offsets = [errorLog, consoleLog].map((f) => (fs.existsSync(f) ? fs.statSync(f).size : 0));
    const out = fs.openSync(path.join(LOG_DIR, 'console.log'), 'a');
    const child = spawn(ice.binary, ['-c', 'icecast.xml'], {
      cwd: ICECAST_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);

    const exited = new Promise((resolve) => {
      child.once('error', (err) => resolve(err.message));
      child.once('exit', (code) => resolve(`code ${code}`));
    });
    child.unref();

    // On attend que le port réponde
    for (let i = 0; i < 40; i++) {
      const done = await Promise.race([exited, sleep(250).then(() => null)]);
      if (done !== null) {
        const output = `${readFrom(errorLog, offsets[0])}\n${readFrom(consoleLog, offsets[1])}`;
        this.setState('stopped', `Icecast s'est arrêté au démarrage (${done}). ${lastErrorLine(output)}`.trim());
        this.log('error', 'server', this.lastError);
        throw new Error(this.lastError);
      }
      if (await this.reachable(500)) break;
    }

    this.pid = child.pid;
    this.startedAt = Date.now();
    this.appliedConfig = xml;
    this.applied = structuredClone(ice);
    fs.writeFileSync(PID_FILE, String(child.pid));
    this.setState('running');
    this.log('info', 'server', `Icecast démarré (PID ${child.pid}, port ${ice.port})`);

    exited.then((reason) => {
      if (this.pid !== child.pid) return;
      this.#onExit(reason);
    });
  }

  #onExit(reason) {
    const expected = this.state === 'stopping';
    this.pid = null;
    this.startedAt = null;
    try { fs.unlinkSync(PID_FILE); } catch {}
    if (expected) return;
    this.setState('crashed', `Icecast s'est arrêté de façon inattendue (${reason})`);
    this.log('error', 'server', this.lastError);
    this.maybeAutoRestart();
  }

  /** Appelé par le collecteur quand un Icecast "repris" ne répond plus. */
  async checkAlive() {
    if (this.state !== 'running' || !this.pid || this.busy) return;
    if (await isIcecastPid(this.pid)) return;
    this.#onExit('processus disparu');
  }

  maybeAutoRestart() {
    const ice = this.getConfig();
    if (!ice.autoRestart) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 5 * 60_000);
    if (this.restarts.length >= 5) {
      this.log('error', 'server', 'Trop de plantages en 5 minutes : redémarrage automatique suspendu');
      return;
    }
    this.restarts.push(now);
    setTimeout(() => {
      this.log('warning', 'server', 'Redémarrage automatique d\'Icecast');
      this.start().catch(() => {});
    }, 3000);
  }

  async #stop() {
    if (!this.pid) {
      this.setState('stopped');
      return;
    }
    const pid = this.pid;
    this.setState('stopping');
    try { process.kill(pid); } catch {}
    for (let i = 0; i < 20 && await isIcecastPid(pid); i++) await sleep(250);
    if (await isIcecastPid(pid)) {
      if (process.platform === 'win32') {
        await new Promise((r) => execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, r));
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    this.pid = null;
    this.startedAt = null;
    try { fs.unlinkSync(PID_FILE); } catch {}
    this.setState('stopped');
    this.log('info', 'server', 'Icecast arrêté');
  }
}

export function readTail(file, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function readFrom(file, offset) {
  try {
    return readTail(file, Math.min(fs.statSync(file).size - offset, 64 * 1024));
  } catch {
    return '';
  }
}

function lastErrorLine(text) {
  const lines = text.trim().split(/\r?\n/)
    .filter((l) => /EROR|error|FATAL/i.test(l) && !/PRNG/.test(l));
  return lines.at(-1)?.replace(/^\[[^\]]+\]\s*/, '') || '';
}
