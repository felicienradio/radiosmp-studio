import { api, html, icon, $, run, modal, confirmDialog, formData, fmtDateTime, fmtNum, copyable } from '../lib.js';
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
              <label class="field" data-managed>Port<input type="number" name="port" value="${st.port}" min="1" max="65535" required>
                <span class="hint">8000 par défaut. À ouvrir dans le pare-feu et la box pour l'écoute depuis Internet.</span></label>
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
        <form class="card" id="pwd-form">
          <div class="card-head"><h2>Mot de passe du dashboard</h2></div>
          <div class="form-grid">
            <label class="field">Actuel<input type="password" name="current" required autocomplete="current-password"></label>
            <label class="field">Nouveau<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
          </div>
          <button class="btn mt" type="submit">Changer le mot de passe</button>
        </form>
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
    if (e.target.id === 'pwd-form') {
      await run(e.target.querySelector('[type=submit]'), () => api('/dashboard/password', { method: 'POST', body: formData(e.target) }), 'Mot de passe modifié');
      e.target.reset();
    }
  });

  async function load() {
    data = await api('/server');
    render();
  }

  load();
  let lastKey = '';
  return onLive(() => {
    if (!data || !$('#proc-wrap', view)) return;
    const p = store.process || {};
    const key = [p.state, p.pid, p.lastError, store.live?.server?.start, store.live?.server?.clients].join('|');
    if (key === lastKey) return;
    lastKey = key;
    $('#proc-wrap', view).innerHTML = String(processCard());
  });
}
