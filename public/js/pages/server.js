import { api, html, icon, $, run, modal, confirmDialog, formData, fmtDateTime, fmtNum, copyable, toast } from '../lib.js';
import { uptime } from './components.js';

const STATE = {
  running: ['ok', 'En marche'], starting: ['warn', 'Démarrage…'], stopping: ['warn', 'Arrêt…'],
  stopped: ['danger', 'Arrêté'], crashed: ['danger', 'Planté'], external: ['info', 'Serveur externe'],
};

function pwdField(name, label, value, hint = '') {
  return html`<label class="field">${label}<div class="input-group">
    <input name="${name}" value="${value}" autocomplete="off" required minlength="4">
    <button type="button" class="btn icon" data-gen="${name}" title="Générer un nouveau mot de passe">${icon('refresh')}</button></div>
    ${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
}

export default function serverPage(view, { store, onLive }) {
  let data = null;

  function processCard() {
    const p = store.process || data.process;
    const [cls, label] = STATE[p.state] || ['', p.state];
    const s = store.live?.server || data.live.server;
    return html`
      <div class="card" id="proc-card">
        <div class="card-head"><h2>Icecast</h2><span class="badge ${cls}"><span class="dot ${cls}"></span>${label}</span><div class="spacer"></div>
          ${p.managed ? html`
            <button class="btn" data-proc="start" ${['running', 'starting'].includes(p.state) ? 'disabled' : ''}>${icon('play')} Démarrer</button>
            <button class="btn" data-proc="restart" ${p.state !== 'running' ? 'disabled' : ''}>${icon('refresh')} Redémarrer</button>
            <button class="btn danger" data-proc="stop" ${p.state !== 'running' ? 'disabled' : ''}>${icon('stop')} Arrêter</button>` : ''}
        </div>
        ${p.lastError && p.state !== 'running' ? html`<div class="banner error"><div class="grow">${p.lastError}</div></div>` : ''}
        <dl class="kv">
          <dt>Version</dt><dd>${s?.id || (p.version ? `Icecast ${p.version}` : '—')}</dd>
          <dt>En ligne depuis</dt><dd>${s?.start ? html`${uptime(s.start)} <span class="dim small">(${fmtDateTime(s.start)})</span>` : '—'}</dd>
          <dt>Connexions</dt><dd>${s ? html`${fmtNum(s.clients)} clients actuels · ${fmtNum(s.connections)} depuis le démarrage` : '—'}</dd>
          ${p.managed ? html`
            <dt>Processus</dt><dd>${p.pid ? `PID ${p.pid}` : '—'}</dd>
            <dt>Exécutable</dt><dd><code>${p.binary}</code>${!p.binaryFound ? html` <span class="badge danger">introuvable</span>` : ''}</dd>
            <dt>Configuration</dt><dd><code>${p.configFile}</code> <button class="btn sm" data-show-config>Voir</button></dd>` : ''}
          <dt>Interface native</dt><dd><a href="${data.icecastAdminUrl}" target="_blank" rel="noopener">${data.icecastAdminUrl}</a></dd>
        </dl>
      </div>`;
  }

  function render() {
    const st = data.settings;
    const c = data.collector;
    view.innerHTML = String(html`
      <div id="proc-wrap">${processCard()}</div>

      <form id="settings" class="card mt">
        <div class="card-head"><h2>Réglages du serveur</h2><div class="spacer"></div>
          <button class="btn primary" type="submit">Enregistrer</button></div>
        <div class="stack">
          <label class="check"><input type="checkbox" name="managed" ${st.managed ? 'checked' : ''}>
            Icecast est installé sur ce PC et piloté par le dashboard (sinon : serveur Icecast externe, ex. un VPS)</label>

          <fieldset class="${st.managed ? 'hidden' : ''}" data-external>
            <legend>Serveur externe</legend>
            <div class="form-grid">
              <label class="field full">Adresse d'Icecast<input name="apiUrl" value="${st.apiUrl}" placeholder="http://mon-serveur:8000">
                <span class="hint">Le dashboard interroge son interface d'administration avec l'utilisateur et le mot de passe admin ci-dessous</span></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Identité</legend>
            <div class="form-grid">
              <label class="field">Nom d'hôte public<input name="hostname" value="${st.hostname}" required>
                <span class="hint">Adresse par laquelle les auditeurs joignent le serveur (nom de domaine ou IP publique). Utilisée dans les liens d'écoute.</span></label>
              <label class="field" data-managed>Port d'Icecast<input type="number" name="port" value="${st.port}" min="1" max="65535" required>
                <span class="hint">Port sur lequel Icecast écoute (8000 par défaut). Appliqué au prochain redémarrage d'Icecast ;
                  l'AutoDJ et le relais HTTPS suivent automatiquement.</span></label>
              <label class="field" data-managed>Port public (sortie)<input type="number" name="publicPort" value="${st.publicPort || ''}" min="0" max="65535" placeholder="${st.port} (le même)">
                <span class="hint">Port vu depuis Internet, si votre box redirige un autre port vers Icecast (ex. 8600 → 8000).
                  Utilisé dans les liens d'écoute et pour les encodeurs. Laissez vide s'il est identique.</span></label>
              <label class="field full">Adresse publique des flux (HTTPS)<input name="publicUrl" value="${st.publicUrl}" placeholder="https://icecast.radiosmp.fr">
                <span class="hint">Adresse du dashboard derrière votre reverse proxy HTTPS : les flux y sont relayés
                  (ex. <code>https://icecast.radiosmp.fr/live</code>) en gardant l'IP réelle des auditeurs. Utilisée dans les liens à partager.
                  ${data.relayListeners ? `${data.relayListeners} auditeur(s) passent actuellement par ce relais.` : ''}</span></label>
              <label class="field">Localisation<input name="location" value="${st.location}"></label>
              <label class="field">E-mail de contact<input name="adminEmail" value="${st.adminEmail}"></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Mots de passe</legend>
            <div class="form-grid">
              ${pwdField('sourcePassword', 'Mot de passe source', st.sourcePassword, 'Utilisé par vos encodeurs (utilisateur « source »)')}
              ${pwdField('relayPassword', 'Mot de passe relais', st.relayPassword, 'Pour les serveurs qui relaient les vôtres')}
              <label class="field">Utilisateur admin Icecast<input name="adminUser" value="${st.adminUser}" required></label>
              ${pwdField('adminPassword', 'Mot de passe admin Icecast', st.adminPassword, 'Utilisé par le dashboard et l\'interface native d\'Icecast')}
            </div>
          </fieldset>

          <fieldset data-managed>
            <legend>Limites</legend>
            <div class="form-grid">
              <label class="field">Clients simultanés max.<input type="number" name="limits.clients" value="${st.limits.clients}" min="1">
                <span class="hint">Auditeurs + sources, tous flux confondus</span></label>
              <label class="field">Sources max.<input type="number" name="limits.sources" value="${st.limits.sources}" min="1">
                <span class="hint">Nombre de flux pouvant diffuser en même temps</span></label>
              <label class="field">Burst (octets)<input type="number" name="limits.burstSize" value="${st.limits.burstSize}" min="0">
                <span class="hint">Données envoyées d'un coup à la connexion, pour un démarrage rapide</span></label>
              <label class="field">Délai source (s)<input type="number" name="limits.sourceTimeout" value="${st.limits.sourceTimeout}" min="1">
                <span class="hint">Temps avant de considérer un encodeur muet comme déconnecté</span></label>
            </div>
          </fieldset>

          <fieldset data-managed>
            <legend>Fonctionnement</legend>
            <div class="stack" style="gap:10px">
              <label class="field">Exécutable Icecast<input name="binary" value="${st.binary}"></label>
              <label class="check"><input type="checkbox" name="autoStart" ${st.autoStart ? 'checked' : ''}> Démarrer Icecast avec le dashboard</label>
              <label class="check"><input type="checkbox" name="autoRestart" ${st.autoRestart ? 'checked' : ''}> Redémarrer automatiquement Icecast s'il plante</label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Radio</legend>
            <div class="form-grid">
              <label class="field">Nom de la radio<input name="branding.name" value="${data.branding.name}" required></label>
              <label class="field">Slogan<input name="branding.slogan" value="${data.branding.slogan}"></label>
              <label class="field">Fuseau horaire des statistiques<input name="timezone" value="${data.timezone}" list="tz-list" required>
                <span class="hint">Les répartitions par heure et par jour sont calculées dans ce fuseau, même si le serveur est en UTC</span></label>
              <datalist id="tz-list">${['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Luxembourg', 'America/Guadeloupe', 'America/Martinique', 'Indian/Reunion', 'America/Montreal', 'Africa/Casablanca', 'UTC'].map((z) => html`<option value="${z}">`)}</datalist>
            </div>
          </fieldset>

          <fieldset>
            <legend>Statistiques</legend>
            <div class="form-grid">
              <label class="field">Fréquence de relevé (secondes)<input type="number" name="collector.intervalSec" value="${c.intervalSec}" min="2" max="300"></label>
              <label class="field">Conservation (jours)<input type="number" name="collector.retentionDays" value="${c.retentionDays}" min="0">
                <span class="hint">0 = garder indéfiniment</span></label>
            </div>
          </fieldset>
        </div>
      </form>

      <div class="card mt" id="update-card"><div class="skeleton">Vérification des mises à jour…</div></div>

      <div class="grid cols-2 mt">
        <div class="card">
          <div class="card-head"><h2>Géolocalisation des auditeurs</h2></div>
          <p class="muted" style="margin-top:0">Pour connaître le pays et la ville de chaque auditeur (carte du monde, top pays), le dashboard utilise
            les bases gratuites <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP Lite</a> (licence CC BY 4.0), stockées sur le serveur.
            Aucune adresse IP n'est envoyée à un service extérieur. Les auditeurs déjà enregistrés sont localisés après l'installation.</p>
          <div class="row">
            ${data.geo.installed
              ? html`<span class="badge ok">${data.geo.hasCities ? 'Villes + pays' : 'Pays seulement'}</span><span class="dim small">mise à jour le ${fmtDateTime(data.geo.updatedAt)}</span>`
              : html`<span class="badge warn">Non installée</span>`}
          </div>
          <div class="row mt">
            <button class="btn primary" data-geo="city">${icon('download')} Base villes + pays (${data.geo.sizes.city})</button>
            <button class="btn" data-geo="country">${icon('download')} Pays seulement (${data.geo.sizes.country})</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Comptes du dashboard</h2></div>
          <p class="muted" style="margin-top:0">Chaque personne a son pseudo et son mot de passe, avec un rôle : administrateur, animateur ou lecture seule.
            Votre propre mot de passe se change dans <b>Mon compte</b>, en bas du menu.</p>
          <a class="btn" href="#/utilisateurs">${icon('users')} Gérer les comptes</a>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head"><h2>Accès au dashboard</h2></div>
        <p class="muted" style="margin-top:0">Le dashboard écoute sur ${copyable(`http://${data.dashboard.host}:${data.dashboard.port}`)}.
          ${data.dashboard.host === '0.0.0.0'
            ? 'Il est accessible depuis les autres appareils du réseau. Pour un accès depuis Internet, placez-le derrière un reverse proxy en HTTPS.'
            : html`Il n'est accessible que depuis cette machine. Pour l'ouvrir depuis un autre appareil, définissez la variable
              d'environnement <code>FLUX_HOST=0.0.0.0</code> (déjà fait par le script d'installation LXC) puis redémarrez le dashboard.`}
          ${data.platform === 'linux' ? html`<br>Service : <code>systemctl restart flux</code> · journaux : <code>journalctl -u flux -f</code>` : ''}</p>
      </div>`);
    toggleMode();
  }

  function toggleMode() {
    const managed = $('[name=managed]', view).checked;
    view.querySelectorAll('[data-managed]').forEach((el) => el.classList.toggle('hidden', !managed));
    view.querySelectorAll('[data-external]').forEach((el) => el.classList.toggle('hidden', managed));
  }

  view.addEventListener('change', (e) => {
    if (e.target.name === 'managed') toggleMode();
  });

  view.addEventListener('click', async (e) => {
    const proc = e.target.closest('[data-proc]');
    if (proc) {
      const action = proc.dataset.proc;
      if (action !== 'start' && !await confirmDialog(
        action === 'stop' ? 'Arrêter Icecast ?' : 'Redémarrer Icecast ?',
        'Toutes les sources et tous les auditeurs seront déconnectés.',
        { confirm: action === 'stop' ? 'Arrêter' : 'Redémarrer', danger: action === 'stop' },
      )) return;
      const label = { start: 'Icecast démarré', stop: 'Icecast arrêté', restart: 'Icecast redémarré' }[action];
      data = await run(proc, () => api(`/server/${action}`, { method: 'POST' }), label).catch(() => data);
      store.process = data.process;
      $('#proc-wrap', view).innerHTML = String(processCard());
    }
    const gen = e.target.closest('[data-gen]');
    if (gen) {
      const { password } = await api('/server/generate-password', { method: 'POST' });
      view.querySelector(`[name="${gen.dataset.gen}"]`).value = password;
    }
    if (e.target.closest('[data-show-config]')) {
      const r = await api('/server/config');
      modal({ title: 'icecast.xml (généré)', wide: true, body: html`<p class="dim small" style="margin-top:0"><code>${r.file}</code></p><div class="log">${r.xml}</div>` });
    }
    const geo = e.target.closest('[data-geo]');
    if (geo) {
      const kind = geo.dataset.geo;
      geo.textContent = 'Téléchargement en cours…';
      view.querySelectorAll('[data-geo]').forEach((b) => { b.disabled = true; });
      await run(null, () => api('/geo/download', { method: 'POST', body: { kind } }), 'Base GeoIP installée, auditeurs localisés').catch(() => {});
      load();
    }
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'settings') {
      const body = formData(e.target);
      data = await run(e.target.querySelector('[type=submit]'), () => api('/server/settings', { method: 'PUT', body }), 'Réglages enregistrés');
      store.process = data.process;
      render();
    }
  });

  async function load() {
    data = await api('/server');
    render();
    loadUpdate();
  }

  // ---------- Mises à jour depuis GitHub ----------

  let update = null;
  let pollTimer = null;
  let versionBefore = null;

  function updateCard(u) {
    const short = (h) => (h ? h.slice(0, 7) : '—');
    const busy = u.pending || u.state === 'checking' || u.state === 'updating';
    const badge = {
      uptodate: ['ok', 'À jour'],
      available: ['accent', `${u.commits.length || 'Nouvelle'} mise${u.commits.length > 1 ? 's' : ''} à jour disponible${u.commits.length > 1 ? 's' : ''}`],
      updating: ['warn', 'Mise à jour en cours…'],
      checking: ['warn', 'Vérification…'],
      done: ['ok', 'Mise à jour terminée'],
      'needs-key': ['warn', 'Clé GitHub à ajouter'],
      error: ['danger', 'Erreur'],
    }[u.pending ? 'checking' : u.state] || ['', 'Pas encore vérifié'];
    return html`
      <div class="card-head"><h2>Mises à jour</h2><span class="badge ${badge[0]}">${badge[1]}</span><div class="spacer"></div>
        ${u.supported ? html`
          <button class="btn" data-upd="check" ${busy ? 'disabled' : ''}>${icon('refresh')} Vérifier</button>
          <button class="btn primary" data-upd="run" ${busy || u.state !== 'available' ? 'disabled' : ''}>${icon('download')} Mettre à jour</button>` : ''}
      </div>
      <dl class="kv">
        <dt>Version installée</dt><dd><code>${short(u.version)}</code>${u.repo && u.version ? html` <a class="small" href="${u.repo}/commit/${u.version}" target="_blank" rel="noopener">voir sur GitHub</a>` : ''}</dd>
        ${u.latest ? html`<dt>Dernière version</dt><dd><code>${short(u.latest)}</code></dd>` : ''}
        ${u.checkedAt ? html`<dt>Dernière vérification</dt><dd>${fmtDateTime(u.checkedAt)} <span class="dim small">(automatique toutes les heures)</span></dd>` : ''}
      </dl>
      ${u.supported && 'Notification' in window ? html`<p class="small muted" style="margin-bottom:0">${Notification.permission === 'granted'
        ? html`${icon('check')} Ce navigateur affiche une notification dès qu'une mise à jour est disponible (dashboard ouvert).`
        : Notification.permission === 'denied'
          ? 'Les notifications sont bloquées pour ce site dans votre navigateur : un bandeau s\'affiche quand même dans le dashboard.'
          : html`Un bandeau s'affiche dans le dashboard quand une mise à jour est disponible.
            <button class="btn sm" data-notif>${icon('bell')} Recevoir aussi une notification</button>`}</p>` : ''}
      ${!u.supported ? html`<p class="muted">Les mises à jour en un clic fonctionnent sur l'installation Linux (conteneur LXC).
        Ici, mettez à jour avec <code>git pull</code> puis relancez le dashboard.</p>` : ''}
      ${u.error && u.state !== 'needs-key' ? html`<div class="banner error mt"><div class="grow">${u.error}</div></div>` : ''}
      ${u.state === 'needs-key' && u.deployKey ? html`<div class="mt">
        <p style="margin-top:0">Le dépôt GitHub est privé : ajoutez cette <b>clé de déploiement</b> (lecture seule) pour autoriser ce serveur à le lire,
          puis cliquez sur <b>Vérifier</b>.</p>
        <ol class="muted small">
          <li>Ouvrez <a href="${u.deployKeysUrl}" target="_blank" rel="noopener">${u.deployKeysUrl}</a></li>
          <li>Titre : <code>RadioSMP Studio</code>, collez la clé ci-dessous, laissez « Allow write access » décoché, puis <b>Add key</b>.</li>
        </ol>
        <textarea rows="2" readonly>${u.deployKey}</textarea>
        <button class="btn sm mt" data-copy="${u.deployKey}">${icon('copy')} Copier la clé</button>
      </div>` : ''}
      ${u.commits.length ? html`<h3 class="mt">Nouveautés</h3><div class="mt">${u.commits.map((c) => html`<div class="event">
        <time>${c.date ? fmtDateTime(c.date).slice(0, 10) : ''}</time><code>${c.hash}</code><div>${c.subject}</div></div>`)}</div>` : ''}
      ${u.log && ['updating', 'done', 'error'].includes(u.state) ? html`<details class="mt" ${u.state !== 'done' ? 'open' : ''}><summary class="small muted">Journal de la mise à jour</summary>
        <div class="log mt">${u.log}</div></details>` : ''}`;
  }

  function renderUpdate() {
    const card = $('#update-card', view);
    if (card && update) card.innerHTML = String(updateCard(update));
  }

  async function loadUpdate() {
    try {
      update = await api('/update');
    } catch {
      // pendant une mise à jour, le dashboard redémarre : on réessaie
      if (versionBefore) pollTimer = setTimeout(loadUpdate, 3000);
      return;
    }
    renderUpdate();
    const busy = update.pending || ['checking', 'updating'].includes(update.state);
    clearTimeout(pollTimer);
    if (busy || versionBefore) pollTimer = setTimeout(loadUpdate, 3000);
    // Le dashboard redémarre pendant la mise à jour : on recharge la page une fois la nouvelle version en place
    if (versionBefore && update.state === 'done' && update.version !== versionBefore) {
      versionBefore = null;
      toast('Mise à jour installée, rechargement…');
      setTimeout(() => location.reload(), 1500);
    }
    if (versionBefore && update.state === 'error') versionBefore = null;
  }

  view.addEventListener('click', async (e) => {
    if (e.target.closest('[data-notif]')) {
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? 'Notifications activées' : 'Notifications refusées par le navigateur', r === 'granted' ? 'ok' : 'error');
      renderUpdate();
      return;
    }
    const b = e.target.closest('[data-upd]');
    if (!b) return;
    if (b.dataset.upd === 'run') {
      if (!await confirmDialog('Mettre à jour depuis GitHub ?', 'Le dashboard redémarre pendant la mise à jour (environ une minute). Icecast et les flux en direct continuent de diffuser ; l\'AutoDJ reprend tout seul à la fin.', { confirm: 'Mettre à jour' })) return;
      versionBefore = update?.version || 'x';
    }
    update = await run(b, () => api(`/update/${b.dataset.upd}`, { method: 'POST' })).catch(() => update);
    renderUpdate();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadUpdate, 2000);
  });

  load();
  let lastKey = '';
  const offLive = onLive(() => {
    if (!data || !$('#proc-wrap', view)) return;
    const p = store.process || {};
    const key = [p.state, p.pid, p.lastError, store.live?.server?.start, store.live?.server?.clients].join('|');
    if (key === lastKey) return;
    lastKey = key;
    $('#proc-wrap', view).innerHTML = String(processCard());
  });
  return () => {
    offLive();
    clearTimeout(pollTimer);
  };
}
