'use client';
import { useState, useEffect, useRef } from 'react';
import { searchYouTube, addToQueue, extractYouTubeId, fetchSuggestions, VideoInfo, formatDuration } from '@/lib/api';
import Image from 'next/image';

interface Props {
  onAdded: () => void;
}

export default function SearchBar({ onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VideoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null); // brief ✓ feedback
  const [requester, setRequester] = useState('');
  const [error, setError] = useState('');

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);

  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const isUrl = (s: string) => extractYouTubeId(s.trim()) !== null;

  // Debounced suggestion fetch
  useEffect(() => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    const q = query.trim();
    if (!q || isUrl(q) || q.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    suggestTimer.current = setTimeout(async () => {
      const data = await fetchSuggestions(q);
      setSuggestions(data);
      setShowSuggestions(data.length > 0);
      setActiveSuggestion(-1);
    }, 320);
    return () => { if (suggestTimer.current) clearTimeout(suggestTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const doSearch = async (q: string) => {
    setShowSuggestions(false);
    setSuggestions([]);
    setError('');
    const trimmed = q.trim();
    if (!trimmed) return;

    const videoId = extractYouTubeId(trimmed);
    if (videoId) {
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
      setLoading(true);
      const data = await searchYouTube(trimmed).catch(() => []);
      setResults(data);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || !suggestions.length) {
      if (e.key === 'Enter') doSearch(query);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestion(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestion(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestion >= 0) {
        const chosen = suggestions[activeSuggestion];
        setQuery(chosen);
        doSearch(chosen);
      } else {
        doSearch(query);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setActiveSuggestion(-1);
    }
  };

  const pickSuggestion = (s: string) => {
    setQuery(s);
    setShowSuggestions(false);
    doSearch(s);
  };

  const add = async (v: VideoInfo) => {
    setAdding(v.video_id);
    await addToQueue(v.video_id, requester || undefined).catch(() => null);
    setAdding(null);
    setAdded(v.video_id);
    setTimeout(() => setAdded(id => id === v.video_id ? null : id), 2000);
    onAdded();
    // Keep query and results so user can keep adding from the same search
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Search row + suggestion dropdown */}
      <div ref={wrapperRef} className="flex gap-2 relative">
        <div className="flex-1 relative">
          <input
            className="w-full bg-gray-800 rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500"
            placeholder="搜尋歌名，或貼上 YouTube 連結…"
            value={query}
            onChange={e => { setQuery(e.target.value); setError(''); setResults([]); }}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (suggestions.length) setShowSuggestions(true); }}
            autoComplete="off"
          />

          {/* Suggestions dropdown */}
          {showSuggestions && (
            <ul className="absolute left-0 right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden shadow-xl z-50">
              {suggestions.map((s, i) => (
                <li
                  key={s}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm cursor-pointer transition-colors ${
                    i === activeSuggestion ? 'bg-gray-700 text-white' : 'text-gray-200 hover:bg-gray-700'
                  }`}
                  onMouseDown={e => { e.preventDefault(); pickSuggestion(s); }}
                  onMouseEnter={() => setActiveSuggestion(i)}
                >
                  <svg className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="flex-1 truncate">{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          onClick={() => doSearch(query)}
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
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex-shrink-0 disabled:opacity-50 transition-colors ${
                  added === v.video_id
                    ? 'bg-green-600 text-white'
                    : 'bg-red-600 hover:bg-red-500'
                }`}
              >
                {adding === v.video_id ? '加入中...' : added === v.video_id ? '✓ 已加入' : '點歌'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
