import { DatabaseSync } from 'node:sqlite';

const dest = process.env.BACKUP_DEST ?? '';
if (!dest.startsWith('/app/data/backups/') || dest.includes('..') || !dest.endsWith('.sqlite')) {
  console.error('无效备份路径');
  process.exit(1);
}

const db = new DatabaseSync('/app/data/app.sqlite', { timeout: 10000 });
db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
db.close();
console.log(dest);
