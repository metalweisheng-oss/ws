import db from './client';

export interface QueueItem {
  id: number;
  video_id: string;
  title: string;
  thumbnail: string;
  duration: number;
  requester: string;
  status: 'waiting' | 'playing' | 'done';
  added_at: number;
}

export interface AddItemInput {
  video_id: string;
  title: string;
  thumbnail: string;
  duration: number;
  requester?: string;
}

export const getQueue = (): QueueItem[] =>
  db.prepare(`SELECT * FROM queue WHERE status != 'done' ORDER BY
    CASE status WHEN 'playing' THEN 0 ELSE 1 END, id ASC`).all() as QueueItem[];

export const addItem = (input: AddItemInput): { item: QueueItem; autoPlaying: boolean } => {
  const hasPlaying = !!db.prepare(`SELECT 1 FROM queue WHERE status = 'playing'`).get();
  const hasWaiting = !!db.prepare(`SELECT 1 FROM queue WHERE status = 'waiting'`).get();
  // Auto-play if nothing is currently playing or waiting
  const autoPlay = !hasPlaying && !hasWaiting;

  const result = db.prepare(`
    INSERT INTO queue (video_id, title, thumbnail, duration, requester, status)
    VALUES (@video_id, @title, @thumbnail, @duration, @requester, @status)
  `).run({ requester: 'anonymous', ...input, status: autoPlay ? 'playing' : 'waiting' });

  const item = db.prepare('SELECT * FROM queue WHERE id = ?').get(result.lastInsertRowid) as QueueItem;
  return { item, autoPlaying: autoPlay };
};

export const removeItem = (id: number): boolean => {
  const result = db.prepare(`DELETE FROM queue WHERE id = ? AND status != 'playing'`).run(id);
  return result.changes > 0;
};

export const jumpItem = (id: number): boolean => {
  // Mark current playing as done, set target as playing
  const target = db.prepare(`SELECT * FROM queue WHERE id = ? AND status = 'waiting'`).get(id) as QueueItem | undefined;
  if (!target) return false;
  db.transaction(() => {
    db.prepare(`UPDATE queue SET status = 'done' WHERE status = 'playing'`).run();
    db.prepare(`UPDATE queue SET status = 'playing' WHERE id = ?`).run(id);
  })();
  return true;
};

export const markCurrentDone = (): QueueItem | null => {
  db.prepare(`UPDATE queue SET status = 'done' WHERE status = 'playing'`).run();
  const next = db.prepare(`SELECT * FROM queue WHERE status = 'waiting' ORDER BY id ASC LIMIT 1`).get() as QueueItem | undefined;
  if (next) {
    db.prepare(`UPDATE queue SET status = 'playing' WHERE id = ?`).run(next.id);
    return db.prepare('SELECT * FROM queue WHERE id = ?').get(next.id) as QueueItem;
  }
  return null;
};

export const getCurrentPlaying = (): QueueItem | null =>
  (db.prepare(`SELECT * FROM queue WHERE status = 'playing' LIMIT 1`).get() as QueueItem | undefined) ?? null;
