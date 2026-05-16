'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  fetchQueue, verifyAdminPin, nextSong, sendAnnouncement,
  fetchHistory, fetchPopular, getFavorites, toggleFavorite, isFavorite, addToQueue,
  QueueItem, PopularItem, FavoriteItem, formatDuration,
} from '@/lib/api';
import { getSocket } from '@/lib/socket';
import SearchBar from '@/components/SearchBar';
import QueueList from '@/components/QueueList';
import Image from 'next/image';

type Tab = 'queue' | 'history' | 'popular' | 'favorites';

export default function QueuePage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [adminPin, setAdminPin] = useState<string>('');
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinLoading, setPinLoading] = useState(false);
  const [announceText, setAnnounceText] = useState('');
  const [announceSending, setAnnounceSending] = useState(false);

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
    const saved = sessionStorage.getItem('adminPin');
    if (saved) setAdminPin(saved);
    setFavorites(getFavorites());

    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    return () => { socket.off('queue:updated'); };
  }, [refresh]);

  // Load tab data on switch
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

  const handleVerifyPin = async () => {
    setPinLoading(true); setPinError('');
    const ok = await verifyAdminPin(pinInput);
    if (ok) {
      setAdminPin(pinInput);
      sessionStorage.setItem('adminPin', pinInput);
      setShowPinModal(false); setPinInput('');
    } else setPinError('密碼錯誤');
    setPinLoading(false);
  };

  const handleLogout = () => { setAdminPin(''); sessionStorage.removeItem('adminPin'); };
  const handleSkip = async () => { if (!adminPin) return; await nextSong(adminPin); refresh(); };
  const handleAnnounce = async () => {
    if (!adminPin || !announceText.trim()) return;
    setAnnounceSending(true);
    await sendAnnouncement(announceText.trim(), adminPin).catch(() => {});
    setAnnounceText(''); setAnnounceSending(false);
  };

  const quickAdd = async (video_id: string, requester?: string) => {
    setAdding(video_id);
    await addToQueue(video_id, requester).catch(() => null);
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

  const isAdmin = !!adminPin;
  const TABS: { id: Tab; label: string }[] = [
    { id: 'queue', label: '歌單' },
    { id: 'history', label: '歷史' },
    { id: 'popular', label: '排行' },
    { id: 'favorites', label: '收藏' },
  ];

  return (
    <main className="max-w-lg mx-auto p-4 flex flex-col gap-4 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🎵 點歌</h1>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-400 font-medium">管理員模式</span>
            <button onClick={handleLogout} className="text-xs text-gray-500 hover:text-gray-300 underline">登出</button>
          </div>
        ) : (
          <button onClick={() => setShowPinModal(true)} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors">
            🔐 管理員
          </button>
        )}
      </div>

      {/* PIN Modal */}
      {showPinModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-xs flex flex-col gap-4">
            <h2 className="text-lg font-bold text-center">管理員登入</h2>
            <input
              type="password" inputMode="numeric"
              className="bg-gray-800 rounded-lg px-4 py-3 text-center text-xl tracking-widest outline-none focus:ring-2 focus:ring-red-500"
              placeholder="輸入 PIN 碼" value={pinInput}
              onChange={e => { setPinInput(e.target.value); setPinError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleVerifyPin()}
              autoFocus
            />
            {pinError && <p className="text-red-400 text-sm text-center">{pinError}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setShowPinModal(false); setPinInput(''); setPinError(''); }} className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm transition-colors">取消</button>
              <button onClick={handleVerifyPin} disabled={pinLoading || !pinInput} className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-medium disabled:opacity-50 transition-colors">
                {pinLoading ? '驗證中...' : '確認'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Panel */}
      {isAdmin && (
        <div className="bg-gray-800/60 border border-yellow-600/40 rounded-xl p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-yellow-400 font-semibold">管理員控制台</span>
            <button onClick={handleSkip} className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-xs font-medium transition-colors">
              ⏭ 跳過當前
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-gray-700 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-yellow-500 placeholder-gray-500"
              placeholder="📢 發送公告到 TV 畫面跑馬燈…"
              value={announceText}
              onChange={e => setAnnounceText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAnnounce()}
            />
            <button onClick={handleAnnounce} disabled={announceSending || !announceText.trim()} className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-xs font-medium disabled:opacity-50 transition-colors whitespace-nowrap">
              {announceSending ? '發送中…' : '發送'}
            </button>
          </div>
        </div>
      )}

      {/* Search (always visible) */}
      <SearchBar onAdded={refresh} />

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'text-white border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
            {t.id === 'queue' && queue.length > 0 && (
              <span className="ml-1 text-xs text-gray-500">({queue.length})</span>
            )}
            {t.id === 'favorites' && favorites.length > 0 && (
              <span className="ml-1 text-xs text-gray-500">({favorites.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'queue' && (
        <QueueList queue={queue} onUpdate={refresh} adminPin={adminPin || undefined} />
      )}

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
                  title="收藏"
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
                  title="收藏"
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

      {tab === 'favorites' && (
        <div className="flex flex-col gap-2">
          {favorites.length === 0 && <p className="text-center text-gray-500 py-8">還沒有收藏歌曲<br /><span className="text-xs">在歷史或排行按 ⭐ 收藏</span></p>}
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
                  title="取消收藏"
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
    </main>
  );
}
