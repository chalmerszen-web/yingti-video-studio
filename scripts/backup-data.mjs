import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || process.env.WAN_EDITOR_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(folder, `before-v2-${stamp}.sqlite`);
const db = new DatabaseSync(path.join(directory, 'queue.sqlite'), { readOnly: true });
try {
  const jobs = db.prepare('SELECT id FROM jobs ORDER BY created').all();
  await backup(db, output + '.partial'); await rename(output + '.partial', output);
  console.log(JSON.stringify({ backup: output, jobCount: jobs.length, jobIds: jobs.map(j => j.id), credentialCopied: false }));
} finally { db.close(); }
