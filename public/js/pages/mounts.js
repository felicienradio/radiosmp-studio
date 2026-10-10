import { api, html, icon, $, run, modal, confirmDialog, promptDialog, formData, copyable, secret, fmtNum, fmtDateTime } from '../lib.js';
import { mountCard } from './components.js';

const EMPTY = {
  name: '/', streamName: '', description: '', genre: '', url: '', maxListeners: 0,
  username: '', password: '', fallbackMount: '', fallbackOverride: true, fallbackWhenFull: false,
  hidden: false, public: false, relayUrl: '', onDemand: false, startMode: 'lowlatency',
};

function mountForm(m, others) {
  return html`<form id="mount-form" class="stack">
    <div class="form-grid">
      <label class="field">Point de montage<input name="name" value="${m.name}" required placeholder="/live">
        <span class="hint">Chemin du flux, ex. <code>/live</code> ou <code>/radio.mp3</code></span></label>
      <label class="field">Nom de la radio<input name="streamName" value="${m.streamName}" placeholder="Ma Radio"></label>
      <label class="field full">Description<input name="description" value="${m.description}" placeholder="La meilleure radio du coin"></label>
      <label class="field">Genre<input name="genre" value="${m.genre}" placeholder="Pop, Rock, Talk…"></label>
      <label class="field">Site web<input name="url" value="${m.url}" placeholder="https://"></label>
      <label class="field">Auditeurs max.<input type="number" min="0" name="maxListeners" value="${m.maxListeners}">
        <span class="hint">0 = illimité (dans la limite globale du serveur)</span></label>
      <label class="field full">Buffer de démarrage<select name="startMode" style="width:100%">
          <option value="lowlatency" ${m.startMode !== 'instant' ? 'selected' : ''}>Faible latence (buffer 0) : au plus près du direct</option>
          <option value="instant" ${m.startMode === 'instant' ? 'selected' : ''}>Démarrage instantané : le son part dès le clic sur Play</option>
        </select>
        <span class="hint">Faible latence : idéal pour les directs (jeux, appels), le lecteur met 1 à 3 s à démarrer.
          Démarrage instantané : quelques secondes d'avance envoyées d'un coup, avec autant de décalage sur le direct.</span></label>
    </div>
    <fieldset class="accent">
      <legend>${icon('lock')} Accès diffusion</legend>
      <div class="form-grid">
        <label class="field">Utilisateur<input name="username" value="${m.username || 'source'}" placeholder="source" autocomplete="off"></label>
        <label class="field">Mot de passe<div class="input-group"><input name="password" value="${m.password}" placeholder="généré automatiquement" autocomplete="off" minlength="4">
          <button type="button" class="btn icon" data-gen title="Générer">${icon('refresh')}</button></div></label>
        <p class="full dim small" style="margin:0">Identifiants à donner à l'animateur de ce flux : ils ne permettent de diffuser que sur ce point de montage.
          Laissez vide pour en générer un automatiquement.</p>
      </div>
    </fieldset>
    <fieldset>
      <legend>Secours</legend>
      <div class="form-grid">
        <label class="field">Flux de secours<select name="fallbackMount" style="width:100%">
          <option value="">Aucun</option>
          ${others.map((o) => html`<option value="${o}" ${o === m.fallbackMount ? 'selected' : ''}>${o}</option>`)}
        </select><span class="hint">Si la source coupe, les auditeurs basculent sur ce flux au lieu d'être déconnectés</span></label>
        <div class="stack" style="gap:10px;justify-content:center">
          <label class="check"><input type="checkbox" name="fallbackOverride" ${m.fallbackOverride ? 'checked' : ''}> Revenir automatiquement quand la source revient</label>
          <label class="check"><input type="checkbox" name="fallbackWhenFull" ${m.fallbackWhenFull ? 'checked' : ''}> Envoyer vers le secours quand le flux est plein</label>
        </div>
      </div>
    </fieldset>
    <fieldset>
      <legend>Relais</legend>
      <div class="form-grid">
        <label class="field full">Relayer un flux existant<input name="relayUrl" value="${m.relayUrl}" placeholder="http://autre-serveur:8000/flux (laisser vide pour une source normale)">
          <span class="hint">Icecast récupère lui-même ce flux et le rediffuse sur ce point de montage</span></label>
        <label class="check"><input type="checkbox" name="onDemand" ${m.onDemand ? 'checked' : ''}> Uniquement quand il y a des auditeurs (à la demande)</label>
      </div>
    </fieldset>
    <div class="row">
      <label class="check"><input type="checkbox" name="hidden" ${m.hidden ? 'checked' : ''}> Masquer de la page publique d'Icecast</label>
      <label class="check"><input type="checkbox" name="public" ${m.public ? 'checked' : ''}> Publier dans l'annuaire Xiph</label>
    </div>
  </form>`;
}

export async function openMountEditor(id, prefillName) {
  const { mounts } = await api('/mounts');
  const existing = id ? mounts.find((m) => m.id === id) : null;
  const m = existing || { ...EMPTY, name: prefillName || '/' };
  const others = mounts.map((x) => x.name).filter((n) => n !== m.name);
  return new Promise((resolve) => {
    const { dlg, close } = modal({
      title: existing ? `Modifier ${m.name}` : 'Nouveau point de montage',
      body: mountForm(m, others),
      footer: html`${existing ? html`<button class="btn danger" data-del style="margin-right:auto">${icon('trash')} Supprimer</button>` : ''}
        <button class="btn" data-close>Annuler</button>
        <button class="btn primary" form="mount-form">${existing ? 'Enregistrer' : 'Créer'}</button>`,
    });
    dlg.querySelector('[data-gen]').addEventListener('click', async () => {
      const { password } = await api('/server/generate-password', { method: 'POST' });
      dlg.querySelector('[name=password]').value = password;
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      const btn = dlg.querySelector('.btn.primary');
      await run(btn, () => api(existing ? `/mounts/${id}` : '/mounts', { method: existing ? 'PUT' : 'POST', body }),
        existing ? 'Point de montage enregistré' : 'Point de montage créé');
      close();
      resolve(true);
    });
    dlg.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!await deleteMount(m)) return;
      close();
      resolve(true);
    });
    dlg.addEventListener('close', () => resolve(false));
  });
}

/** Suppression d'un point de montage, avec ou sans ses statistiques. Renvoie true si supprimé. */
export function deleteMount(m) {
  return new Promise((resolve) => {
    let done = false;
    const { dlg, close } = modal({
      title: `Supprimer ${m.name} ?`,
      body: html`<div class="stack">
        <p style="margin:0">Le point de montage <code>${m.name}</code>${m.streamName ? html` (${m.streamName})` : ''} et son mot de passe de diffusion seront supprimés.
          ${m.live ? html`<b>Un encodeur est connecté dessus : il sera déconnecté.</b>` : ''}
          Les flux qui l'utilisaient comme secours n'en auront plus.</p>
        <label class="check"><input type="checkbox" id="purge"> Effacer aussi ses statistiques (auditeurs, courbes, titres diffusés)</label>
        <p class="dim small" style="margin:0">Sans cette case, l'historique reste visible dans les statistiques et le rapport.
          Icecast prend la suppression en compte au prochain « Appliquer maintenant ».</p></div>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn danger" id="del-ok">${icon('trash')} Supprimer</button>`,
    });
    dlg.querySelector('#del-ok').addEventListener('click', async (e) => {
      const purge = dlg.querySelector('#purge').checked;
      const r = await run(e.currentTarget, () => api(`/mounts/${m.id}${purge ? '?stats=1' : ''}`, { method: 'DELETE' }),
        purge ? 'Point de montage et statistiques supprimés' : 'Point de montage supprimé').catch(() => null);
      if (r === null) return;
      done = true;
      close();
    });
    dlg.addEventListener('close', () => resolve(done));
  });
}

export async function openConnection(name) {
  const { mounts, connection: c } = await api('/mounts');
  const m = mounts.find((x) => x.name === name) || { name };
  const user = m.password ? m.username || 'source' : 'source';
  const dedicated = !!m.password;
  const pass = m.password || c.sourcePassword;
  // Adresse directe d'Icecast (port public, celui ouvert sur la box) et adresse publique HTTPS relayée par le dashboard
  const base = c.managed ? `http://${c.host}:${c.publicPort || c.port}` : c.apiUrl.replace(/\/+$/, '');
  const host = base.replace(/^https?:\/\//, '').split(':')[0];
  const port = base.split(':')[2] || c.port;
  const pub = c.publicUrl || base;
  const listen = `${pub}${m.name}`;
  const embed = `<audio controls preload="none" src="${listen}"></audio>`;
  modal({
    title: `Connexion à ${m.name}`,
    wide: true,
    body: html`
      <div class="grid cols-2">
        <div>
          <h3>Pour votre logiciel de diffusion</h3>
          <p class="muted small">BUTT, Mixxx, RadioBOSS, VestaLive, OBS, Liquidsoap… choisissez le type de serveur <b>Icecast 2</b>.</p>
          <dl class="kv">
            <dt>Type de serveur</dt><dd>Icecast 2</dd>
            <dt>Adresse (hôte)</dt><dd>${copyable(host)}</dd>
            <dt>Port</dt><dd>${copyable(String(port))}</dd>
            <dt>Point de montage</dt><dd>${copyable(m.name)}</dd>
            <dt>Utilisateur</dt><dd>${copyable(user)}</dd>
            <dt>Mot de passe</dt><dd>${secret(pass)}</dd>
          </dl>
          <p class="dim small">${dedicated ? 'Ces identifiants sont propres à ce flux.' : 'Mot de passe source global (réglable sur la page Serveur).'}
          ${c.managed && c.publicPort !== c.port ? html`Sur le réseau local, utilisez le port d'Icecast <code>${c.port}</code>. ` : ''}
          Si l'encodeur est sur le même réseau, vous pouvez aussi mettre l'IP locale du serveur.</p>
        </div>
        <div>
          <h3>Pour vos auditeurs</h3>
          <dl class="kv mt">
            <dt>Lien direct</dt><dd>${copyable(listen)}</dd>
            <dt>Playlist M3U</dt><dd>${copyable(`${listen}.m3u`)}</dd>
            <dt>Infos JSON</dt><dd>${copyable(`${pub}/status-json.xsl?mount=${m.name}`)}</dd>
          </dl>
          <h3 class="mt">Lecteur à intégrer sur votre site</h3>
          <div class="row mt"><textarea rows="3" readonly>${embed}</textarea></div>
          <button class="btn sm mt" data-copy="${embed}">${icon('copy')} Copier le code</button>
        </div>
      </div>`,
  });
}

export function bindMountActions(root, reload) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, name, id } = b.dataset;
    if (act === 'details') openConnection(name);
    if (act === 'edit' && await openMountEditor(id)) reload();
    if (act === 'delete') {
      const { mounts } = await api('/mounts');
      const m = mounts.find((x) => x.id === id);
      if (m && await deleteMount(m)) reload();
    }
    if (act === 'configure' && await openMountEditor(null, name)) reload();
    if (act === 'metadata') {
      const card = b.closest('[data-mount-card]');
      const current = card?.querySelector('.np-title')?.textContent || '';
      const song = await promptDialog(`Titre en cours sur ${name}`, 'Artiste - Titre', current === 'Titre non renseigné' ? '' : current, { confirm: 'Mettre à jour' });
      if (song) await run(null, () => api('/mounts/metadata', { method: 'POST', body: { mount: name, song } }), 'Titre mis à jour');
    }
    if (act === 'regen') {
      if (!await confirmDialog('Nouveau mot de passe de diffusion ?', `L'encodeur qui diffuse sur ${name} devra utiliser le nouveau mot de passe. Il sera appliqué au prochain redémarrage d'Icecast.`, { confirm: 'Générer' })) return;
      const r = await run(null, () => api(`/mounts/${id}/password`, { method: 'POST' }), 'Nouveau mot de passe généré');
      if (r) reload();
    }
    if (act === 'kill') {
      if (!await confirmDialog('Couper la source ?', `L'encodeur connecté sur ${name} sera déconnecté. Il risque de se reconnecter automatiquement s'il est configuré pour.`, { confirm: 'Couper', danger: true })) return;
      await run(null, () => api('/mounts/kill-source', { method: 'POST', body: { mount: name } }), 'Source coupée');
    }
  });
}

export default function mountsPage(view, { store, onLive, topbar }) {
  let data = null;
  topbar.innerHTML = String(html`<button class="btn primary" id="new-mount">${icon('plus')} Nouveau point de montage</button>`);
  $('#new-mount', topbar).addEventListener('click', async () => {
    if (await openMountEditor()) load();
  });

  function render() {
    if (!data) return;
    const liveMounts = store.live?.mounts;
    const live = new Map((liveMounts || []).map((m) => [m.mount, m]));
    const list = data.mounts.filter((m) => m.configured)
      .map((m) => ({ ...m, live: liveMounts ? live.get(m.name) || null : m.live }));
    for (const [name, l] of live) if (!list.some((m) => m.name === name)) list.push({ id: null, name, configured: false, live: l });
    const onAir = list.filter((m) => m.live).length;
    view.innerHTML = String(html`
      <p class="muted" style="margin-top:-8px">${fmtNum(list.length)} point(s) de montage · ${fmtNum(onAir)} en direct.
        Une source qui se connecte avec le mot de passe global sur un nouveau chemin crée aussi un flux à la volée.</p>
      <div class="grid mounts">${list.map((m) => mountCard(m, { access: true }))}</div>
      ${list.some((m) => !m.configured) ? html`<p class="dim small mt">Les flux « non configurés » utilisent les réglages par défaut.
        Cliquez sur <b>Configurer</b> pour leur donner un nom, une limite d'auditeurs, un flux de secours…</p>` : ''}
      ${data.archived?.length ? html`<div class="card flush mt">
        <div class="card-head"><h3>Anciens flux</h3><span class="dim small">plus configurés, encore présents dans les statistiques</span></div>
        <div class="table-wrap mt"><table><tbody>${data.archived.map((a) => html`<tr>
          <td><code>${a.mount}</code></td><td class="dim small">${fmtNum(a.sessions)} écoute${a.sessions > 1 ? 's' : ''}</td>
          <td class="dim small">dernière activité ${fmtDateTime(a.last)}</td>
          <td class="right"><button class="btn sm ghost danger" data-purge="${a.mount}">${icon('trash')} Effacer l'historique</button></td></tr>`)}
        </tbody></table></div></div>` : ''}`);
  }

  async function load() {
    data = await api('/mounts');
    render();
  }

  bindMountActions(view, load);
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-purge]');
    if (!b) return;
    const name = b.dataset.purge;
    if (!await confirmDialog(`Effacer l'historique de ${name} ?`, "Les écoutes, courbes d'auditeurs et titres diffusés de ce flux seront définitivement supprimés des statistiques.", { confirm: 'Effacer', danger: true })) return;
    await run(b, () => api(`/mounts-stats?mount=${encodeURIComponent(name)}`, { method: 'DELETE' }), 'Historique effacé');
    load();
  });
  load();
  let lastKey = '';
  return onLive(() => {
    const key = JSON.stringify((store.live?.mounts || []).map((m) => [m.mount, m.listeners, m.title, m.peak]));
    if (key !== lastKey) {
      lastKey = key;
      render();
    }
  });
}
