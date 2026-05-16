'use client';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState, useCallback } from 'react';
import {
  fetchQueue, fetchHistory, fetchPopular, getFavorites, toggleFavorite, isFavorite,
  addToQueue, QueueItem, PopularItem, FavoriteItem, formatDuration,
} from '@/lib/api';
import { getSocket } from '@/lib/socket';
import SearchBar from '@/components/SearchBar';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';
type Tab = 'queue' | 'history' | 'popular' | 'favorites';

export default function Home() {
  const qrUrl = `${BACKEND_URL}/api/qrcode`;

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<Tab>('queue');
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [popular, setPopular] = useState<PopularItem[]>([]);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [favMap, setFavMap] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    fetchQueue().then(setQueue).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    setFavorites(getFavorites());
    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    return () => { socket.off('queue:updated'); };
  }, [refresh]);

  useEffect(() => {
    if (tab === 'history') fetchHistory().then(setHistory).catch(() => {});
    if (tab === 'popular') fetchPopular().then(setPopular).catch(() => {});
    if (tab === 'favorites') {
      const favs = getFavorites();
      setFavorites(favs);
      const map: Record<string, boolean> = {};
      favs.forEach(f => { map[f.video_id] = true; });
      setFavMap(map);
    }
  }, [tab]);

  const quickAdd = async (video_id: string) => {
    setAdding(video_id);
    await addToQueue(video_id).catch(() => null);
    setAdding(null);
    refresh();
  };

  const handleToggleFav = (item: FavoriteItem) => {
    toggleFavorite(item);
    const favs = getFavorites();
    setFavorites(favs);
    const map: Record<string, boolean> = {};
    favs.forEach(f => { map[f.video_id] = true; });
    setFavMap(map);
  };

  const playing = queue.find(i => i.status === 'playing');
  const waiting = queue.filter(i => i.status === 'waiting');

  const TABS: { id: Tab; label: string }[] = [
    { id: 'queue', label: '歌單' },
    { id: 'history', label: '歷史' },
    { id: 'popular', label: '排行' },
    { id: 'favorites', label: '收藏' },
  ];

  return (
    <main className="min-h-screen flex flex-col gap-4 p-4 pt-8 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🎵 點歌系統</h1>
        <Link href="/tv" className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors">
          📺 TV 畫面
        </Link>
      </div>

      {/* Search */}
      <SearchBar onAdded={refresh} />

      {/* Now playing */}
      {playing && (
        <div className="bg-red-900/30 border border-red-500/40 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-red-400 text-xs font-bold flex-shrink-0">NOW PLAYING</span>
          <span className="text-sm truncate flex-1">{playing.title}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? 'text-white border-b-2 border-red-500' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
            {t.id === 'queue' && waiting.length > 0 && (
              <span className="ml-1 text-xs text-gray-500">({waiting.length})</span>
            )}
            {t.id === 'favorites' && favorites.length > 0 && (
              <span className="ml-1 text-xs text-gray-500">({favorites.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* ── 歌單 ── */}
      {tab === 'queue' && (
        <div className="flex flex-col gap-1.5">
          {waiting.length === 0 && !playing && (
            <p className="text-center text-gray-500 py-8">歌單是空的，快來點歌！</p>
          )}
          {waiting.map((item, idx) => (
            <div key={item.id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 text-sm">
              <span className="text-gray-500 w-4 text-center flex-shrink-0">{idx + 1}</span>
              <span className="truncate flex-1">{item.title}</span>
              <span className="text-gray-500 text-xs flex-shrink-0">{item.requester}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── 歷史 ── */}
      {tab === 'history' && (
        <div className="flex flex-col gap-2">
          {history.length === 0 && <p className="text-center text-gray-500 py-8">還沒有播放紀錄</p>}
          {history.map(item => (
            <div key={item.id} className="flex gap-3 bg-gray-800 rounded-lg p-2 items-center">
              <Image src={item.thumbnail} alt={item.title} width={64} height={36} className="rounded object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium line-clamp-1">{item.title}</p>
                <p className="text-xs text-gray-400">{item.requester} · {formatDuration(item.duration)}</p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleToggleFav({ video_id: item.video_id, title: item.title, thumbnail: item.thumbnail, duration: item.duration })}
                  className={`px-2 py-1 rounded text-sm transition-colors ${isFavorite(item.video_id) ? 'text-yellow-400' : 'text-gray-500 hover:text-yellow-400'}`}
                >⭐</button>
                <button
                  onClick={() => quickAdd(item.video_id)}
                  disabled={adding === item.video_id}
                  className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs transition-colors disabled:opacity-50"
                >
                  {adding === item.video_id ? '…' : '點歌'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 排行 ── */}
      {tab === 'popular' && (
        <div className="flex flex-col gap-2">
          {popular.length === 0 && <p className="text-center text-gray-500 py-8">播放紀錄不足，排行尚未產生</p>}
          {popular.map((item, idx) => (
            <div key={item.video_id} className="flex gap-3 bg-gray-800 rounded-lg p-2 items-center">
              <span className={`w-7 text-center font-bold flex-shrink-0 ${idx === 0 ? 'text-yellow-400' : idx === 1 ? 'text-gray-300' : idx === 2 ? 'text-orange-400' : 'text-gray-500'}`}>
                {idx + 1}
              </span>
              <Image src={item.thumbnail} alt={item.title} width={64} height={36} className="rounded object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium line-clamp-1">{item.title}</p>
                <p className="text-xs text-gray-400">{formatDuration(item.duration)} · 播放 {item.play_count} 次</p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleToggleFav(item)}
                  className={`px-2 py-1 rounded text-sm transition-colors ${favMap[item.video_id] ? 'text-yellow-400' : 'text-gray-500 hover:text-yellow-400'}`}
                >⭐</button>
                <button
                  onClick={() => quickAdd(item.video_id)}
                  disabled={adding === item.video_id}
                  className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs transition-colors disabled:opacity-50"
                >
                  {adding === item.video_id ? '…' : '點歌'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 收藏 ── */}
      {tab === 'favorites' && (
        <div className="flex flex-col gap-2">
          {favorites.length === 0 && (
            <p className="text-center text-gray-500 py-8">還沒有收藏歌曲<br /><span className="text-xs">在歷史或排行按 ⭐ 收藏</span></p>
          )}
          {favorites.map(item => (
            <div key={item.video_id} className="flex gap-3 bg-gray-800 rounded-lg p-2 items-center">
              <Image src={item.thumbnail} alt={item.title} width={64} height={36} className="rounded object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium line-clamp-1">{item.title}</p>
                <p className="text-xs text-gray-400">{formatDuration(item.duration)}</p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleToggleFav(item)}
                  className="px-2 py-1 rounded text-sm text-yellow-400 hover:text-gray-400 transition-colors"
                >⭐</button>
                <button
                  onClick={() => quickAdd(item.video_id)}
                  disabled={adding === item.video_id}
                  className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs transition-colors disabled:opacity-50"
                >
                  {adding === item.video_id ? '…' : '點歌'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* QR Code */}
      <div className="flex flex-col items-center gap-1 pt-2 pb-4">
        <div className="bg-white rounded-2xl p-3 flex flex-col items-center gap-1 shadow-xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrUrl} alt="點歌 QR Code" width={140} height={140} />
          <p className="text-gray-700 font-semibold text-xs">手機掃碼點歌</p>
        </div>
      </div>
    </main>
  );
}
