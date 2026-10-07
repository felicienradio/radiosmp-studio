// Mises à jour depuis GitHub. Le dashboard tourne sans droits root : il dépose une demande dans
// data/update/request, que systemd (flux-update.path) transmet à scripts/update.sh lancé en root.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DATA_DIR } from './settings.js';

const UPD = path.join(DATA_DIR, 'update');
const read = (f) => {
  try {
    return fs.readFileSync(path.join(UPD, f), 'utf8');
  } catch {
    return '';
  }
};

export function updateSupported() {
  return process.platform === 'linux' && fs.existsSync('/etc/systemd/system/flux-update.path');
}

export function currentVersion() {
  let v = '';
  try { v = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch {}
  if (/^[0-9a-f]{7,40}$/.test(v)) return v;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function repoPage() {
  let url = 'https://github.com/felicienradio/radiosmp-studio.git';
  try {
    url = fs.readFileSync('/etc/flux/update.env', 'utf8').match(/^REPO_URL=(.+)$/m)?.[1] || url;
  } catch {}
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return m ? `https://github.com/${m[1]}` : null;
}

export function updateStatus() {
  const status = Object.fromEntries(read('status.env').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
  const commits = read('commits.tsv').split('\n').filter(Boolean).map((l) => {
    const [hash, date, ...subject] = l.split('\t');
    return { hash, date, subject: subject.join('\t') };
  });
  const repo = repoPage();
  return {
    supported: updateSupported(),
    platform: process.platform,
    version: currentVersion(),
    state: status.state || 'unknown',
    latest: status.latest || null,
    error: status.error || null,
    checkedAt: status.checked_at ? Number(status.checked_at) * 1000 : null,
    pending: fs.existsSync(path.join(UPD, 'request')),
    commits,
    deployKey: read('deploy_key.pub').trim() || null,
    repo,
    deployKeysUrl: repo ? `${repo}/settings/keys/new` : null,
    log: read('update.log').split('\n').slice(-80).join('\n'),
  };
}

export function requestUpdate(mode) {
  if (!updateSupported()) {
    throw Object.assign(new Error('Les mises à jour automatiques sont disponibles sur l\'installation Linux (conteneur LXC).'), { status: 400 });
  }
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(path.join(UPD, 'request'), mode === 'update' ? 'update' : 'check');
}
