import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findRepoRoot } from '../config.ts';

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  if (filename !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // Durable across application crashes; only an OS crash can lose the last commits.
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync, migrationsDir = defaultMigrationsDir()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => String(row.name)),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const insert = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      insert.run(name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function defaultMigrationsDir(): string {
  return path.join(findRepoRoot(), 'backend', 'src', 'db', 'migrations');
}
