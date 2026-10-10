import { api, html, icon, $, run, modal, confirmDialog, fmtDateTime } from '../lib.js';

const ROLE_HELP = {
  admin: 'Tout : serveur, flux, comptes, personnalisation, mises à jour.',
  dj: 'AutoDJ (démarrer, passer, file d\'attente), playlists, bibliothèque, titre en cours, statistiques.',
  viewer: 'Consultation : tableau de bord, statistiques, rapport, titres diffusés. Aucun mot de passe visible.',
};
const ROLE_BADGE = { admin: 'accent', dj: 'ok', viewer: '' };

function userDialog(roles, user = null) {
  return new Promise((resolve) => {
    let done = false;
    const { dlg, close } = modal({
      title: user ? `Modifier ${user.username}` : 'Nouveau compte',
      body: html`<form id="uf" class="stack">
        <label class="field">Pseudo<input name="username" value="${user?.username || ''}" required minlength="2" maxlength="32" autocomplete="off" autofocus
          placeholder="ex. dj-max"><span class="hint">Lettres, chiffres, . _ - (sans espace). Sert à se connecter.</span></label>
        <label class="field">${user ? 'Nouveau mot de passe' : 'Mot de passe'}<input type="password" name="password" ${user ? '' : 'required'} minlength="8" autocomplete="new-password"
          placeholder="${user ? 'laisser vide pour ne pas le changer' : '8 caractères minimum'}"></label>
        <fieldset><legend>Rôle</legend><div class="stack" style="gap:10px">
          ${Object.entries(roles).map(([k, label]) => html`<label class="check" style="align-items:flex-start"><input type="radio" name="role" value="${k}" ${(user?.role || 'dj') === k ? 'checked' : ''}>
            <span><b>${label}</b><br><span class="dim small">${ROLE_HELP[k]}</span></span></label>`)}
        </div></fieldset>
      </form>`,
      footer: html`<button class="btn" data-close>Annuler</button><button class="btn primary" form="uf">${user ? 'Enregistrer' : 'Créer le compte'}</button>`,
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { username: f.username.value.trim(), role: f.role.value };
      if (f.password.value) body.password = f.password.value;
      const r = await run(dlg.querySelector('.btn.primary'), () => api(user ? `/users/${user.id}` : '/users', { method: user ? 'PUT' : 'POST', body }),
        user ? 'Compte modifié' : `Compte « ${body.username} » créé`).catch(() => null);
      if (!r) return;
      done = true;
      close();
    });
    dlg.addEventListener('close', () => resolve(done));
  });
}

export default function usersPage(view, { store, topbar }) {
  let data = { users: [], roles: {} };

  topbar.innerHTML = String(html`<button class="btn primary" id="new-user">${icon('plus')} Nouveau compte</button>`);
  $('#new-user', topbar).addEventListener('click', async () => {
    if (await userDialog(data.roles)) load();
  });

  function render() {
    const me = store.me?.id;
    view.innerHTML = String(html`
      <p class="muted" style="margin-top:-8px">Chaque personne se connecte avec son pseudo et son mot de passe. Les connexions et les changements de comptes
        apparaissent dans le Journal.</p>
      <div class="card flush">
        <div class="table-wrap"><table>
          <thead><tr><th>Pseudo</th><th>Rôle</th><th>Dernière connexion</th><th>Créé le</th><th></th></tr></thead>
          <tbody>${data.users.map((u) => html`<tr>
            <td><b>${u.username}</b>${u.id === me ? html` <span class="badge">vous</span>` : ''}</td>
            <td><span class="badge ${ROLE_BADGE[u.role]}">${data.roles[u.role] || u.role}</span></td>
            <td class="dim small">${u.lastLogin ? fmtDateTime(u.lastLogin) : 'jamais'}</td>
            <td class="dim small">${fmtDateTime(u.createdAt).slice(0, 10)}</td>
            <td class="right nowrap">
              <button class="btn sm ghost" data-edit="${u.id}" title="Modifier (pseudo, mot de passe, rôle)">${icon('edit')}</button>
              ${u.id === me ? '' : html`<button class="btn sm ghost danger" data-del="${u.id}" title="Supprimer">${icon('trash')}</button>`}
            </td></tr>`)}</tbody>
        </table></div>
      </div>
      <div class="grid cols-3 mt">${Object.entries(data.roles).map(([k, label]) => html`<div class="card">
        <span class="badge ${ROLE_BADGE[k]}">${label}</span><p class="small muted" style="margin:8px 0 0">${ROLE_HELP[k]}</p></div>`)}</div>`);
  }

  async function load() {
    data = await api('/users');
    render();
  }

  view.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed && await userDialog(data.roles, data.users.find((u) => u.id === Number(ed.dataset.edit)))) load();
    const del = e.target.closest('[data-del]');
    if (del) {
      const u = data.users.find((x) => x.id === Number(del.dataset.del));
      if (!await confirmDialog(`Supprimer le compte « ${u.username} » ?`, 'Cette personne ne pourra plus se connecter. Ses sessions ouvertes sont fermées.', { confirm: 'Supprimer', danger: true })) return;
      await run(del, () => api(`/users/${u.id}`, { method: 'DELETE' }), 'Compte supprimé').catch(() => null);
      load();
    }
  });

  load();
}
