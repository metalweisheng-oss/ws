import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '點歌系統',
  description: '多人即時點歌，YouTube 同步播放',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
