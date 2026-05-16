import express from 'express';

const router = express.Router();

router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 1) return res.json([]);

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}&hl=zh-TW`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jukebox/1.0)' },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return res.json([]);
    const data = await r.json() as any[];
    const suggestions: string[] = Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
    res.json(suggestions);
  } catch {
    res.json([]);
  }
});

export default router;
