import axios from 'axios';

const YT_API_KEY = process.env.YOUTUBE_API_KEY ?? '';

export interface VideoInfo {
  video_id: string;
  title: string;
  thumbnail: string;
  duration: number; // seconds
}

// ISO 8601 duration → seconds
function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

export async function searchVideos(query: string, maxResults = 10): Promise<VideoInfo[]> {
  const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: { part: 'snippet', type: 'video', q: query, maxResults, key: YT_API_KEY },
  });
  const ids: string[] = searchRes.data.items.map((i: any) => i.id.videoId);
  if (!ids.length) return [];

  const detailRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { part: 'snippet,contentDetails', id: ids.join(','), key: YT_API_KEY },
  });

  return detailRes.data.items.map((v: any) => ({
    video_id: v.id,
    title: v.snippet.title,
    thumbnail: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? '',
    duration: parseDuration(v.contentDetails.duration),
  }));
}

export async function getVideoInfo(videoId: string): Promise<VideoInfo | null> {
  const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { part: 'snippet,contentDetails', id: videoId, key: YT_API_KEY },
  });
  const v = res.data.items?.[0];
  if (!v) return null;
  return {
    video_id: v.id,
    title: v.snippet.title,
    thumbnail: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? '',
    duration: parseDuration(v.contentDetails.duration),
  };
}
