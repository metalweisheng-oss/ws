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

export async function verifyAdminPin(pin: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  return res.ok;
}

export async function removeFromQueue(id: number, pin: string): Promise<void> {
  await fetch(`${BASE}/api/queue/${id}`, {
    method: 'DELETE',
    headers: { 'x-admin-pin': pin },
  });
}

export async function jumpToItem(id: number, pin: string): Promise<void> {
  await fetch(`${BASE}/api/queue/${id}/jump`, {
    method: 'POST',
    headers: { 'x-admin-pin': pin },
  });
}

export async function nextSong(pin?: string): Promise<QueueItem | null> {
  const headers: Record<string, string> = {};
  if (pin) headers['x-admin-pin'] = pin;
  const res = await fetch(`${BASE}/api/queue/player/next`, { method: 'POST', headers });
  const data = await res.json();
  return data.item ?? null;
}

export async function searchYouTube(q: string): Promise<VideoInfo[]> {
  const res = await fetch(`${BASE}/api/youtube/search?q=${encodeURIComponent(q)}`);
  return res.json();
}

export async function fetchSuggestions(q: string): Promise<string[]> {
  if (q.trim().length < 1) return [];
  try {
    const res = await fetch(`${BASE}/api/suggestions?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// Supports: youtu.be/ID, youtube.com/watch?v=ID, /shorts/ID, /embed/ID
export function extractYouTubeId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0] || null;
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const parts = url.pathname.split('/');
      const idx = parts.findIndex(p => p === 'shorts' || p === 'embed' || p === 'v');
      if (idx !== -1) return parts[idx + 1] || null;
    }
  } catch {
    // not a URL
  }
  return null;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface LrcLine {
  time: number; // seconds
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/\[(\d+):(\d+)[.:,](\d{1,3})\](.*)/);
    if (!m) continue;
    const text = m[4].trim();
    if (!text) continue;
    // centiseconds: pad to 2 digits so [00:12.3] and [00:12.34] both work
    const cs = parseInt(m[3].padEnd(2, '0').slice(0, 2));
    lines.push({ time: parseInt(m[1]) * 60 + parseInt(m[2]) + cs / 100, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

export async function fetchLyrics(title: string, duration: number): Promise<LrcLine[]> {
  try {
    const res = await fetch(`${BASE}/api/lyrics?title=${encodeURIComponent(title)}&duration=${duration}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (data.lrc) return parseLrc(data.lrc);
  } catch { /* ignore */ }
  return [];
}
