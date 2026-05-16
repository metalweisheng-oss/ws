import express from 'express';

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripDecorations(s: string): string {
  // Remove (Official MV), [HD], 【MV】, 「Live」 etc.
  return s.replace(/\s*[[(（【「『][^\]\)）】」』]*[\]\)）】」』]/g, '').trim();
}

function extractBracketContent(s: string): string {
  // Pull text from 【…】「…」brackets (often song name in JP/CN titles)
  const m = s.match(/[【「『]([^】」』]+)[】」』]/);
  return m ? m[1].trim() : '';
}

/** Build ordered list of query strings to try for Kugou */
function buildQueries(title: string): string[] {
  const stripped = stripDecorations(title);
  const parts = stripped.split(/ [-－—] /);
  const queries: string[] = [];

  if (parts.length >= 2) {
    const left = parts[0].trim();
    const right = parts.slice(1).join(' - ').trim();
    // Try each part alone — either could be the song name
    queries.push(right);
    queries.push(left);
    // Then combined
    queries.push(`${left} ${right}`);
  } else {
    queries.push(stripped);
  }

  // Bracket content often contains the song name
  const bracket = extractBracketContent(title);
  if (bracket) queries.unshift(bracket);

  // Deduplicate while preserving order
  return [...new Set(queries.filter(q => q.length > 1))];
}

// ── lrclib.net (English / Japanese) ──────────────────────────────────────────

async function fromLrcLib(title: string, duration: number): Promise<string | null> {
  const queries = buildQueries(title);
  const parts = stripDecorations(title).split(/ [-－—] /);

  const urls: string[] = [];
  if (parts.length >= 2) {
    const artist = encodeURIComponent(parts[0].trim());
    const track = encodeURIComponent(parts.slice(1).join(' - ').trim());
    urls.push(`https://lrclib.net/api/get?artist_name=${artist}&track_name=${track}&duration=${duration}`);
  }
  for (const q of queries.slice(0, 2)) {
    urls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}&limit=3`);
  }

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

// ── 酷狗音樂 Kugou ────────────────────────────────────────────────────────────
// Note: Kugou search returns duration in SECONDS; lyrics search needs MILLISECONDS.

const KUGOU_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.kugou.com',
};

async function kugouSearch(keyword: string): Promise<any[]> {
  const res = await fetch(
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=10`,
    { headers: KUGOU_HEADERS, signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data?.data?.info ?? [];
}

async function kugouDownloadLrc(keyword: string, hash: string, durationSec: number): Promise<string | null> {
  // Lyrics search expects duration in milliseconds
  const candRes = await fetch(
    `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&duration=${durationSec * 1000}&hash=${hash}`,
    { headers: KUGOU_HEADERS, signal: AbortSignal.timeout(5000) },
  );
  if (!candRes.ok) return null;
  const candData = await candRes.json() as any;
  const candidates: any[] = candData?.candidates ?? [];
  if (!candidates.length) return null;

  const best = candidates.find((c: any) => c.product_from?.includes('官方')) ?? candidates[0];

  const dlRes = await fetch(
    `http://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${best.accesskey}&fmt=lrc&charset=utf8`,
    { headers: KUGOU_HEADERS, signal: AbortSignal.timeout(5000) },
  );
  if (!dlRes.ok) return null;
  const dlData = await dlRes.json() as any;
  if (dlData.status !== 200 || !dlData.content) return null;

  const lrc = Buffer.from(dlData.content, 'base64').toString('utf8');
  return lrc.includes('[') ? lrc : null;
}

async function fromKugou(title: string, duration: number): Promise<string | null> {
  const queries = buildQueries(title);

  for (const q of queries) {
    try {
      const songs = await kugouSearch(q);
      if (!songs.length) continue;

      // Sort by duration closeness (Kugou duration is in seconds)
      songs.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));

      // Try top 3 closest matches (within 3 minutes tolerance)
      for (const song of songs.slice(0, 3)) {
        if (Math.abs(song.duration - duration) > 180) continue;
        const lrc = await kugouDownloadLrc(q, song.hash, song.duration);
        if (lrc) return lrc;
      }
    } catch { /* try next query */ }
  }
  return null;
}

// ── 網易雲音樂 Netease (fallback) ─────────────────────────────────────────────

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
      body: `s=${encodeURIComponent(stripDecorations(title))}&type=1&limit=5&offset=0`,
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

// ── Route ─────────────────────────────────────────────────────────────────────

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
