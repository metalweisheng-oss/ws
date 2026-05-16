import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import { getQueue, addItem, removeItem, removeItemByToken, jumpItem, markCurrentDone, getHistory, getPopular } from '../db/queue';
import { getVideoInfo } from '../services/youtube';
import { requireAdmin } from '../middleware/requireAdmin';

export function buildQueueRouter(io: Server): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(getQueue());
  });

  router.get('/history', (_req: Request, res: Response) => {
    res.json(getHistory(40));
  });

  router.get('/popular', (_req: Request, res: Response) => {
    res.json(getPopular(10));
  });

  router.post('/', async (req: Request, res: Response) => {
    const { video_id, requester, owner_token } = req.body as { video_id?: string; requester?: string; owner_token?: string };
    if (!video_id) { res.status(400).json({ error: 'video_id required' }); return; }

    const info = await getVideoInfo(video_id).catch(() => null);
    if (!info) { res.status(404).json({ error: 'Video not found' }); return; }

    const { item, autoPlaying } = addItem({ ...info, requester: requester ?? 'anonymous', owner_token: owner_token ?? undefined });
    const queue = getQueue();
    io.emit('queue:updated', queue);
    if (autoPlaying) io.emit('player:state', { action: 'play', item });
    res.status(201).json(item);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const ownerToken = req.headers['x-owner-token'] as string | undefined;
    const adminPin = req.headers['x-admin-pin'] as string | undefined;

    let removed = false;
    if (ownerToken) {
      removed = removeItemByToken(id, ownerToken);
    } else if (adminPin) {
      const ADMIN_PIN = process.env.ADMIN_PIN ?? '1234';
      if (adminPin !== ADMIN_PIN) { res.status(403).json({ error: 'Invalid PIN' }); return; }
      removed = removeItem(id);
    } else {
      res.status(401).json({ error: 'x-owner-token or x-admin-pin required' }); return;
    }

    if (!removed) { res.status(404).json({ error: 'Not found, not waiting, or token mismatch' }); return; }
    io.emit('queue:updated', getQueue());
    res.json({ ok: true });
  });

  router.post('/:id/jump', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!jumpItem(id)) { res.status(404).json({ error: 'Not found or not waiting' }); return; }
    const queue = getQueue();
    const playing = queue.find(i => i.status === 'playing') ?? null;
    io.emit('queue:updated', queue);
    io.emit('player:state', { action: 'play', item: playing });
    res.json({ ok: true });
  });

  router.post('/player/next', requireAdmin, (_req: Request, res: Response) => {
    const next = markCurrentDone();
    const queue = getQueue();
    io.emit('queue:updated', queue);
    io.emit('player:state', next ? { action: 'play', item: next } : { action: 'idle' });
    res.json({ item: next });
  });

  return router;
}
