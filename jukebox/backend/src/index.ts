import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { buildQueueRouter } from './routes/queue';
import youtubeRouter from './routes/youtube';
import qrcodeRouter from './routes/qrcode';
import adminRouter from './routes/admin';
import lyricsRouter from './routes/lyrics';
import suggestionsRouter from './routes/suggestions';
import { registerSocketHandlers } from './socket/handlers';

const app = express();
const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3001';
const allowedOrigins = FRONTEND_URL.split(',').map(s => s.trim());

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.set('trust proxy', 1);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.use('/api/queue', buildQueueRouter(io));
app.use('/api/youtube', youtubeRouter);
app.use('/api/qrcode', qrcodeRouter);
app.use('/api/admin', adminRouter);
app.use('/api/lyrics', lyricsRouter);
app.use('/api/suggestions', suggestionsRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', socket => {
  console.log(`[socket] connected: ${socket.id}`);
  registerSocketHandlers(io, socket);
  socket.on('disconnect', () => console.log(`[socket] disconnected: ${socket.id}`));
});

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => console.log(`Jukebox backend listening on :${PORT}`));
