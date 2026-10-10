// Mot de passe perdu : crée ou réinitialise un compte administrateur.
//   node scripts/reset-admin.js <pseudo> <nouveau-mot-de-passe>
// Dans le conteneur LXC : cd /opt/flux && runuser -u flux -- node scripts/reset-admin.js admin MonNouveauMotDePasse
import { findUser, createUser, updateUser } from '../server/users.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage : node scripts/reset-admin.js <pseudo> <nouveau-mot-de-passe>');
  process.exit(1);
}
try {
  const u = findUser(username);
  const r = u ? updateUser(u.id, { password, role: 'admin' }) : createUser({ username, password, role: 'admin' });
  console.log(`${u ? 'Mot de passe réinitialisé' : 'Compte créé'} : ${r.username} (administrateur)`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
