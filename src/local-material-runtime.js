import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

/** Resolve only our application-local runtime. No PATH Python or developer venv fallback. */
export async function localMaterialRuntime({ appRoot = path.resolve(import.meta.dirname, '..'), runtimeRoot = process.env.WAN_EDITOR_LOCAL_RUNTIME_DIR } = {}) {
  const root = path.resolve(runtimeRoot || path.join(appRoot, 'runtime', 'local-material'));
  const executable = path.join(root, 'python.exe');
  const workerDirectory = path.join(appRoot, 'worker', 'local_material');
  const workerFile = path.join(workerDirectory, 'launch.py');
  const manifestFile = path.join(root, 'runtime-manifest.json');
  try {
    await Promise.all([executable, workerFile, manifestFile].map(file => access(file)));
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32-x64' || typeof manifest.version !== 'string') return null;
    const models = {};
    for (const [kind, name] of [['face', 'face_landmarker.task'], ['hand', 'hand_landmarker.task']]) {
      const sha256 = manifest.models?.[kind]?.sha256;
      if (!/^[0-9a-f]{64}$/.test(sha256 || '')) return null;
      const file = path.join(root, 'models', name); await access(file);
      models[kind] = { file, sha256 };
    }
    return { executable, workerDirectory, workerFile, manifestFile, version: manifest.version, models };
  } catch { return null; }
}
