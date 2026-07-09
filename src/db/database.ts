import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/openlogtool.db';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  db.exec(schema);
}
