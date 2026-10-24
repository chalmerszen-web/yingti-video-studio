const { contextBridge, ipcRenderer } = require('electron');
let prepareExit = async () => {};
ipcRenderer.on('yingti:prepare-exit', async (event, token) => {
  try { await prepareExit(); ipcRenderer.send('yingti:exit-prepared', { token, ok: true }); }
  catch (error) { ipcRenderer.send('yingti:exit-prepared', { token, ok: false, error: String(error?.message || '编辑内容尚未保存。').slice(0, 300) }); }
});
contextBridge.exposeInMainWorld('yingtiDesktop', {
  isDesktop: true,
  onPrepareExit: handler => { if (typeof handler === 'function') prepareExit = handler; },
  exit: () => ipcRenderer.invoke('yingti:exit'),
});
