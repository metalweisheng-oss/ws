'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchQueue, verifyAdminPin, nextSong, sendAnnouncement, QueueItem } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import SearchBar from '@/components/SearchBar';
import QueueList from '@/components/QueueList';

export default function QueuePage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [adminPin, setAdminPin] = useState<string>('');
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinLoading, setPinLoading] = useState(false);
  const [announceText, setAnnounceText] = useState('');
  const [announceSending, setAnnounceSending] = useState(false);

  const refresh = useCallback(() => {
    fetchQueue().then(setQueue).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Restore admin session
    const saved = sessionStorage.getItem('adminPin');
    if (saved) setAdminPin(saved);

    const socket = getSocket();
    socket.on('queue:updated', (q: QueueItem[]) => setQueue(q));
    return () => { socket.off('queue:updated'); };
  }, [refresh]);

  const handleVerifyPin = async () => {
    setPinLoading(true);
    setPinError('');
    const ok = await verifyAdminPin(pinInput);
    if (ok) {
      setAdminPin(pinInput);
      sessionStorage.setItem('adminPin', pinInput);
      setShowPinModal(false);
      setPinInput('');
    } else {
      setPinError('密碼錯誤');
    }
    setPinLoading(false);
  };

  const handleLogout = () => {
    setAdminPin('');
    sessionStorage.removeItem('adminPin');
  };

  const handleSkip = async () => {
    if (!adminPin) return;
    await nextSong(adminPin);
    refresh();
  };

  const handleAnnounce = async () => {
    if (!adminPin || !announceText.trim()) return;
    setAnnounceSending(true);
    await sendAnnouncement(announceText.trim(), adminPin).catch(() => {});
    setAnnounceText('');
    setAnnounceSending(false);
  };

  const isAdmin = !!adminPin;

  return (
    <main className="max-w-lg mx-auto p-4 flex flex-col gap-6 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🎵 點歌</h1>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-400 font-medium">管理員模式</span>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-500 hover:text-gray-300 underline"
            >
              登出
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowPinModal(true)}
            className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors"
          >
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
              type="password"
              inputMode="numeric"
              className="bg-gray-800 rounded-lg px-4 py-3 text-center text-xl tracking-widest outline-none focus:ring-2 focus:ring-red-500"
              placeholder="輸入 PIN 碼"
              value={pinInput}
              onChange={e => { setPinInput(e.target.value); setPinError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleVerifyPin()}
              autoFocus
            />
            {pinError && <p className="text-red-400 text-sm text-center">{pinError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowPinModal(false); setPinInput(''); setPinError(''); }}
                className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleVerifyPin}
                disabled={pinLoading || !pinInput}
                className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-medium disabled:opacity-50 transition-colors"
              >
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
            <button
              onClick={handleSkip}
              className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-xs font-medium transition-colors"
            >
              ⏭ 跳過當前
            </button>
          </div>
          {/* TV 公告 */}
          <div className="flex gap-2">
            <input
              className="flex-1 bg-gray-700 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-yellow-500 placeholder-gray-500"
              placeholder="📢 發送公告到 TV 畫面跑馬燈…"
              value={announceText}
              onChange={e => setAnnounceText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAnnounce()}
            />
            <button
              onClick={handleAnnounce}
              disabled={announceSending || !announceText.trim()}
              className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-xs font-medium disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {announceSending ? '發送中…' : '發送'}
            </button>
          </div>
        </div>
      )}

      <SearchBar onAdded={refresh} />

      <div>
        <h2 className="text-sm font-semibold text-gray-400 mb-2">目前歌單</h2>
        <QueueList queue={queue} onUpdate={refresh} adminPin={adminPin || undefined} />
      </div>
    </main>
  );
}
