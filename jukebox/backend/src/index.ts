import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { buildQueueRouter } from './routes/queue';
import youtubeRouter from './routes/youtube';
import qrcodeRouter from './routes/qrcode';
import { registerSocketHandlers } from './socket/handlers';

const app = express();
const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3001';

const io = new Server(httpServer, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

app.use('/api/queue', buildQueueRouter(io));
app.use('/api/youtube', youtubeRouter);
app.use('/api/qrcode', qrcodeRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', socket => {
  console.log(`[socket] connected: ${socket.id}`);
  registerSocketHandlers(io, socket);
  socket.on('disconnect', () => console.log(`[socket] disconnected: ${socket.id}`));
});

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => console.log(`Jukebox backend listening on :${PORT}`));
