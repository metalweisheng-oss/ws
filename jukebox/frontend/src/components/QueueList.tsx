'use client';
import Image from 'next/image';
import { QueueItem, removeFromQueue, jumpToItem, formatDuration } from '@/lib/api';

interface Props {
  queue: QueueItem[];
  onUpdate: () => void;
  adminPin?: string;
}

export default function QueueList({ queue, onUpdate, adminPin }: Props) {
  if (!queue.length) {
    return <p className="text-center text-gray-500 py-8">歌單是空的，快來點歌！</p>;
  }

  const isAdmin = !!adminPin;

  const handle = async (action: () => Promise<void>) => {
    await action();
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
            <p className="text-xs text-gray-400">
              {item.requester} · {formatDuration(item.duration)}
            </p>
          </div>
          {isAdmin && item.status === 'waiting' && (
            <div className="flex gap-1 flex-shrink-0">
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
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
