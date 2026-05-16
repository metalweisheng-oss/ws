import { Router, Request, Response } from 'express';

const router = Router();

router.post('/verify', (req: Request, res: Response) => {
  const { pin } = req.body as { pin?: string };
  const correct = process.env.ADMIN_PIN ?? '0000';
  if (pin === correct) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: '密碼錯誤' });
  }
});

export default router;
