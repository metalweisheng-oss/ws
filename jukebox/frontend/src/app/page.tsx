import Link from 'next/link';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

export default function Home() {
  const qrUrl = `${BACKEND_URL}/api/qrcode`;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold">🎵 點歌系統</h1>

      {/* QR Code */}
      <div className="bg-white rounded-2xl p-4 flex flex-col items-center gap-2 shadow-xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrUrl} alt="點歌 QR Code" width={200} height={200} />
        <p className="text-gray-700 font-semibold text-sm">手機掃碼點歌</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <Link
          href="/queue"
          className="px-8 py-4 bg-red-600 hover:bg-red-500 rounded-xl text-xl font-semibold text-center transition-colors"
        >
          點歌 / 查看歌單
        </Link>
        <Link
          href="/tv"
          className="px-8 py-4 bg-gray-700 hover:bg-gray-600 rounded-xl text-xl font-semibold text-center transition-colors"
        >
          TV 播放畫面
        </Link>
      </div>
    </main>
  );
}
