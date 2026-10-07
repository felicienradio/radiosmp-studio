import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  htmlEntities: true, // Icecast encode les accents en entités numériques (&#xE9;)
  isArray: (name) => ['source', 'listener'].includes(name),
});

export class IcecastError extends Error {}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Client de l'interface d'administration HTTP d'Icecast. */
export class IcecastApi {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  get base() {
    const ice = this.getConfig();
    return ice.managed ? `http://127.0.0.1:${ice.port}` : ice.apiUrl.replace(/\/+$/, '');
  }

  async request(pathname, params = {}, { method = 'GET', timeout = 4000 } = {}) {
    const ice = this.getConfig();
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const auth = Buffer.from(`${ice.adminUser}:${ice.adminPassword}`).toString('base64');
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'Flux-Dashboard' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new IcecastError(`Icecast injoignable (${this.base}) : ${err.cause?.code || err.message}`);
    }
    const text = await res.text();
    if (res.status === 401) throw new IcecastError('Identifiants admin Icecast refusés');
    if (res.status === 404 && params.mount) throw new IcecastError(`Le point de montage ${params.mount} n'existe pas ou n'a pas de source connectée`);
    if (!res.ok) {
      const msg = text.match(/<message>([^<]*)<\/message>/)?.[1];
      throw new IcecastError(msg || `Erreur Icecast HTTP ${res.status}`);
    }
    return parser.parse(text);
  }

  async action(pathname, params) {
    const data = await this.request(pathname, params, { method: 'POST' });
    const r = data.iceresponse;
    if (r && String(r.return) !== '1') throw new IcecastError(r.message || 'Action refusée par Icecast');
    return r?.message || 'OK';
  }

  async stats() {
    const { icestats: s } = await this.request('/admin/stats');
    return {
      instance: s.instance_uuid || s.server_start,
      serverId: s.server_id,
      serverStart: s.server_start_iso8601,
      host: s.host,
      location: s.location,
      admin: s.admin,
      clients: num(s.clients),
      connections: num(s.connections),
      listeners: num(s.listeners),
      sources: num(s.sources),
      fileConnections: num(s.file_connections),
      sourceTotalConnections: num(s.source_total_connections),
      listenerConnections: num(s.listener_connections),
      // Icecast 2.5 liste aussi les montages configurés avec authentification même sans source :
      // on ne garde que ceux qui diffusent réellement
      mounts: (s.source || []).filter((src) => src.stream_start_iso8601 || src.stream_start || src.source_ip).map((src) => ({
        mount: src['@_mount'],
        listeners: num(src.listeners) ?? 0,
        peak: num(src.listener_peak) ?? 0,
        maxListeners: src.max_listeners === 'unlimited' ? null : num(src.max_listeners),
        slowListeners: num(src.slow_listeners) ?? 0,
        title: src.title || src.metadata?.x_icy_title || src.playlist?.trackList?.track?.title || '',
        artist: src.artist || '',
        name: src.server_name || '',
        description: src.server_description === 'Unspecified description' ? '' : src.server_description || '',
        genre: src.genre === 'various' ? '' : src.genre || '',
        url: src.server_url || '',
        contentType: src.server_type || src['content-type'] || '',
        bitrate: num(src.bitrate) ?? num(src['ice-bitrate']) ?? num(src.audio_bitrate && src.audio_bitrate / 1000),
        samplerate: num(src.audio_samplerate) ?? num(src['ice-samplerate']),
        channels: num(src.audio_channels) ?? num(src['ice-channels']),
        streamStart: src.stream_start_iso8601 || null,
        sourceIp: src.source_ip || '',
        encoder: src.user_agent || '',
        bytesSent: num(src.total_bytes_sent) ?? 0,
        bytesRead: num(src.total_bytes_read) ?? 0,
        public: src.public === '1' || src.public === 'true',
        listenUrl: src.listenurl || '',
      })),
    };
  }

  async listClients(mount) {
    const { icestats } = await this.request('/admin/listclients', { mount });
    const src = icestats?.source?.[0];
    return (src?.listener || []).map((l) => ({
      id: String(l.id ?? l['@_id']),
      ip: l.ip || l.IP || '',
      userAgent: l.useragent || l.UserAgent || '',
      connected: num(l.connected ?? l.Connected) ?? 0,
      referer: l.referer || l.Referer || '',
      protocol: l.protocol || '',
      tls: l.tls === 'true',
    }));
  }

  updateMetadata(mount, song) {
    return this.action('/admin/metadata', { mount, mode: 'updinfo', song });
  }

  killClient(mount, id) {
    return this.action('/admin/killclient', { mount, id });
  }

  killSource(mount) {
    return this.action('/admin/killsource', { mount });
  }

  moveClients(mount, destination) {
    return this.action('/admin/moveclients', { mount, destination });
  }

  setFallback(mount, fallback) {
    return this.action('/admin/fallbacks', { mount, fallback });
  }

  async ping() {
    try {
      await this.request('/admin/stats', {}, { timeout: 1500 });
      return true;
    } catch {
      return false;
    }
  }
}
