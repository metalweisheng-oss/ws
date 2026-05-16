import { Server, Socket } from 'socket.io';
import { getQueue, addItem, removeItem, jumpItem, markCurrentDone } from '../db/queue';
import { getVideoInfo } from '../services/youtube';

export function registerSocketHandlers(io: Server, socket: Socket) {
  // Send current state on connect
  socket.emit('queue:updated', getQueue());

  socket.on('queue:add', async (data: { video_id: string; requester?: string }) => {
    const info = await getVideoInfo(data.video_id).catch(() => null);
    if (!info) return;
    addItem({ ...info, requester: data.requester ?? 'anonymous' });
    io.emit('queue:updated', getQueue());
  });

  socket.on('queue:remove', (data: { id: number }) => {
    if (removeItem(data.id)) io.emit('queue:updated', getQueue());
  });

  socket.on('queue:jump', (data: { id: number }) => {
    if (jumpItem(data.id)) {
      const queue = getQueue();
      const playing = queue.find(i => i.status === 'playing') ?? null;
      io.emit('queue:updated', queue);
      io.emit('player:state', { action: 'play', item: playing });
    }
  });

  socket.on('player:ended', () => {
    const next = markCurrentDone();
    const queue = getQueue();
    io.emit('queue:updated', queue);
    io.emit('player:state', next ? { action: 'play', item: next } : { action: 'idle' });
  });

  socket.on('player:next', () => {
    const next = markCurrentDone();
    const queue = getQueue();
    io.emit('queue:updated', queue);
    io.emit('player:state', next ? { action: 'play', item: next } : { action: 'idle' });
  });
}
