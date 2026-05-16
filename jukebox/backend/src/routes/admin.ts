import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import { requireAdmin } from '../middleware/requireAdmin';

export function buildAdminRouter(io: Server) {
  const router = Router();

  router.post('/verify', (req: Request, res: Response) => {
    const { pin } = req.body as { pin?: string };
    const correct = process.env.ADMIN_PIN ?? '0000';
    if (pin === correct) res.json({ ok: true });
    else res.status(401).json({ error: '密碼錯誤' });
  });

  router.post('/announce', requireAdmin, (req: Request, res: Response) => {
    const { text } = req.body as { text?: string };
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });
    io.emit('tv:announce', { text: text.trim() });
    res.json({ ok: true });
  });

  return router;
}
