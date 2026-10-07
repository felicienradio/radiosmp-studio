import { playIcon, playUrl } from '../player.js';
import { html, icon, fmtNum, fmtDuration, fmtKbps, fmtDateTime, fmtTime, country, secret } from '../lib.js';

export const RANGES = [
  ['1h', '1 h'], ['24h', '24 h'], ['7d', '7 j'], ['30d', '30 j'], ['90d', '90 j'], ['365d', '1 an'],
];

export function rangeSelector(current) {
  return html`<div class="seg" data-range>${RANGES.map(([v, l]) => html`<button data-v="${v}" class="${v === current ? 'active' : ''}">${l}</button>`)}</div>`;
}

export function mountSelector(mounts, current, { all = 'Tous les flux' } = {}) {
  return html`<select data-mount>
    <option value="">${all}</option>
    ${mounts.map((m) => html`<option value="${m}" ${m === current ? 'selected' : ''}>${m}</option>`)}
  </select>`;
}

export function uptime(iso) {
  if (!iso) return '—';
  return fmtDuration((Date.now() - new Date(iso).getTime()) / 1000, true);
}

export function formatInfo(live) {
  if (!live) return '';
  const type = (live.contentType || '').replace('audio/', '').replace('mpeg', 'MP3').replace('aacp', 'AAC+').toUpperCase();
  return [type, live.bitrate ? `${live.bitrate} kbps` : '', live.samplerate ? `${live.samplerate / 1000} kHz` : '']
    .filter(Boolean).join(' · ');
}

/** Carte d'un point de montage (configuré et/ou en direct). */
export function mountCard(m, { actions = true, access = false } = {}) {
  const live = m.live;
  const name = live?.name || m.streamName || m.name;
  const max = live?.maxListeners || m.maxListeners || 0;
  const pct = max ? Math.min(100, (live?.listeners || 0) / max * 100) : 0;
  return html`
    <div class="card mount-card" data-mount-card="${m.name}">
      <div class="mount-head">
        <div class="title">
          <h3>${name}</h3>
          <div class="mono small">${m.name}${m.relayUrl ? ' · relais' : ''}</div>
        </div>
        ${live
          ? html`<span class="badge live"><span class="dot live"></span>EN DIRECT</span>`
          : html`<span class="badge">Hors ligne</span>`}
        ${!m.configured ? html`<span class="badge info" title="Ce flux n'a pas de réglages dédiés dans le dashboard">Non configuré</span>` : ''}
      </div>
      <div class="now-playing">
        <button class="play-btn" ${live ? html`data-play="${playUrl(m.name)}"` : 'disabled'} title="Écouter">${playIcon(live && playUrl(m.name))}</button>
        <div class="np-text">
          <div class="np-label">${live ? 'En cours de diffusion' : 'Aucune source connectée'}</div>
          <div class="np-title">${live ? live.title || 'Titre non renseigné' : m.relayUrl ? `Relais de ${m.relayUrl}` : 'En attente d\'un encodeur…'}</div>
        </div>
      </div>
      <div class="mount-stats">
        <div><b>${fmtNum(live?.listeners ?? 0)}</b><span>auditeurs</span></div>
        <div><b>${fmtNum(live?.peak ?? 0)}</b><span>pic (session)</span></div>
        <div><b>${live ? uptime(live.streamStart) : '—'}</b><span>en ligne depuis</span></div>
        <div><b>${live ? fmtKbps(live.kbps) : '—'}</b><span>sortant</span></div>
      </div>
      ${max ? html`<div><div class="row between small muted"><span>Capacité</span><span>${fmtNum(live?.listeners || 0)} / ${fmtNum(max)}</span></div>
        <div class="meter"><div style="width:${pct}%;background:${pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--ok)'}"></div></div></div>` : ''}
      ${live || m.configured ? html`<div class="small dim">${live ? formatInfo(live) : ''}${live?.encoder ? ` · ${live.encoder}` : ''}${m.configured
        ? html`${live ? ' · ' : ''}<span title="Buffer de démarrage">${m.startMode === 'instant' ? '⚡ Démarrage instantané' : '⏱ Faible latence'}</span>` : ''}</div>` : ''}
      ${access && m.configured && !m.relayUrl ? html`<div class="access">
        <span class="k">${icon('lock')}</span><span class="small"><b>Accès diffusion</b> <span class="dim">(propre à ce flux)</span></span>
        <span class="k">Utilisateur</span><span><code>${m.username || 'source'}</code></span>
        <span class="k">Mot de passe</span><span class="row" style="gap:4px">${m.password ? secret(m.password) : html`<span class="badge warn">mot de passe global</span>`}
          <button class="copy" data-act="regen" data-id="${m.id}" data-name="${m.name}" title="Générer un nouveau mot de passe">${icon('refresh')}</button></span>
      </div>` : ''}
      ${actions ? html`<div class="row">
        <button class="btn sm" data-act="details" data-name="${m.name}">${icon('link')} Connexion</button>
        ${live ? html`<button class="btn sm" data-act="metadata" data-name="${m.name}">${icon('tag')} Titre</button>` : ''}
        ${m.configured
          ? html`<button class="btn sm" data-act="edit" data-id="${m.id}">${icon('edit')} Modifier</button>`
          : html`<button class="btn sm" data-act="configure" data-name="${m.name}">${icon('settings')} Configurer</button>`}
        ${live ? html`<button class="btn sm danger" data-act="kill" data-name="${m.name}">${icon('power')} Couper</button>` : ''}
        ${m.configured && access ? html`<button class="btn sm ghost icon danger" data-act="delete" data-id="${m.id}" title="Supprimer ce point de montage" style="margin-left:auto">${icon('trash')}</button>` : ''}
      </div>` : ''}
    </div>`;
}

export function listenerRow(l, { kick = true } = {}) {
  const c = country(l.country);
  return html`<tr>
    <td><code>${l.mount}</code></td>
    <td class="nowrap">${c.flag} ${l.city ? `${l.city}, ` : ''}${c.name}</td>
    <td><code>${l.ip}</code></td>
    <td>${l.player}</td>
    <td title="${l.os}">${l.device || l.os}</td>
    <td class="truncate dim small" title="${l.userAgent}">${l.userAgent || '—'}</td>
    <td class="num nowrap" data-since="${l.startedAt}">${fmtDuration(l.duration)}</td>
    <td class="nowrap dim small">${fmtTime(l.startedAt)}</td>
    ${kick ? html`<td class="right"><button class="btn sm ghost danger" data-kick="${l.id}" data-mount="${l.mount}" title="Déconnecter">${icon('kick')}</button></td>` : ''}
  </tr>`;
}

export function eventItem(e) {
  const cls = { error: 'danger', warning: 'warn', info: 'ok' }[e.level] || '';
  return html`<div class="event">
    <time title="${fmtDateTime(e.ts)}">${fmtDateTime(e.ts).replace(/^(\d+\/\d+)\/\d+/, '$1')}</time>
    <span class="dot ${cls}" style="margin-top:6px"></span>
    <div>${e.mount ? html`<code>${e.mount}</code> ` : ''}${e.message}</div>
  </div>`;
}
