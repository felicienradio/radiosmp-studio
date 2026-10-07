import path from 'node:path';

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

/** Racine d'installation d'Icecast (dossier qui contient web/ et admin/). */
export function icecastHome(binary) {
  const dir = path.dirname(binary);
  return path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
}

function mountXml(m) {
  const i = '        ';
  let x = '    <mount type="normal">\n';
  x += tag('mount-name', m.name, i);
  if (m.password) {
    x += tag('username', m.username || 'source', i);
    x += tag('password', m.password, i);
  }
  if (m.maxListeners > 0) x += tag('max-listeners', m.maxListeners, i);
  if (m.fallbackMount) {
    x += tag('fallback-mount', m.fallbackMount, i);
    x += tag('fallback-override', bool(m.fallbackOverride), i);
    x += tag('fallback-when-full', bool(m.fallbackWhenFull), i);
  }
  x += tag('hidden', bool(m.hidden), i);
  x += tag('public', bool(m.public), i);
  x += tag('stream-name', m.streamName, i);
  x += tag('stream-description', m.description, i);
  x += tag('stream-url', m.url, i);
  x += tag('genre', m.genre, i);
  x += '    </mount>\n';
  return x;
}

function relayXml(m) {
  return `    <relay>
        <local-mount>${esc(m.name)}</local-mount>
        <on-demand>${m.onDemand ? 'true' : 'false'}</on-demand>
        <upstream type="normal">
            <uri>${esc(m.relayUrl)}</uri>
            <relay-shoutcast-metadata>true</relay-shoutcast-metadata>
        </upstream>
    </relay>\n`;
}

/** Génère le fichier icecast.xml à partir des réglages du dashboard. */
export function buildConfig(ice) {
  const home = icecastHome(ice.binary);
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
        <header type="cors" name="Access-Control-Allow-Origin" />
        <header type="cors" name="Access-Control-Allow-Headers" />
        <header type="cors" name="Access-Control-Expose-Headers" />
    </http-headers>

${mounts.filter((m) => !m.relayUrl).map(mountXml).join('\n')}
${mounts.filter((m) => m.relayUrl).map(relayXml).join('\n')}
    <paths>
        <logdir>./log</logdir>
        <webroot>${esc(path.join(home, 'web'))}</webroot>
        <adminroot>${esc(path.join(home, 'admin'))}</adminroot>
        <alias source="/" destination="/status.xsl"/>
    </paths>

    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>information</loglevel>
        <logsize>10000</logsize>
        <logarchive>1</logarchive>
    </logging>
</icecast>
`;
}
