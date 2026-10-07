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

// Type d'appareil, dans l'esprit des rapports d'audience radio
const DEVICES = [
  [/curl|Wget|python|Go-http-client|okhttp|Java\/|libwww|HttpClient|bot\b|spider|crawler|Streamripper|Lavf|FFmpeg|Icecast|Liquidsoap/i, 'Script'],
  [/AlexaMediaPlayer|Echo\b|Sonos|Google-?Home|Google Nest|Bose|HomePod|audioOS|Yamaha|Denon|Marantz|Bluesound|Frontier Silicon|Libratone|SqueezePlay|Squeezebox/i, 'Enceinte connectée'],
  [/Android Auto|CarPlay|Tesla|QtCarBrowser|Mercedes|BMW|Volvo/i, 'Voiture'],
  [/SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|Roku|AppleTV|tvOS|AFT[A-Z]|CrKey|Android TV|GoogleTV|Kodi|XBMC|PlayStation|Xbox|Freebox|Bbox|Livebox|SHIELD/i, 'TV / box'],
  [/iPad|Tablet|Kindle|Silk\/|PlayBook|SM-T\d|Nexus (7|9|10)\b/i, 'Tablette'],
  [/iPhone|iPod|Mobile|Windows Phone|BlackBerry|Opera Mini|RadioDroid|ExoPlayer|AndroidX?Media|stagefright|Dalvik|CFNetwork|Android/i, 'Smartphone'],
  [/Windows|Macintosh|Mac OS X|X11|Linux|CrOS|VLC|Winamp|foobar2000|AIMP|MusicBee|iTunes|NSPlayer|WMFSDK|Clementine|Strawberry|Rhythmbox|Audacious|mpv|MPlayer/i, 'PC'],
];

export function parseUserAgent(ua = '') {
  const player = PLAYERS.find(([re]) => re.test(ua))?.[1] || (ua ? 'Autre' : 'Inconnu');
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] || 'Autre';
  const device = DEVICES.find(([re]) => re.test(ua))?.[1] || 'Inconnu';
  return { player, os, device };
}
