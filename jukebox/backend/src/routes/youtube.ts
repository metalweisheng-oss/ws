import { Router, Request, Response } from 'express';
import { searchVideos } from '../services/youtube';

const router = Router();

router.get('/search', async (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  const results = await searchVideos(q, 10).catch(() => []);
  res.json(results);
});

export default router;
