import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

// Resolve DB path relative to the server root (two levels up from src/db/)
// so it's always the same regardless of CWD
const serverRoot = resolve(dirname(import.meta.dir), '..');
const dataDir = resolve(serverRoot, 'data');
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(resolve(dataDir, 'proximity.db'));
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
