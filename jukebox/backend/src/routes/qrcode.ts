import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const url = (req.query.url as string) || `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}`;
  try {
    const png = await QRCode.toBuffer(url, { width: 300, margin: 2 });
    res.set('Content-Type', 'image/png').send(png);
  } catch {
    res.status(500).json({ error: 'QR code generation failed' });
  }
});

export default router;
