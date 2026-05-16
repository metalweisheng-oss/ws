'use client';
import { useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import { fetchQueue, nextSong, QueueItem, formatDuration } from '@/lib/api';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export default function TVPage() {
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [ready, setReady] = useState(false);
  const [qrOpen, setQrOpen] = useState(true);

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT?.Player) { setReady(true); return; }
    window.onYouTubeIframeAPIReady = () => setReady(true);
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }, []);

  // Init player after API ready
  useEffect(() => {
    if (!ready || !playerDivRef.current || playerRef.current) return;
    playerRef.current = new window.YT.Player(playerDivRef.current, {
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, controls: 1, rel: 0 },
      events: {
        onStateChange: (e: any) => {
          if (e.data === 0) nextSong().catch(() => {});
        },
      },
    });
  }, [ready]);

  // Load video when current changes
  useEffect(() => {
    if (!playerRef.current || !current) return;
    playerRef.current.loadVideoById(current.video_id);
  }, [current]);

  // Socket + initial fetch
  useEffect(() => {
    fetchQueue().then(q => {
      setQueue(q);
      setCurrent(q.find(i => i.status === 'playing') ?? null);
    });

    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    socket.on('player:state', (data: { action: 'play' | 'idle'; item?: QueueItem }) => {
      if (data.action === 'play' && data.item) {
        setCurrent(data.item);
      } else {
        setCurrent(null);
        playerRef.current?.stopVideo?.();
      }
    });
    return () => {
      socket.off('queue:updated');
      socket.off('player:state');
    };
  }, []);

  const waiting = queue.filter(i => i.status === 'waiting');
  const qrUrl = `${BACKEND_URL}/api/qrcode`;

  return (
    <div className="min-h-screen bg-black flex flex-col relative">
      {/* Player */}
      <div className="flex-1 relative">
        {current ? (
          <div ref={playerDivRef} id="yt-player" className="w-full h-full min-h-[60vh]" />
        ) : (
          <div className="flex items-center justify-center min-h-[60vh] text-gray-600 text-2xl">
            等待點歌中...
          </div>
        )}
      </div>

      {/* Now playing bar */}
      {current && (
        <div className="bg-gray-900 px-4 py-2 flex items-center gap-3">
          <span className="text-red-400 text-sm font-bold flex-shrink-0">NOW PLAYING</span>
          <span className="text-sm flex-1 truncate">{current.title}</span>
          <span className="text-gray-400 text-xs flex-shrink-0">{formatDuration(current.duration)}</span>
        </div>
      )}

      {/* Queue strip */}
      {waiting.length > 0 && (
        <div className="bg-gray-900 border-t border-gray-800 px-4 py-2">
          <p className="text-xs text-gray-500 mb-1">接下來 ({waiting.length} 首)</p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {waiting.slice(0, 10).map((item, idx) => (
              <div key={item.id} className="flex-shrink-0 w-32 text-center">
                <img src={item.thumbnail} alt={item.title} className="w-32 h-18 object-cover rounded mb-1" />
                <p className="text-xs line-clamp-2 text-gray-300">{idx + 1}. {item.title}</p>
                <p className="text-xs text-gray-500">{item.requester}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QR Code overlay — bottom-right corner */}
      <div className="absolute bottom-24 right-4 flex flex-col items-center gap-1">
        {qrOpen ? (
          <div className="bg-white rounded-xl p-2 shadow-2xl flex flex-col items-center gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrUrl} alt="點歌 QR Code" width={120} height={120} className="rounded" />
            <p className="text-gray-800 text-xs font-semibold">掃碼點歌</p>
            <button
              onClick={() => setQrOpen(false)}
              className="text-gray-400 text-xs hover:text-gray-600 leading-none"
            >
              收起
            </button>
          </div>
        ) : (
          <button
            onClick={() => setQrOpen(true)}
            className="bg-white/90 hover:bg-white text-gray-800 text-xs font-semibold px-3 py-2 rounded-lg shadow-lg transition-colors"
          >
            📱 點歌 QR
          </button>
        )}
      </div>
    </div>
  );
}
