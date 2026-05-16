'use client';
import { useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import { fetchQueue, nextSong, fetchLyrics, QueueItem, LrcLine, formatDuration } from '@/lib/api';

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
  const currentRef = useRef<QueueItem | null>(null);
  const adminPinRef = useRef<string>('');
  const lyricIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [qrOpen, setQrOpen] = useState(true);

  const [lrcLines, setLrcLines] = useState<LrcLine[]>([]);
  const [lyricIdx, setLyricIdx] = useState(-1);
  const [showLyrics, setShowLyrics] = useState(true);
  const [karaokeMode, setKaraokeMode] = useState(false);

  const setCurrentBoth = (item: QueueItem | null) => {
    currentRef.current = item;
    setCurrent(item);
    setBlocked(false);
  };

  // Load YouTube IFrame API once
  useEffect(() => {
    adminPinRef.current = sessionStorage.getItem('adminPin') ?? '';

    const init = () => {
      if (playerRef.current) return;
      playerRef.current = new window.YT.Player(playerDivRef.current!, {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 1, rel: 0 },
        events: {
          onReady: () => {
            setPlayerReady(true);
            if (currentRef.current) {
              playerRef.current.loadVideoById(currentRef.current.video_id);
            }
          },
          onStateChange: (e: any) => {
            if (e.data === 0) {
              nextSong(adminPinRef.current || undefined).catch(() => {});
            }
            if (e.data === -1 && currentRef.current) {
              setTimeout(() => {
                if (playerRef.current?.getPlayerState() === -1) setBlocked(true);
              }, 1500);
            }
            if (e.data === 1) setBlocked(false);
          },
        },
      });
    };

    if (window.YT?.Player) {
      init();
    } else {
      window.onYouTubeIframeAPIReady = init;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load video when current or playerReady changes
  useEffect(() => {
    if (!playerReady || !playerRef.current || !current) return;
    playerRef.current.loadVideoById(current.video_id);
  }, [current, playerReady]);

  // Fetch lyrics when current song changes
  useEffect(() => {
    setLrcLines([]);
    setLyricIdx(-1);
    if (!current) return;
    fetchLyrics(current.title, current.duration).then(setLrcLines);
  }, [current]);

  // Track playback position and sync lyric index
  useEffect(() => {
    if (lyricIntervalRef.current) clearInterval(lyricIntervalRef.current);
    if (!lrcLines.length) return;
    lyricIntervalRef.current = setInterval(() => {
      if (typeof playerRef.current?.getCurrentTime !== 'function') return;
      const t: number = playerRef.current.getCurrentTime();
      let idx = -1;
      for (let i = 0; i < lrcLines.length; i++) {
        if (lrcLines[i].time <= t) idx = i;
        else break;
      }
      setLyricIdx(idx);
    }, 300);
    return () => { if (lyricIntervalRef.current) clearInterval(lyricIntervalRef.current); };
  }, [lrcLines]);

  // Socket + initial fetch
  useEffect(() => {
    fetchQueue().then(q => {
      setQueue(q);
      setCurrentBoth(q.find(i => i.status === 'playing') ?? null);
    });

    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    socket.on('player:state', (data: { action: 'play' | 'idle'; item?: QueueItem }) => {
      if (data.action === 'play' && data.item) {
        setCurrentBoth(data.item);
      } else {
        setCurrentBoth(null);
        playerRef.current?.stopVideo?.();
      }
    });
    return () => {
      socket.off('queue:updated');
      socket.off('player:state');
    };
  }, []);

  const handleUnblock = () => {
    setBlocked(false);
    playerRef.current?.playVideo?.();
  };

  const waiting = queue.filter(i => i.status === 'waiting');
  const qrUrl = `${BACKEND_URL}/api/qrcode`;

  const prevLine = lyricIdx > 0 ? lrcLines[lyricIdx - 1] : null;
  const curLine = lyricIdx >= 0 ? lrcLines[lyricIdx] : null;
  const nextLine = lyricIdx >= 0 && lyricIdx < lrcLines.length - 1 ? lrcLines[lyricIdx + 1] : null;

  return (
    <div className="h-screen bg-black flex flex-col relative">
      {/* Player area */}
      <div className="flex-1 relative min-h-0">
        {/* Outer wrapper controls visibility — visibility inherits to the YouTube iframe inside */}
        <div
          className="absolute inset-0"
          style={{ visibility: current ? 'visible' : 'hidden' }}
        >
          <div ref={playerDivRef} id="yt-player" style={{ width: '100%', height: '100%' }} />
        </div>

        {/* Idle state */}
        {!current && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-gray-600">
            <p className="text-2xl">等待點歌中...</p>
            <p className="text-sm">掃描右下角 QR code 點歌</p>
          </div>
        )}

        {/* Autoplay blocked overlay */}
        {current && blocked && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/70 cursor-pointer z-10"
            onClick={handleUnblock}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center text-5xl">▶</div>
              <p className="text-white text-lg font-semibold">點擊開始播放</p>
              <p className="text-gray-400 text-sm text-center max-w-xs">{current.title}</p>
            </div>
          </div>
        )}

        {/* Lyrics controls — top-right corner */}
        {current && playerReady && (
          <div className="absolute top-3 right-3 z-30 flex gap-2">
            <button
              onClick={() => setShowLyrics(v => !v)}
              className={`px-3 py-1 rounded-full text-xs font-semibold backdrop-blur transition-colors ${
                showLyrics ? 'bg-white/25 text-white' : 'bg-black/50 text-gray-400'
              }`}
            >
              字幕
            </button>
            {showLyrics && lrcLines.length > 0 && (
              <button
                onClick={() => setKaraokeMode(v => !v)}
                className={`px-3 py-1 rounded-full text-xs font-semibold backdrop-blur transition-colors ${
                  karaokeMode ? 'bg-yellow-400 text-black' : 'bg-black/50 text-gray-400'
                }`}
              >
                🎤 導唱
              </button>
            )}
          </div>
        )}

        {/* Lyrics overlay */}
        {current && showLyrics && curLine && (
          <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none select-none">
            <div className={`flex flex-col items-center gap-1 px-8 pb-4 pt-12 bg-gradient-to-t from-black/85 via-black/40 to-transparent ${karaokeMode ? 'pb-6' : ''}`}>
              {karaokeMode && prevLine && (
                <p className="text-gray-400 text-xl text-center leading-snug opacity-70 transition-all duration-300">
                  {prevLine.text}
                </p>
              )}
              <p
                className={`text-center font-bold leading-snug drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] transition-all duration-300 ${
                  karaokeMode
                    ? 'text-yellow-300 text-4xl'
                    : 'text-white text-3xl'
                }`}
              >
                {curLine.text}
              </p>
              {karaokeMode && nextLine && (
                <p className="text-gray-400 text-xl text-center leading-snug opacity-70 transition-all duration-300">
                  {nextLine.text}
                </p>
              )}
            </div>
          </div>
        )}

        {/* No lyrics indicator */}
        {current && showLyrics && lrcLines.length === 0 && playerReady && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <span className="text-gray-500 text-xs bg-black/40 px-3 py-1 rounded-full">找不到歌詞</span>
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
                <img src={item.thumbnail} alt={item.title} className="w-32 object-cover rounded mb-1" />
                <p className="text-xs line-clamp-2 text-gray-300">{idx + 1}. {item.title}</p>
                <p className="text-xs text-gray-500">{item.requester}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QR Code overlay */}
      <div className="absolute bottom-24 right-4 flex flex-col items-center gap-1">
        {qrOpen ? (
          <div className="bg-white rounded-xl p-2 shadow-2xl flex flex-col items-center gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrUrl} alt="點歌 QR Code" width={120} height={120} className="rounded" />
            <p className="text-gray-800 text-xs font-semibold">掃碼點歌</p>
            <button onClick={() => setQrOpen(false)} className="text-gray-400 text-xs hover:text-gray-600 leading-none">收起</button>
          </div>
        ) : (
          <button onClick={() => setQrOpen(true)} className="bg-white/90 hover:bg-white text-gray-800 text-xs font-semibold px-3 py-2 rounded-lg shadow-lg transition-colors">
            📱 點歌 QR
          </button>
        )}
      </div>
    </div>
  );
}
