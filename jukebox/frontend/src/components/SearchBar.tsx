'use client';
import { useState } from 'react';
import { searchYouTube, addToQueue, extractYouTubeId, VideoInfo, formatDuration } from '@/lib/api';
import Image from 'next/image';

interface Props {
  onAdded: () => void;
}

export default function SearchBar({ onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VideoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [requester, setRequester] = useState('');
  const [error, setError] = useState('');

  const isUrl = (s: string) => extractYouTubeId(s.trim()) !== null;

  const handleSubmit = async () => {
    const q = query.trim();
    if (!q) return;
    setError('');

    const videoId = extractYouTubeId(q);
    if (videoId) {
      // Direct URL — skip search, add immediately
      setLoading(true);
      try {
        await addToQueue(videoId, requester || undefined);
        setQuery('');
        setResults([]);
        onAdded();
      } catch {
        setError('找不到這部影片，請確認連結是否正確');
      } finally {
        setLoading(false);
      }
    } else {
      // Keyword search
      setLoading(true);
      const data = await searchYouTube(q).catch(() => []);
      setResults(data);
      setLoading(false);
    }
  };

  const add = async (v: VideoInfo) => {
    setAdding(v.video_id);
    await addToQueue(v.video_id, requester || undefined).catch(() => null);
    setAdding(null);
    setResults([]);
    setQuery('');
    onAdded();
  };

  const placeholder = '搜尋歌名，或貼上 YouTube 連結…';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          className="flex-1 bg-gray-800 rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500"
          placeholder={placeholder}
          value={query}
          onChange={e => { setQuery(e.target.value); setError(''); setResults([]); }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {loading ? '...' : isUrl(query) ? '加入' : '搜尋'}
        </button>
      </div>

      <input
        className="bg-gray-800 rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500"
        placeholder="你的名字（選填）"
        value={requester}
        onChange={e => setRequester(e.target.value)}
      />

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {results.length > 0 && (
        <ul className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
          {results.map(v => (
            <li key={v.video_id} className="flex gap-3 bg-gray-800 rounded-lg p-2 items-center">
              <Image src={v.thumbnail} alt={v.title} width={80} height={45} className="rounded object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium line-clamp-2">{v.title}</p>
                <p className="text-xs text-gray-400">{formatDuration(v.duration)}</p>
              </div>
              <button
                onClick={() => add(v)}
                disabled={adding === v.video_id}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-xs font-medium flex-shrink-0 disabled:opacity-50 transition-colors"
              >
                {adding === v.video_id ? '加入中...' : '點歌'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
