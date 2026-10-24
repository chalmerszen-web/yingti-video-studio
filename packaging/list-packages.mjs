import { readFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const [name, entry] of Object.entries(lock.packages || {})) {
  if (name) console.log(`${name} @ ${entry.version} | ${typeof entry.license === 'string' ? entry.license : 'See package license file'}`);
}
