import type { Socket } from 'socket.io-client';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (typeof window === 'undefined') {
    throw new Error('getSocket must be called in browser only');
  }
  if (!socket) {
    // Dynamic require to avoid SSR import of browser-only socket.io-client internals
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { io } = require('socket.io-client');
    socket = io(BACKEND_URL, { autoConnect: true });
  }
  return socket!;
}
