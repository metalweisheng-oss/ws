import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const pin = req.headers['x-admin-pin'] as string | undefined;
  const correct = process.env.ADMIN_PIN ?? '0000';
  if (pin === correct) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
