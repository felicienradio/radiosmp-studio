// Points cue : analyse du niveau sonore d'un fichier pour placer automatiquement
// l'entrée (cue in), l'enchaînement avec le titre suivant (mix) et la sortie (cue out).
import { spawn } from 'node:child_process';

const RATE = 8000; // l'analyse se fait en mono 8 kHz : largement suffisant pour le niveau sonore
const WINDOW = 0.05; // une mesure toutes les 50 ms
const SAMPLES = RATE * WINDOW;

/**
 * Décode le fichier et renvoie l'enveloppe : niveau RMS (dB) et crête (0..1) par fenêtre de 50 ms.
 * @returns {Promise<{ step: number, rms: number[], peak: number[], duration: number }>}
 */
export function envelope(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const rms = [];
    const peak = [];
    let sum = 0;
    let max = 0;
    let n = 0;
    let total = 0;
    let rest = null;
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    ff.stdout.on('data', (chunk) => {
      if (rest) { chunk = Buffer.concat([rest, chunk]); rest = null; }
      const len = chunk.length - (chunk.length % 2);
      if (len < chunk.length) rest = chunk.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const v = chunk.readInt16LE(i) / 32768;
        sum += v * v;
        total++;
        const a = v < 0 ? -v : v;
        if (a > max) max = a;
        if (++n === SAMPLES) {
          rms.push(10 * Math.log10(sum / n + 1e-12));
          peak.push(max);
          sum = 0; max = 0; n = 0;
        }
      }
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (n) { rms.push(10 * Math.log10(sum / n + 1e-12)); peak.push(max); }
      if (code !== 0 && !rms.length) return reject(new Error(err.trim() || `ffmpeg code ${code}`));
      resolve({ step: WINDOW, rms, peak, duration: total / RATE });
    });
  });
}

/** Moyenne glissante (en puissance) sur `w` fenêtres. */
function smooth(db, w) {
  const p = db.map((x) => 10 ** (x / 10));
  const out = new Array(db.length);
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i];
    if (i >= w) acc -= p[i - w];
    out[i] = 10 * Math.log10(acc / Math.min(i + 1, w) + 1e-12);
  }
  return out;
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Calcule les points cue à partir de l'enveloppe.
 *  - cue in  : premier son audible (on saute le silence du début) ;
 *  - cue out : dernier son audible (on saute le silence de la fin) ;
 *  - mix     : moment où la fin du titre devient calme (fondu, résonance) : le titre suivant démarre là,
 *              par-dessus la fin de celui-ci. Si le titre se termine net, mix = cue out.
 */
export function detectCues({ rms, step }, { maxOverlap = 10 } = {}) {
  const total = rms.length * step;
  if (!rms.length) return { cueIn: 0, cueOut: null, mix: null };
  // Niveau moyen du titre (en puissance), sur les passages non silencieux
  const audible = rms.filter((x) => x > -60);
  const avg = audible.length ? 10 * Math.log10(audible.reduce((s, x) => s + 10 ** (x / 10), 0) / audible.length) : -60;
  const thrIn = Math.max(-50, avg - 30);
  const thrOut = Math.max(-52, avg - 32);

  let first = rms.findIndex((x) => x > thrIn);
  if (first < 0) return { cueIn: 0, cueOut: round(total), mix: round(total), level: round(avg) };
  let last = rms.length - 1;
  while (last > first && rms[last] <= thrOut) last--;

  const cueIn = Math.max(0, (first - 1) * step);
  const cueOut = Math.min(total, (last + 2) * step);

  // Fin « calme » : on lisse sur 1 s et on cherche, depuis la fin, le dernier moment où le titre est encore fort
  const sm = smooth(rms, Math.round(1 / step));
  const thrMix = avg - 10;
  let k = last;
  while (k > first && sm[k] < thrMix) k--;
  const limit = Math.min(maxOverlap, (cueOut - cueIn) * 0.15);
  let mix = Math.max(cueOut - limit, (k + 1) * step);
  if (cueOut - mix < 0.3) mix = cueOut;
  return { cueIn: round(cueIn), cueOut: round(cueOut), mix: round(mix), level: round(avg) };
}

/** Forme d'onde réduite pour l'éditeur (au plus `points` valeurs de crête entre 0 et 1). */
export function waveform({ peak, step }, points = 1200) {
  const per = Math.max(1, Math.ceil(peak.length / points));
  const out = [];
  for (let i = 0; i < peak.length; i += per) {
    let m = 0;
    for (let j = i; j < Math.min(peak.length, i + per); j++) if (peak[j] > m) m = peak[j];
    out.push(Math.round(m * 1000) / 1000);
  }
  return { step: step * per, peaks: out };
}
