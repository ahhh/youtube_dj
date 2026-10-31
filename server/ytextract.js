// Native YouTube audio extractor: talks to the InnerTube player API the way the
// mobile apps do, picks the best audio-only format, and streams it in ranged
// chunks. No yt-dlp, no signature deciphering: the clients below get plain URLs.

const CLIENTS = [
  {
    name: 'ANDROID_VR',
    num: 28,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
    },
  },
  {
    name: 'IOS',
    num: 5,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
    },
  },
];

const CHUNK = 9 * 1024 * 1024; // googlevideo throttles/403s on unbounded requests

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

async function playerRequest(id, c) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': c.ua,
      'x-youtube-client-name': String(c.num),
      'x-youtube-client-version': c.client.clientVersion,
    },
    body: JSON.stringify({
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      context: { client: { ...c.client, hl: 'en', gl: 'US' } },
    }),
  });
  if (!res.ok) throw new Error(`${c.name}: HTTP ${res.status}`);
  return res.json();
}

// Rank audio-only formats: prefer AAC (m4a) at the highest bitrate so ffmpeg
// has the cleanest source for the mp3 encode; Opus/webm is the fallback.
function pickAudio(formats) {
  const audio = formats.filter((f) => f.url && f.mimeType?.startsWith('audio/'));
  const score = (f) => (f.mimeType.includes('mp4a') ? 1e9 : 0) + (f.bitrate || 0);
  return audio.sort((a, b) => score(b) - score(a))[0];
}

export async function resolveAudio(id) {
  if (!VIDEO_ID.test(id)) throw new Error('invalid video id');
  const errors = [];
  for (const c of CLIENTS) {
    try {
      const j = await playerRequest(id, c);
      const status = j.playabilityStatus?.status;
      if (status !== 'OK') {
        errors.push(`${c.name}: ${status} ${j.playabilityStatus?.reason || ''}`.trim());
        continue;
      }
      const fmt = pickAudio(j.streamingData?.adaptiveFormats || []);
      if (!fmt) {
        errors.push(`${c.name}: no direct audio format`);
        continue;
      }
      return {
        id,
        title: j.videoDetails?.title || id,
        author: j.videoDetails?.author || '',
        durationSec: Number(j.videoDetails?.lengthSeconds) || 0,
        url: fmt.url,
        size: Number(fmt.contentLength) || 0,
        mime: fmt.mimeType,
        ua: c.ua,
      };
    } catch (e) {
      errors.push(`${c.name}: ${e.message}`);
    }
  }
  throw new Error(`could not resolve audio (${errors.join('; ')})`);
}

// Async generator of Buffers covering the whole stream, fetched in ranged chunks.
export async function* streamAudio(info, signal) {
  const total = info.size;
  if (!total) throw new Error('unknown content length');
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total) - 1;
    const res = await fetch(`${info.url}&range=${start}-${end}`, {
      headers: { 'user-agent': info.ua },
      signal,
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    yield { chunk: Buffer.from(await res.arrayBuffer()), received: end + 1, total };
  }
}
