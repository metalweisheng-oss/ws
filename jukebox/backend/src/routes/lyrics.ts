import express from 'express';

const router = express.Router();

const NE_HEADERS = {
  'Referer': 'https://music.163.com',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Cookie': 'os=pc; appver=2.9.7',
};

function stripTitle(s: string): string {
  return s.replace(/\s*[[(（【][^\]\)）】]*[\]\)）】]/g, '').trim();
}

async function fromLrcLib(title: string, duration: number): Promise<string | null> {
  const parts = title.split(/ [-－] /);
  const urls: string[] = [];

  if (parts.length >= 2) {
    const artist = encodeURIComponent(stripTitle(parts[0]));
    const track = encodeURIComponent(stripTitle(parts.slice(1).join(' - ')));
    urls.push(`https://lrclib.net/api/get?artist_name=${artist}&track_name=${track}&duration=${duration}`);
    urls.push(`https://lrclib.net/api/search?q=${track}+${artist}&limit=3`);
  }
  urls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(stripTitle(title))}&limit=3`);

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const items: any[] = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.syncedLyrics) return item.syncedLyrics as string;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function fromNetease(title: string): Promise<string | null> {
  try {
    // Step 1: search song
    const searchRes = await fetch('https://music.163.com/api/search/get', {
      method: 'POST',
      headers: { ...NE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `s=${encodeURIComponent(title)}&type=1&limit=5&offset=0`,
      signal: AbortSignal.timeout(6000),
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json() as any;
    const songs: any[] = searchData?.result?.songs ?? [];
    if (!songs.length) return null;

    // Step 2: fetch LRC
    const id = songs[0].id as number;
    const lyricsRes = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=1`, {
      headers: NE_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (!lyricsRes.ok) return null;
    const lyricsData = await lyricsRes.json() as any;
    const lrc = lyricsData?.lrc?.lyric as string | undefined;
    // Reject if it's just a "纯音乐" notice or empty timestamp file
    if (lrc && lrc.includes('[') && !lrc.includes('纯音乐')) return lrc;
  } catch { /* ignore */ }
  return null;
}

router.get('/', async (req, res) => {
  const title = String(req.query.title ?? '').trim();
  const duration = Number(req.query.duration ?? 0);
  if (!title) return res.json({ lrc: null });

  let lrc = await fromLrcLib(title, duration);
  if (!lrc) lrc = await fromNetease(title);

  res.json({ lrc: lrc ?? null });
});

export default router;
