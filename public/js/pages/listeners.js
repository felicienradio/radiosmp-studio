import { api, html, icon, $, $$, run, modal, confirmDialog, fmtNum, fmtDuration, barList, country } from '../lib.js';
import { listenerRow, mountSelector } from './components.js';

function group(list, key) {
  const m = new Map();
  for (const l of list) m.set(key(l), (m.get(key(l)) || 0) + 1);
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
}

export default function listenersPage(view, { store, onLive, topbar }) {
  let mount = '';
  let search = '';
  let lastMounts = null;

  topbar.innerHTML = String(html`<button class="btn admin-only" id="move-btn">${icon('move')} Déplacer des auditeurs</button>`);
  $('#move-btn', topbar).addEventListener('click', openMove);

  view.innerHTML = String(html`
    <div class="grid cols-3">
      <div class="card kpi accent"><div class="kpi-label">Auditeurs connectés</div><div class="kpi-value" id="k-total">0</div></div>
      <div class="card kpi"><div class="kpi-label">Durée moyenne de connexion</div><div class="kpi-value" id="k-avg">—</div></div>
      <div class="card kpi"><div class="kpi-label">Adresses IP distinctes</div><div class="kpi-value" id="k-ips">0</div></div>
    </div>
    <div class="grid cols-3 mt">
      <div class="card"><div class="card-head"><h2>Par flux</h2></div><div id="by-mount"></div></div>
      <div class="card"><div class="card-head"><h2>Par appareil</h2></div><div id="by-player"></div></div>
      <div class="card"><div class="card-head"><h2>Par pays</h2></div><div id="by-country"></div></div>
    </div>
    <div class="card flush mt">
      <div class="card-head">
        <h2>Liste en direct</h2><div class="spacer"></div>
        <span id="mount-filter"></span>
        <input id="search" placeholder="Rechercher IP, lecteur…" style="width:220px">
      </div>
      <div class="table-wrap mt"><table>
        <thead><tr><th>Flux</th><th>Localisation</th><th>IP</th><th>Lecteur</th><th>Appareil</th><th>User-Agent</th><th class="num">Durée</th><th>Arrivée</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
    </div>`);

  $('#search', view).addEventListener('input', (e) => { search = e.target.value.toLowerCase(); render(); });
  view.addEventListener('change', (e) => {
    if (e.target.matches('[data-mount]')) { mount = e.target.value; render(); }
  });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    if (!await confirmDialog('Déconnecter cet auditeur ?', 'Il pourra se reconnecter immédiatement s\'il relance la lecture.', { confirm: 'Déconnecter', danger: true })) return;
    await run(null, () => api('/listeners/kick', { method: 'POST', body: { mount: b.dataset.mount, id: b.dataset.kick } }), 'Auditeur déconnecté');
  });

  function render() {
    const all = store.live?.listeners || [];
    const mounts = (store.live?.mounts || []).map((m) => m.mount);
    if (mounts.join() !== lastMounts) {
      lastMounts = mounts.join();
      $('#mount-filter', view).innerHTML = String(mountSelector(mounts, mount));
    }
    const list = all
      .filter((l) => !mount || l.mount === mount)
      .filter((l) => !search || `${l.ip} ${l.player} ${l.os} ${l.userAgent} ${l.mount} ${country(l.country).name}`.toLowerCase().includes(search))
      .sort((a, b) => b.duration - a.duration);
    $('#k-total', view).textContent = fmtNum(all.length);
    $('#k-avg', view).textContent = all.length ? fmtDuration(all.reduce((a, l) => a + l.duration, 0) / all.length, true) : '—';
    $('#k-ips', view).textContent = fmtNum(new Set(all.map((l) => l.ip)).size);
    $('#by-mount', view).innerHTML = String(barList(group(all, (l) => l.mount), { empty: 'Personne à l\'écoute' }));
    $('#by-player', view).innerHTML = String(barList(group(all, (l) => l.device || l.player), { empty: 'Personne à l\'écoute' }));
    $('#by-country', view).innerHTML = String(barList(group(all, (l) => l.country || '?'), {
      label: (x) => country(x.label).label,
      empty: 'Personne à l\'écoute',
    }));
    $('#rows', view).innerHTML = list.length
      ? list.map((l) => String(listenerRow(l))).join('')
      : String(html`<tr><td colspan="9" class="empty">${all.length ? 'Aucun résultat' : 'Aucun auditeur connecté pour le moment'}</td></tr>`);
  }

  function openMove() {
    const mounts = (store.live?.mounts || []);
    if (mounts.length < 2) {
      modal({ title: 'Déplacer des auditeurs', body: html`<p>Il faut au moins deux flux en direct pour déplacer des auditeurs de l'un vers l'autre.</p>` });
      return;
    }
    const opts = mounts.map((m) => html`<option value="${m.mount}">${m.mount} (${m.listeners} auditeurs)</option>`);
    const { dlg, close } = modal({
      title: 'Déplacer des auditeurs',
      body: html`<form id="mv" class="stack">
        <p class="muted" style="margin:0">Tous les auditeurs du premier flux passent sur le second, sans coupure. Pratique pour basculer vers un direct ou un programme spécial.</p>
        <div class="form-grid">
          <label class="field">Depuis<select name="mount" style="width:100%">${opts}</select></label>
          <label class="field">Vers<select name="destination" style="width:100%">${opts}</select></label>
        </div></form>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="mv">Déplacer</button>`,
    });
    dlg.querySelector('[name=destination]').selectedIndex = 1;
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.mount.value === f.destination.value) return;
      await run(null, () => api('/listeners/move', { method: 'POST', body: { mount: f.mount.value, destination: f.destination.value } }), 'Auditeurs déplacés');
      close();
    });
  }

  render();
  const off = onLive(render);
  // Les durées avancent chaque seconde entre deux rafraîchissements
  const tick = setInterval(() => {
    $$('[data-since]', view).forEach((td) => { td.textContent = fmtDuration((Date.now() - Number(td.dataset.since)) / 1000); });
  }, 1000);
  return () => { off(); clearInterval(tick); };
}
