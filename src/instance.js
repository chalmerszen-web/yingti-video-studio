import path from 'node:path';
import { createHash } from 'node:crypto';

// Public non-secret identity; no user paths are exposed over HTTP.
export function instanceId(directory) {
  const resolved = path.resolve(directory).replace(/[\\/]+$/, '');
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 24);
}
