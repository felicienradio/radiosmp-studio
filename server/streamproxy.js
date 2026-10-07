// Relais des flux par le dashboard : permet de servir les flux en HTTPS derrière le même
// reverse proxy que le dashboard (Caddy, Nginx…), sans configuration TLS dans Icecast.
//
// Icecast ne voit alors que 127.0.0.1 : pour garder de vraies statistiques, chaque connexion relayée
// porte un marqueur dans son User-Agent, que le collecteur remplace par l'IP et le User-Agent réels.
import http from 'node:http';

const MARK = /\s*\[flux-relay:(\d+)\]$/;
const clients = new Map(); // id -> { ip, ua }
let nextId = 1;

/** Retrouve l'auditeur réel derrière une connexion relayée. */
export function resolveListener(ip, ua = '') {
  const m = ua.match(MARK);
  if (!m) return { ip, ua };
  const c = clients.get(Number(m[1]));
  return c ? { ip: c.ip, ua: c.ua } : { ip, ua: ua.replace(MARK, '') };
}

export const relayCount = () => clients.size;

/**
 * Relaie GET/HEAD /<mount> vers Icecast. Les en-têtes Icy (titres dans le flux) sont transmis.
 */
export function relayStream(req, res, { port, mount }) {
  const id = nextId++;
  const ua = String(req.headers['user-agent'] || '');
  clients.set(id, { ip: (req.ip || '').replace(/^::ffff:/, ''), ua });

  const headers = { 'User-Agent': `${ua} [flux-relay:${id}]`.trim() };
  for (const h of ['icy-metadata', 'range', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];

  const upstream = http.request({ host: '127.0.0.1', port, path: mount + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), method: req.method, headers });
  const cleanup = () => {
    clients.delete(id);
    upstream.destroy();
  };
  upstream.on('response', (up) => {
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (/^(content-type|icy-|ice-|cache-control|pragma|expires|access-control-)/i.test(k)) out[k] = v;
    }
    out['X-Accel-Buffering'] = 'no'; // Nginx : ne pas mettre le flux en tampon
    res.socket?.setNoDelay(true); // pas d'attente pour regrouper les paquets : l'audio part tout de suite
    res.writeHead(up.statusCode || 502, out);
    res.flushHeaders();
    up.pipe(res);
    up.on('end', cleanup);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).type('text/plain').send('Flux indisponible');
    cleanup();
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
  upstream.end();
}

/** Playlist M3U pointant vers l'adresse publique du flux. */
export function playlist(res, url, name) {
  res.type('audio/x-mpegurl').send(`#EXTM3U\n#EXTINF:-1,${name || url}\n${url}\n`);
}
