'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchQueue, QueueItem } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import SearchBar from '@/components/SearchBar';
import QueueList from '@/components/QueueList';

export default function QueuePage() {
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

  return (
    <main className="max-w-lg mx-auto p-4 flex flex-col gap-6 min-h-screen">
      <h1 className="text-2xl font-bold text-center">🎵 點歌</h1>
      <SearchBar onAdded={refresh} />
      <div>
        <h2 className="text-sm font-semibold text-gray-400 mb-2">目前歌單</h2>
        <QueueList queue={queue} onUpdate={refresh} />
      </div>
    </main>
  );
}
