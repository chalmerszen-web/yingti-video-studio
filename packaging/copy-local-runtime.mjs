import path from 'node:path';
import { readFile, readdir, lstat, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function list(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Runtime symlinks are not allowed');
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue;
      result.push(...await list(file, relative + '/'));
    } else if (!/\.py[co]$/.test(entry.name)) result.push(relative);
  }
  return result.sort();
}

export async function copyLocalRuntime(runtime, payload) {
  const target = path.join(payload, 'runtime/local-material');
  const workerTarget = path.join(payload, 'worker/local_material');
  for (const destination of [target, workerTarget]) {
    try { await lstat(destination); throw new Error('Runtime/worker destination already exists; use a fresh build stage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const lockBytes = await readFile(path.join(root, 'packaging/local-material-runtime.lock.json'));
  const lock = JSON.parse(lockBytes);
  const manifestBytes = await readFile(path.join(runtime, 'runtime-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.lockSHA256 !== sha(lockBytes) || manifest.version !== lock.version || !Array.isArray(manifest.files)) throw new Error('Runtime was not assembled from the pinned release inputs');
  const expected = new Map();
  for (const file of manifest.files) {
    if (!/^[^\\:]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(p => !p || p === '..' || p === '.') || !/^[0-9a-f]{64}$/.test(file.sha256) || expected.has(file.path)) throw new Error('Invalid runtime inventory');
    expected.set(file.path, file);
  }
  const files = await list(runtime);
  if (JSON.stringify(files.filter(p => p !== 'runtime-manifest.json')) !== JSON.stringify([...expected.keys()].sort())) throw new Error('Unexpected or missing runtime files');
  for (const relative of files) {
    const bytes = await readFile(path.join(runtime, relative));
    const record = expected.get(relative);
    if (record && (record.bytes !== bytes.length || record.sha256 !== sha(bytes))) throw new Error(`Runtime file changed: ${relative}`);
  }
  for (const relative of files) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(runtime, relative), destination);
  }
  // Only the generic worker's direct source files enter the application.
  const workerRoot = path.join(root, 'worker/local_material');
  const workerFiles = (await readdir(workerRoot)).filter(name => /\.py$/.test(name) || ['README.md', 'requirements.lock.txt'].includes(name));
  await mkdir(workerTarget, { recursive: true });
  for (const name of workerFiles) {
    const source = path.join(workerRoot, name);
    if (!(await lstat(source)).isFile()) throw new Error('Worker allowlist must contain files only');
    await copyFile(source, path.join(workerTarget, name));
  }
  return { version: lock.version, files: files.length, workerFiles: workerFiles.length, manifestSHA256: sha(manifestBytes), containsCustomerMedia: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node copy-local-runtime.mjs VERIFIED_RUNTIME PAYLOAD');
  console.log(JSON.stringify(await copyLocalRuntime(path.resolve(process.argv[2]), path.resolve(process.argv[3]))));
}
