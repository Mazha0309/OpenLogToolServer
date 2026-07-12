import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations';

let db: Database.Database | undefined;

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:' || databasePath.startsWith('file:')) return;
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
}

function configureConnection(connection: Database.Database): void {
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
}

export function openDatabase(databasePath: string): Database.Database {
  ensureDatabaseDirectory(databasePath);
  const connection = new Database(databasePath);

  try {
    configureConnection(connection);
    runMigrations(connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function getDb(): Database.Database {
  if (!db) db = openDatabase(process.env.DB_PATH || './data/openlogtool.db');
  return db;
}

export function closeDbForTests(): void {
  if (!db) return;
  db.close();
  db = undefined;
}

export { runMigrations };
