import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../../../data/jukebox.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id    TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    thumbnail   TEXT    NOT NULL,
    duration    INTEGER NOT NULL DEFAULT 0,
    requester   TEXT    NOT NULL DEFAULT 'anonymous',
    status      TEXT    NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','playing','done')),
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    owner_token TEXT
  );
`);

// Migration: add owner_token if it doesn't exist yet
const cols = db.prepare(`PRAGMA table_info(queue)`).all() as { name: string }[];
if (!cols.some(c => c.name === 'owner_token')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_token TEXT`);
}

export default db;
