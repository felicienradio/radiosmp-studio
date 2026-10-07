// Identification du lecteur et du système à partir du User-Agent des auditeurs.
// L'ordre compte : les règles les plus spécifiques d'abord.
const PLAYERS = [
  [/AlexaMediaPlayer|Echo\b/i, 'Amazon Alexa'],
  [/Sonos/i, 'Sonos'],
  [/CrKey|Chromecast|GoogleCast/i, 'Chromecast'],
  [/Google-?Home|Google Nest/i, 'Google Home'],
  [/TuneIn/i, 'TuneIn'],
  [/radio\.?garden/i, 'Radio Garden'],
  [/RadioDroid/i, 'RadioDroid'],
  [/Radioline/i, 'Radioline'],
  [/myTuner/i, 'myTuner'],
  [/Roku/i, 'Roku'],
  [/Kodi|XBMC/i, 'Kodi'],
  [/VLC|LibVLC/i, 'VLC'],
  [/Winamp|Nullsoft/i, 'Winamp'],
  [/foobar2000/i, 'foobar2000'],
  [/AIMP/i, 'AIMP'],
  [/MusicBee/i, 'MusicBee'],
  [/Clementine|Strawberry/i, 'Clementine / Strawberry'],
  [/Rhythmbox/i, 'Rhythmbox'],
  [/Audacious/i, 'Audacious'],
  [/mpv/i, 'mpv'],
  [/MPlayer/i, 'MPlayer'],
  [/iTunes/i, 'iTunes'],
  [/AppleCoreMedia|AVFoundation/i, 'Apple (lecteur natif)'],
  [/NSPlayer|Windows-Media-Player|WMFSDK/i, 'Windows Media Player'],
  [/ExoPlayer|AndroidX?Media|stagefright/i, 'Android (lecteur natif)'],
  [/Streamripper/i, 'Streamripper'],
  [/Icecast|Shoutcast|Liquidsoap|butt|Mixxx/i, 'Relais / encodeur'],
  [/Lavf|FFmpeg/i, 'FFmpeg'],
  [/curl|Wget|python-requests|Go-http-client|okhttp/i, 'Robot / script'],
  [/Edg\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/SamsungBrowser/i, 'Samsung Internet'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\/|Chromium\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
];

const SYSTEMS = [
  [/Windows/i, 'Windows'],
  [/iPhone|iPad|iPod|iOS/i, 'iOS'],
  [/Android/i, 'Android'],
  [/Mac OS X|Macintosh|Darwin/i, 'macOS'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux|X11/i, 'Linux'],
];

export function parseUserAgent(ua = '') {
  const player = PLAYERS.find(([re]) => re.test(ua))?.[1] || (ua ? 'Autre' : 'Inconnu');
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] || 'Autre';
  return { player, os };
}
