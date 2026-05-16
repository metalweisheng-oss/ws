'use client';
import Image from 'next/image';
import { useState, useEffect } from 'react';
import { QueueItem, removeFromQueue, removeOwnSong, getMySongIds, jumpToItem, formatDuration } from '@/lib/api';

interface Props {
  queue: QueueItem[];
  onUpdate: () => void;
  adminPin?: string;
}

export default function QueueList({ queue, onUpdate, adminPin }: Props) {
  const [mySongIds, setMySongIds] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState<number | null>(null);

  useEffect(() => {
    setMySongIds(getMySongIds());
  }, [queue]);

  if (!queue.length) {
    return <p className="text-center text-gray-500 py-8">歌單是空的，快來點歌！</p>;
  }

  const isAdmin = !!adminPin;

  const handle = async (action: () => Promise<void>) => {
    await action();
    onUpdate();
  };

  const handleRemoveOwn = async (id: number) => {
    setRemoving(id);
    await removeOwnSong(id).catch(() => null);
    setRemoving(null);
    onUpdate();
  };

  return (
    <ul className="flex flex-col gap-2">
      {queue.map((item, idx) => (
        <li
          key={item.id}
          className={`flex gap-3 rounded-lg p-2 items-center ${
            item.status === 'playing' ? 'bg-red-900/40 ring-1 ring-red-500' : 'bg-gray-800'
          }`}
        >
          <span className="w-6 text-center text-xs text-gray-400 flex-shrink-0">
            {item.status === 'playing' ? '▶' : idx + 1}
          </span>
          <Image src={item.thumbnail} alt={item.title} width={64} height={36} className="rounded object-cover flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium line-clamp-1">{item.title}</p>
            <p className="text-xs text-gray-400">{formatDuration(item.duration)}</p>
          </div>
          {item.status === 'waiting' && (
            <div className="flex gap-1 flex-shrink-0">
              {isAdmin && (
                <>
                  <button
                    onClick={() => handle(() => jumpToItem(item.id, adminPin))}
                    className="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 rounded text-xs transition-colors"
                    title="立即播放"
                  >
                    跳播
                  </button>
                  <button
                    onClick={() => handle(() => removeFromQueue(item.id, adminPin))}
                    className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs transition-colors"
                    title="移除"
                  >
                    ✕
                  </button>
                </>
              )}
              {!isAdmin && mySongIds.has(item.id) && (
                <button
                  onClick={() => handleRemoveOwn(item.id)}
                  disabled={removing === item.id}
                  className="px-2 py-1 rounded text-xs text-gray-400 hover:text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-40"
                  title="取消這首歌"
                >
                  {removing === item.id ? '…' : '✕'}
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
