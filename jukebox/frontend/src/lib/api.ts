const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

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

export interface VideoInfo {
  video_id: string;
  title: string;
  thumbnail: string;
  duration: number;
}

export async function fetchQueue(): Promise<QueueItem[]> {
  const res = await fetch(`${BASE}/api/queue`);
  return res.json();
}

export async function addToQueue(video_id: string, requester?: string): Promise<QueueItem> {
  const res = await fetch(`${BASE}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id, requester }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function removeFromQueue(id: number): Promise<void> {
  await fetch(`${BASE}/api/queue/${id}`, { method: 'DELETE' });
}

export async function jumpToItem(id: number): Promise<void> {
  await fetch(`${BASE}/api/queue/${id}/jump`, { method: 'POST' });
}

export async function nextSong(): Promise<QueueItem | null> {
  const res = await fetch(`${BASE}/api/queue/player/next`, { method: 'POST' });
  const data = await res.json();
  return data.item ?? null;
}

export async function searchYouTube(q: string): Promise<VideoInfo[]> {
  const res = await fetch(`${BASE}/api/youtube/search?q=${encodeURIComponent(q)}`);
  return res.json();
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
