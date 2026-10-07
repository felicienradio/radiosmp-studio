// Diffuse un signal de test vers Icecast avec ffmpeg, pour vérifier l'installation.
// Usage : npm run test-source -- [/point-de-montage] [débit-kbps]
import { spawn } from 'node:child_process';
import { loadSettings } from '../server/settings.js';

const ice = loadSettings().icecast;
const mount = process.argv[2] || ice.mounts[0]?.name || '/live';
const bitrate = process.argv[3] || '128';
const conf = ice.mounts.find((m) => m.name === mount);
const user = conf?.password ? conf.username || 'source' : 'source';
const password = conf?.password || ice.sourcePassword;
const host = ice.managed ? `127.0.0.1:${ice.port}` : ice.apiUrl.replace(/^https?:\/\//, '');

const titles = ['Flux - Signal de test', 'Flux - La 440', 'Flux - Le Bip Final', 'Flux - Onde Sinusoïdale'];
let n = 0;

console.log(`Diffusion d'un signal de test vers http://${host}${mount} (${bitrate} kbps). Ctrl+C pour arrêter.`);
const ff = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-re',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100,volume=0.2',
  '-ac', '2', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`,
  '-content_type', 'audio/mpeg', '-ice_name', conf?.streamName || 'Flux test', '-ice_genre', 'Test',
  '-f', 'mp3', `icecast://${user}:${encodeURIComponent(password)}@${host}${mount}`,
], { stdio: 'inherit' });
ff.on('error', (err) => {
  console.error(`ffmpeg introuvable (${err.message}). Installez-le : winget install Gyan.FFmpeg`);
  process.exit(1);
});
ff.on('exit', (code) => process.exit(code ?? 0));

// Change le titre toutes les 30 s, comme le ferait un logiciel de diffusion
const auth = 'Basic ' + Buffer.from(`${ice.adminUser}:${ice.adminPassword}`).toString('base64');
async function setTitle() {
  const song = titles[n++ % titles.length];
  const url = `http://${host}/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${encodeURIComponent(song)}`;
  try {
    await fetch(url, { method: 'POST', headers: { Authorization: auth } });
    console.log(`Titre : ${song}`);
  } catch {}
}
setTimeout(setTitle, 3000);
setInterval(setTitle, 30_000);
process.on('SIGINT', () => ff.kill());
