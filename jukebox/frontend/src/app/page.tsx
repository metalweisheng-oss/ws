'use client';
import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { fetchQueue, QueueItem } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import SearchBar from '@/components/SearchBar';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

export default function Home() {
  const qrUrl = `${BACKEND_URL}/api/qrcode`;
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const refresh = useCallback(() => {
    fetchQueue().then(setQueue).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    return () => { socket.off('queue:updated'); };
  }, [refresh]);

  const playing = queue.find(i => i.status === 'playing');
  const waiting = queue.filter(i => i.status === 'waiting');

  return (
    <main className="min-h-screen flex flex-col items-center gap-8 p-6 pt-10 max-w-lg mx-auto">
      <h1 className="text-3xl font-bold">🎵 點歌系統</h1>

      {/* Search */}
      <div className="w-full">
        <SearchBar onAdded={refresh} />
      </div>

      {/* Now playing */}
      {playing && (
        <div className="w-full bg-red-900/30 border border-red-500/40 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-red-400 text-xs font-bold flex-shrink-0">NOW PLAYING</span>
          <span className="text-sm truncate flex-1">{playing.title}</span>
        </div>
      )}

      {/* Queue preview */}
      {waiting.length > 0 && (
        <div className="w-full">
          <p className="text-xs text-gray-500 mb-2">接下來 ({waiting.length} 首)</p>
          <ul className="flex flex-col gap-1.5">
            {waiting.slice(0, 5).map((item, idx) => (
              <li key={item.id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 text-sm">
                <span className="text-gray-500 w-4 text-center flex-shrink-0">{idx + 1}</span>
                <span className="truncate flex-1">{item.title}</span>
                <span className="text-gray-500 text-xs flex-shrink-0">{item.requester}</span>
              </li>
            ))}
          </ul>
          {waiting.length > 5 && (
            <p className="text-xs text-gray-500 mt-1.5 text-center">還有 {waiting.length - 5} 首…</p>
          )}
        </div>
      )}

      {/* Nav links */}
      <div className="flex gap-3 w-full">
        <Link
          href="/queue"
          className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm font-semibold text-center transition-colors"
        >
          完整歌單
        </Link>
        <Link
          href="/tv"
          className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm font-semibold text-center transition-colors"
        >
          TV 畫面
        </Link>
      </div>

      {/* QR Code */}
      <div className="bg-white rounded-2xl p-3 flex flex-col items-center gap-1 shadow-xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrUrl} alt="點歌 QR Code" width={160} height={160} />
        <p className="text-gray-700 font-semibold text-xs">手機掃碼點歌</p>
      </div>
    </main>
  );
}
