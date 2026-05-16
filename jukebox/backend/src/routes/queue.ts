import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import { getQueue, addItem, removeItem, jumpItem, markCurrentDone } from '../db/queue';
import { getVideoInfo } from '../services/youtube';

export function buildQueueRouter(io: Server): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(getQueue());
  });

  router.post('/', async (req: Request, res: Response) => {
    const { video_id, requester } = req.body as { video_id?: string; requester?: string };
    if (!video_id) { res.status(400).json({ error: 'video_id required' }); return; }

    const info = await getVideoInfo(video_id).catch(() => null);
    if (!info) { res.status(404).json({ error: 'Video not found' }); return; }

    const item = addItem({ ...info, requester: requester ?? 'anonymous' });
    io.emit('queue:updated', getQueue());
    res.status(201).json(item);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!removeItem(id)) { res.status(404).json({ error: 'Not found or currently playing' }); return; }
    io.emit('queue:updated', getQueue());
    res.json({ ok: true });
  });

  router.post('/:id/jump', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!jumpItem(id)) { res.status(404).json({ error: 'Not found or not waiting' }); return; }
    const queue = getQueue();
    const playing = queue.find(i => i.status === 'playing') ?? null;
    io.emit('queue:updated', queue);
    io.emit('player:state', { action: 'play', item: playing });
    res.json({ ok: true });
  });

  router.post('/player/next', (_req: Request, res: Response) => {
    const next = markCurrentDone();
    const queue = getQueue();
    io.emit('queue:updated', queue);
    io.emit('player:state', next ? { action: 'play', item: next } : { action: 'idle' });
    res.json({ item: next });
  });

  return router;
}
