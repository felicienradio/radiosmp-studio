// Éditeur de points cue : forme d'onde, repères à glisser (entrée, enchaînement, sortie), fondus et pré-écoute.
import { api, html, icon, modal, run, toast } from './lib.js';
import { player } from './player.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const MARKERS = [
  ['cueIn', 'IN', '--ok', 'Cue in'],
  ['mix', 'MIX', '--warn', 'Enchaînement'],
  ['cueOut', 'OUT', '--danger', 'Cue out'],
];

export function fmtCue(t) {
  if (t === null || t === undefined || !Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** Points cue effectifs d'un titre (mêmes règles que le serveur). */
export function cuesOf(m) {
  const duration = m.duration || 0;
  const cueIn = Math.max(0, m.cue_in || 0);
  const cueOut = m.cue_out && m.cue_out > cueIn ? Math.min(m.cue_out, duration || m.cue_out) : duration;
  const mix = m.cue_mix != null && m.cue_mix >= cueIn && m.cue_mix <= cueOut ? m.cue_mix : cueOut;
  return { cueIn, mix, cueOut, fadeIn: m.fade_in || 0, fadeOut: m.fade_out || 0 };
}

/** Petit résumé pour les listes : « auto · 0:00.4 → 3:41.2 · enchaînement 6,5 s ». */
export function cueSummary(m) {
  if (!m.analyzed_at && m.cue_auto) return html`<span class="dim small">analyse…</span>`;
  const c = cuesOf(m);
  const overlap = c.cueOut - c.mix;
  return html`<span class="small nowrap" title="Cue in ${fmtCue(c.cueIn)} · enchaînement ${fmtCue(c.mix)} · cue out ${fmtCue(c.cueOut)}">
    <span class="badge ${m.cue_auto ? '' : 'accent'}">${m.cue_auto ? 'auto' : 'manuel'}</span>
    <span class="dim">${overlap >= 0.1 ? `↘ ${overlap.toFixed(1).replace('.', ',')} s` : 'enchaîné'}</span></span>`;
}

export function openCueEditor(media) {
  return new Promise((resolve) => {
    let result = null;
    let wave = null;
    const v = cuesOf(media);
    let autoFilled = false; // valeurs = détection automatique non retouchée
    let drag = null;
    let stopAt = null;
    let raf = 0;
    const title = media.artist ? `${media.artist} - ${media.title}` : media.title || media.original_name;

    const { dlg, close } = modal({
      title: `Points cue : ${title}`,
      wide: true,
      body: html`
        <div class="cue-wave" id="cw"><canvas></canvas><div class="cue-loading" id="cl">Analyse du fichier…</div></div>
        <div class="row between small mt" style="gap:8px">
          <div class="row cue-legend" style="gap:14px">${MARKERS.map(([, , color, label]) => html`<span class="nowrap"><span class="dot" style="background:var(${color})"></span> ${label}</span>`)}
            <span class="nowrap"><span class="dot" style="background:var(--accent)"></span> Fondus</span></div>
          <span class="dim">Glissez les repères, cliquez sur l'onde pour écouter à cet endroit.</span>
        </div>
        <div class="row mt" style="gap:8px">
          <button class="btn sm" id="cp" title="Lecture / pause">${icon('play')}</button>
          <span class="mono small" id="ct">0:00.00</span><span class="dim small">/ ${fmtCue(media.duration)}</span>
          <div class="spacer"></div>
          <button class="btn sm" data-preview="in">${icon('play')} Écouter l'entrée</button>
          <button class="btn sm" data-preview="mix">${icon('play')} Écouter l'enchaînement</button>
        </div>
        <form id="cf" class="cue-grid mt">
          ${MARKERS.map(([k, , color, label]) => html`<label class="field"><span><span class="dot" style="background:var(${color})"></span> ${label}</span>
            <div class="input-group"><input type="number" name="${k}" step="0.01" min="0">
              <button type="button" class="btn icon" data-here="${k}" title="Placer à la position de lecture">${icon('down')}</button></div>
            <span class="hint mono" data-fmt="${k}"></span></label>`)}
          <label class="field">Fondu d'entrée (s)<input type="number" name="fadeIn" step="0.1" min="0" max="30"></label>
          <label class="field">Fondu de sortie (s)<input type="number" name="fadeOut" step="0.1" min="0" max="30"></label>
        </form>
        <p class="dim small" id="cx" style="margin:10px 0 0"></p>
        <audio id="ca" preload="auto" src="/api/autodj/media/${media.id}/audio"></audio>`,
      footer: html`<button class="btn" id="cauto" style="margin-right:auto">${icon('wave')} Détection automatique</button>
        <button class="btn" data-close>Annuler</button><button class="btn primary" id="csave">Enregistrer</button>`,
    });

    const canvas = dlg.querySelector('canvas');
    const audio = dlg.querySelector('#ca');
    const form = dlg.querySelector('#cf');
    const dur = () => wave?.duration || media.duration || 1;

    function syncInputs() {
      for (const k of ['cueIn', 'mix', 'cueOut', 'fadeIn', 'fadeOut']) {
        const inp = form.elements[k];
        if (document.activeElement !== inp) inp.value = Number(v[k]).toFixed(k.startsWith('fade') ? 1 : 2);
      }
      for (const [k] of MARKERS) dlg.querySelector(`[data-fmt="${k}"]`).textContent = fmtCue(v[k]);
      const overlap = v.cueOut - v.mix;
      dlg.querySelector('#cx').textContent = `Durée diffusée : ${fmtCue(v.cueOut - v.cueIn)}. `
        + (overlap >= 0.1
          ? `Le titre suivant démarre ${overlap.toFixed(1).replace('.', ',')} s avant la fin, par-dessus celle-ci.`
          : 'Le titre suivant démarre juste après le cue out, sans chevauchement.')
        + (autoFilled ? ' (valeurs de la détection automatique)' : '');
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const X = (t) => (t / dur()) * w;
      const mid = h / 2 + 8;
      const amp = h / 2 - 14;
      // Zone de chevauchement (le titre suivant joue déjà)
      g.fillStyle = css('--warn-soft');
      g.fillRect(X(v.mix), 0, X(v.cueOut) - X(v.mix), h);
      if (wave) {
        const peaks = wave.peaks;
        const bw = w / peaks.length;
        const maxPeak = Math.max(0.05, ...peaks); // onde agrandie à la hauteur disponible
        for (let i = 0; i < peaks.length; i++) {
          const t = i * wave.step;
          const inside = t >= v.cueIn && t <= v.cueOut;
          g.fillStyle = inside ? css('--accent') : css('--text-3');
          g.globalAlpha = inside ? 0.9 : 0.35;
          const y = Math.max(0.5, (peaks[i] / maxPeak) * amp);
          g.fillRect(i * bw, mid - y, Math.max(1, bw - 0.3), y * 2);
        }
        g.globalAlpha = 1;
      }
      // Parties coupées
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, 0, X(v.cueIn), h);
      g.fillRect(X(v.cueOut), 0, w - X(v.cueOut), h);
      // Enveloppe de volume (fondus)
      g.strokeStyle = css('--text');
      g.lineWidth = 1.5;
      g.globalAlpha = 0.8;
      g.beginPath();
      const top = 16;
      const bottom = h - 2;
      g.moveTo(X(v.cueIn), v.fadeIn ? bottom : top);
      g.lineTo(X(Math.min(v.cueOut, v.cueIn + v.fadeIn)), top);
      g.lineTo(X(Math.max(v.cueIn, v.cueOut - v.fadeOut)), top);
      g.lineTo(X(v.cueOut), v.fadeOut ? bottom : top);
      g.stroke();
      g.globalAlpha = 1;
      // Repères
      g.font = `600 10px ${css('--font') || 'sans-serif'}`;
      for (const [k, label, color] of MARKERS) {
        const x = Math.round(X(v[k])) + 0.5;
        g.strokeStyle = g.fillStyle = css(color);
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        const tw = g.measureText(label).width + 8;
        const lx = k === 'cueOut' ? x - tw : k === 'mix' ? x - tw / 2 : x;
        g.fillRect(lx, 0, tw, 14);
        g.fillStyle = '#fff';
        g.fillText(label, lx + 4, 10.5);
      }
      // Tête de lecture
      const px = Math.round(X(audio.currentTime)) + 0.5;
      g.strokeStyle = css('--text');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, 14); g.lineTo(px, h); g.stroke();
      dlg.querySelector('#ct').textContent = fmtCue(audio.currentTime);
    }

    const timeAt = (e) => {
      const r = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(dur(), ((e.clientX - r.left) / r.width) * dur()));
    };
    const nearMarker = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      let best = null;
      for (const [k] of MARKERS) {
        const d = Math.abs((v[k] / dur()) * r.width - x);
        if (d < 9 && (!best || d < best.d)) best = { k, d };
      }
      return best?.k || null;
    };

    function setValue(k, t) {
      t = Math.round(t * 100) / 100;
      if (k === 'cueIn') {
        v.cueIn = Math.max(0, Math.min(t, v.cueOut - 0.5));
        v.mix = Math.max(v.mix, v.cueIn);
      } else if (k === 'cueOut') {
        v.cueOut = Math.min(dur(), Math.max(t, v.cueIn + 0.5));
        v.mix = Math.min(v.mix, v.cueOut);
      } else if (k === 'mix') v.mix = Math.max(v.cueIn, Math.min(t, v.cueOut));
      else v[k] = Math.max(0, Math.min(30, t));
      autoFilled = false;
      syncInputs();
      draw();
    }

    canvas.addEventListener('pointerdown', (e) => {
      const k = nearMarker(e);
      if (k) {
        drag = k;
        canvas.setPointerCapture(e.pointerId);
      } else {
        audio.currentTime = timeAt(e);
        stopAt = null;
        draw();
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) setValue(drag, timeAt(e));
      else canvas.style.cursor = nearMarker(e) ? 'ew-resize' : 'pointer';
    });
    canvas.addEventListener('pointerup', () => { drag = null; });

    form.addEventListener('input', (e) => {
      const k = e.target.name;
      const n = Number(e.target.value);
      if (k && Number.isFinite(n)) setValue(k, n);
    });

    const playBtn = dlg.querySelector('#cp');
    const loop = () => {
      if (stopAt !== null && audio.currentTime >= stopAt) {
        audio.pause();
        stopAt = null;
      }
      draw();
      if (!audio.paused) raf = requestAnimationFrame(loop);
    };
    audio.addEventListener('play', () => {
      if (player.url) player.toggle(player.url); // coupe le lecteur du dashboard
      playBtn.innerHTML = String(icon('pause'));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    });
    audio.addEventListener('pause', () => { playBtn.innerHTML = String(icon('play')); draw(); });
    playBtn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));

    dlg.addEventListener('click', async (e) => {
      const pv = e.target.closest('[data-preview]');
      if (pv) {
        if (pv.dataset.preview === 'in') {
          audio.currentTime = v.cueIn;
          stopAt = Math.min(v.cueOut, v.cueIn + 12);
        } else {
          audio.currentTime = Math.max(v.cueIn, v.mix - 5);
          stopAt = v.cueOut;
        }
        audio.play();
      }
      const here = e.target.closest('[data-here]');
      if (here) setValue(here.dataset.here, audio.currentTime);
    });

    dlg.querySelector('#cauto').addEventListener('click', () => {
      if (!wave) return;
      const s = wave.suggested;
      Object.assign(v, { cueIn: s.cueIn, mix: s.mix ?? s.cueOut, cueOut: s.cueOut ?? dur(), fadeIn: 0, fadeOut: 0 });
      autoFilled = true;
      syncInputs();
      draw();
      toast('Points cue détectés : vérifiez puis enregistrez');
    });

    dlg.querySelector('#csave').addEventListener('click', async (e) => {
      // Détection automatique non retouchée : le titre reste en mode « auto »
      const req = autoFilled
        ? () => api(`/autodj/media/${media.id}/autocue`, { method: 'POST' })
        : () => api(`/autodj/media/${media.id}/cues`, { method: 'PUT', body: v });
      result = await run(e.currentTarget, req, 'Points cue enregistrés').catch(() => null);
      if (result) close();
    });

    const ro = new ResizeObserver(() => { canvas.width = 0; draw(); });
    ro.observe(canvas);
    dlg.addEventListener('close', () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      audio.pause();
      audio.removeAttribute('src');
      resolve(result);
    });

    syncInputs();
    draw();
    api(`/autodj/media/${media.id}/waveform`).then((w) => {
      wave = w;
      dlg.querySelector('#cl').remove();
      // Fichier sans durée connue : on prend celle de l'analyse
      if (!media.duration && w.duration) {
        v.cueOut = v.cueOut || w.duration;
        v.mix = v.mix || w.duration;
        syncInputs();
      }
      draw();
    }).catch((err) => { dlg.querySelector('#cl').textContent = `Analyse impossible : ${err.message}`; });
  });
}
