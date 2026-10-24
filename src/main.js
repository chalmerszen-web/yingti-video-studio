import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.js';
import { KeyVault } from './keys.js';
import { QueueEngine } from './engine.js';
import { checkTools } from './media.js';
import { createApp } from './server.js';
import { AnalysisEngine } from './analysis.js';
import { ReviewEngine } from './quality.js';
import { LocalMaterialEngine } from './local-material.js';
import { localMaterialRuntime } from './local-material-runtime.js';

const directory = path.resolve(process.env.WAN_EDITOR_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const port = Number(process.env.WAN_EDITOR_PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
mkdirSync(directory, { recursive: true });
const store = new Store(directory);
const vault = new KeyVault(directory);
await vault.load();
const toolsStatus = await checkTools();
const engine = new QueueEngine({ store, vault, directory });
const analysis = new AnalysisEngine({ store, vault, directory });
const review = new ReviewEngine({ store, vault, directory });
const localRuntime = await localMaterialRuntime();
const localMaterial = new LocalMaterialEngine({ store, directory, runtime: localRuntime });
const app = createApp({ store, vault, engine, analysis, review, localMaterial, localRuntime, directory, port, toolsStatus, shutdown });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`映替 WAN Studio 已启动：http://127.0.0.1:${port}`);
  console.log(`FFmpeg ${toolsStatus.ffmpeg ? '已就绪' : '未找到'}；KEY ${vault.status().configured ? '已从本机加密存储加载' : '等待用户导入'}。`);
  engine.start();
  analysis.start().catch(() => console.error('视频分析恢复未完成，请检查数据目录权限。'));
  review.start().catch(() => console.error('动作或画面检查恢复未完成，请检查记录。'));
  localMaterial.start();
});
server.requestTimeout = 3600000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '本地端口已被占用，请打开已运行的软件或检查启动器。' : '本地服务无法启动。');
  store.close();
  process.exitCode = 1;
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  engine.stop();
  analysis.stop();
  review.stop();
  localMaterial.stop().catch(() => console.error('本地材质处理退出未完成，校准记录已保留。'));
  server.close();
  server.closeIdleConnections();
  const finish = setInterval(() => {
    if (!engine.active && !analysis.active && !review.active && !localMaterial.active && !app.locals.pendingWrites() && !app.locals.localMaterialPendingWrites()) { clearInterval(finish); store.close(); process.exit(0); }
  }, 250);
  // Leave the paid POST enough time to save its ID before falling back to crash recovery.
  setTimeout(() => process.exit(0), 190000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
