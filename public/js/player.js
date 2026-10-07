import { icon, toast, $$ } from './lib.js';

/** Lecteur audio intégré : un seul flux écouté à la fois. */
export const player = {
  audio: new Audio(),
  url: null,
  toggle(url) {
    if (this.url === url) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.url = null;
    } else {
      this.url = url;
      // paramètre anti-cache pour toujours écouter le direct
      this.audio.src = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
      this.audio.play().catch((err) => {
        toast(`Lecture impossible : ${err.message}`, 'error');
        this.url = null;
        this.refresh();
      });
    }
    this.refresh();
  },
  refresh() {
    $$('[data-play]').forEach((b) => {
      b.innerHTML = String(playIcon(b.dataset.play));
      b.title = b.dataset.play === this.url ? 'Arrêter l\'écoute' : 'Écouter';
    });
  },
};

export const playIcon = (url) => icon(url && url === player.url ? 'stop' : 'play');

// Adresses des flux, mises à jour par app.js à chaque rafraîchissement
export const links = { publicBase: '', managed: true, port: 8000 };

/** Lien public d'un flux (celui à donner aux auditeurs). */
export const publicUrl = (mount) => `${links.publicBase}${mount}`;

/** Lien d'écoute depuis ce navigateur : relayé par le dashboard (même origine, donc HTTPS si le dashboard l'est). */
export const playUrl = (mount) => (links.relay ? `${location.origin}${mount}` : publicUrl(mount));

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (b && !b.disabled) player.toggle(b.dataset.play);
});
