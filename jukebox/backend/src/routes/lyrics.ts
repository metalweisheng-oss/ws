import express from 'express';

const router = express.Router();

function stripTitle(s: string): string {
  return s.replace(/\s*[[(（【][^\]\)）】]*[\]\)）】]/g, '').trim();
}

// ── lrclib.net (English / Japanese) ──────────────────────────────────────────

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

// ── 酷狗音樂 Kugou (Chinese — best LRC coverage) ────────────────────────────

async function fromKugou(title: string, duration: number): Promise<string | null> {
  // Build search queries: try artist+track split, then full title, then stripped title
  const parts = title.split(/ [-－] /);
  const queries: string[] = [];
  if (parts.length >= 2) {
    queries.push(`${stripTitle(parts[0])} ${stripTitle(parts.slice(1).join(' - '))}`);
  }
  queries.push(stripTitle(title));
  if (title !== stripTitle(title)) queries.push(title);

  for (const q of queries) {
    try {
      const searchRes = await fetch(
        `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=5`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json() as any;
      const songs: any[] = searchData?.data?.info ?? [];
      if (!songs.length) continue;

      // Pick best match: prefer duration-closest song
      const durationMs = duration * 1000;
      songs.sort((a, b) => Math.abs(a.duration - durationMs) - Math.abs(b.duration - durationMs));
      const song = songs[0];
      const hash: string = song.hash;
      const songDuration: number = song.duration; // ms

      // Get lyric candidates for this hash
      const candRes = await fetch(
        `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(q)}&duration=${songDuration}&hash=${hash}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!candRes.ok) continue;
      const candData = await candRes.json() as any;
      const candidates: any[] = candData?.candidates ?? [];
      if (!candidates.length) continue;

      // Prefer official lyrics (product_from contains 官方)
      const best = candidates.find((c: any) => c.product_from?.includes('官方')) ?? candidates[0];

      // Download LRC (base64 encoded)
      const dlRes = await fetch(
        `http://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${best.accesskey}&fmt=lrc&charset=utf8`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!dlRes.ok) continue;
      const dlData = await dlRes.json() as any;
      if (dlData.status !== 200 || !dlData.content) continue;

      const lrc = Buffer.from(dlData.content, 'base64').toString('utf8');
      if (lrc.includes('[') && lrc.includes(']')) return lrc;
    } catch { /* try next query */ }
  }
  return null;
}

// ── 網易雲音樂 Netease (fallback, limited for Taiwanese artists) ───────────────

async function fromNetease(title: string): Promise<string | null> {
  const NE_HEADERS = {
    'Referer': 'https://music.163.com',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Cookie': 'os=pc; appver=2.9.7',
  };
  try {
    const searchRes = await fetch('https://music.163.com/api/search/get', {
      method: 'POST',
      headers: { ...NE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `s=${encodeURIComponent(stripTitle(title))}&type=1&limit=5&offset=0`,
      signal: AbortSignal.timeout(6000),
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json() as any;
    const songs: any[] = searchData?.result?.songs ?? [];
    if (!songs.length) return null;

    const id = songs[0].id as number;
    const lyricsRes = await fetch(
      `https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=1`,
      { headers: NE_HEADERS, signal: AbortSignal.timeout(6000) },
    );
    if (!lyricsRes.ok) return null;
    const lyricsData = await lyricsRes.json() as any;
    const lrc = lyricsData?.lrc?.lyric as string | undefined;
    if (lrc && lrc.includes('[') && !lrc.includes('纯音乐')) return lrc;
  } catch { /* ignore */ }
  return null;
}

// ── Route ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const title = String(req.query.title ?? '').trim();
  const duration = Number(req.query.duration ?? 0);
  if (!title) return res.json({ lrc: null });

  let lrc = await fromLrcLib(title, duration);
  if (!lrc) lrc = await fromKugou(title, duration);
  if (!lrc) lrc = await fromNetease(title);

  res.json({ lrc: lrc ?? null });
});

export default router;
