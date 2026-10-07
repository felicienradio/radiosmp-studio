import fs from 'node:fs';
import { detectIcecastPaths } from '../settings.js';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const bool = (v) => (v ? '1' : '0');

function tag(name, value, indent) {
  if (value === undefined || value === null || value === '') return '';
  return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

/** Dossiers web/ et admin/ d'Icecast : ceux des réglages s'ils existent, sinon détection. */
export function icecastPaths(ice) {
  if (ice.webroot && ice.adminroot && fs.existsSync(ice.webroot) && fs.existsSync(ice.adminroot)) {
    return { webroot: ice.webroot, adminroot: ice.adminroot };
  }
  return detectIcecastPaths(ice.binary);
}

/** Icecast 2.5 a changé la syntaxe de certains blocs (relais, en-têtes HTTP). Debian fournit la 2.4. */
export const isLegacy = (version) => /^2\.[0-4]\./.test(version || '');

function mountXml(m, burst) {
  const i = '        ';
  let x = '    <mount type="normal">\n';
  x += tag('mount-name', m.name, i);
  if (m.password) {
    x += tag('username', m.username || 'source', i);
    x += tag('password', m.password, i);
  }
  if (m.maxListeners > 0) x += tag('max-listeners', m.maxListeners, i);
  // Buffer de démarrage propre au flux : 0 = faible latence, sinon quelques secondes d'avance envoyées d'un coup
  x += tag('burst-size', m.startMode === 'instant' ? burst : 0, i);
  if (m.fallbackMount) {
    x += tag('fallback-mount', m.fallbackMount, i);
    x += tag('fallback-override', bool(m.fallbackOverride), i);
    x += tag('fallback-when-full', bool(m.fallbackWhenFull), i);
  }
  // Métadonnées des encodeurs en UTF-8 (accents des titres)
  x += tag('charset', 'UTF-8', i);
  x += tag('hidden', bool(m.hidden), i);
  x += tag('public', bool(m.public), i);
  x += tag('stream-name', m.streamName, i);
  x += tag('stream-description', m.description, i);
  x += tag('stream-url', m.url, i);
  x += tag('genre', m.genre, i);
  x += '    </mount>\n';
  return x;
}

function relayXml(m, legacy) {
  if (legacy) {
    const u = new URL(m.relayUrl);
    return `    <relay>
        <server>${esc(u.hostname)}</server>
        <port>${esc(u.port || (u.protocol === 'https:' ? 443 : 80))}</port>
        <mount>${esc(u.pathname + u.search)}</mount>
        <local-mount>${esc(m.name)}</local-mount>
        <on-demand>${bool(m.onDemand)}</on-demand>
        <relay-shoutcast-metadata>1</relay-shoutcast-metadata>
    </relay>\n`;
  }
  return `    <relay>
        <local-mount>${esc(m.name)}</local-mount>
        <on-demand>${m.onDemand ? 'true' : 'false'}</on-demand>
        <upstream type="normal">
            <uri>${esc(m.relayUrl)}</uri>
            <relay-shoutcast-metadata>true</relay-shoutcast-metadata>
        </upstream>
    </relay>\n`;
}

function headersXml(legacy) {
  if (legacy) return '        <header name="Access-Control-Allow-Origin" value="*" />\n';
  return `        <header type="cors" name="Access-Control-Allow-Origin" />
        <header type="cors" name="Access-Control-Allow-Headers" />
        <header type="cors" name="Access-Control-Expose-Headers" />\n`;
}

/** Génère le fichier icecast.xml à partir des réglages du dashboard. */
export function buildConfig(ice, version = '') {
  const { webroot, adminroot } = icecastPaths(ice);
  const legacy = isLegacy(version);
  const l = ice.limits;
  const mounts = ice.mounts || [];
  return `<?xml version="1.0"?>
<!-- Fichier généré automatiquement par Flux. Ne pas modifier à la main :
     les changements seraient écrasés au prochain enregistrement depuis le dashboard. -->
<icecast>
    <location>${esc(ice.location)}</location>
    <admin>${esc(ice.adminEmail)}</admin>
    <hostname>${esc(ice.hostname)}</hostname>

    <limits>
        <clients>${Number(l.clients)}</clients>
        <sources>${Number(l.sources)}</sources>
        <queue-size>${Number(l.queueSize)}</queue-size>
        <client-timeout>${Number(l.clientTimeout)}</client-timeout>
        <header-timeout>${Number(l.headerTimeout)}</header-timeout>
        <source-timeout>${Number(l.sourceTimeout)}</source-timeout>
        <burst-size>${Number(l.burstSize)}</burst-size>
    </limits>

    <authentication>
        <source-password>${esc(ice.sourcePassword)}</source-password>
        <relay-password>${esc(ice.relayPassword)}</relay-password>
        <admin-user>${esc(ice.adminUser)}</admin-user>
        <admin-password>${esc(ice.adminPassword)}</admin-password>
    </authentication>

    <listen-socket>
        <port>${Number(ice.port)}</port>
    </listen-socket>

    <http-headers>
${headersXml(legacy)}    </http-headers>

${mounts.filter((m) => !m.relayUrl).map((m) => mountXml(m, Number(l.burstSize) || 196608)).join('\n')}
${mounts.filter((m) => m.relayUrl).map((m) => relayXml(m, legacy)).join('\n')}
    <paths>
        <logdir>./log</logdir>
        <webroot>${esc(webroot)}</webroot>
        <adminroot>${esc(adminroot)}</adminroot>
        <alias source="/" destination="/status.xsl"/>
    </paths>

    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>${legacy ? 3 : 'information'}</loglevel>
        <logsize>10000</logsize>
        <logarchive>1</logarchive>
    </logging>

    <security>
        <chroot>0</chroot>
    </security>
</icecast>
`;
}
