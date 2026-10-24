const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const core = require('./core.cjs');

const root = path.resolve(__dirname, '../../..');
const dataDir = path.resolve(process.env.WAN_EDITOR_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'YingTiStudio', 'data'));
const instanceId = core.identity(dataDir);
const preferencesFile = path.join(dataDir, 'desktop-preferences.json');
const controlFile = path.join(dataDir, 'desktop-control.json');
const requestFile = path.join(dataDir, 'desktop-quit-request.json');
const statusFile = path.join(dataDir, 'desktop-status.json');
const token = randomBytes(32).toString('hex');
const version = require('./package.json').version;
require('node:fs').mkdirSync(path.join(dataDir, 'desktop-profile'), { recursive: true });
app.setName('映替视频工作台');
app.setAppUserModelId('YingTiStudio.Desktop');
app.setPath('userData', path.join(dataDir, 'desktop-profile'));

let mainWindow, tray, backend, preferences = {}, quitting = false, requestTimer, healthTimer, bootPromise;
let rendered = false, lastRequest = '', preparePending, secondInstances = 0, lastError = '', exitPromise;
let writeQueue = Promise.resolve();
const status = () => ({ app:'yingti-desktop', version, pid:process.pid, instanceId, visible:!!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(), minimized:!!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized(), tray:!!tray && !tray.isDestroyed(), rendered, quitting, secondInstances, lastError, lastRequestId:lastRequest, backendPort:backend ? Number(new URL(backend.origin).port) : null, backendPid:backend?.pid || null });
function saveStatus() { writeQueue = writeQueue.catch(()=>{}).then(()=>core.writeJSON(statusFile,status())); return writeQueue; }
async function log(error) { await fs.appendFile(path.join(dataDir,'desktop-error.log'),new Date().toISOString()+' '+String(error?.stack || error)+'\n').catch(()=>{}); }
async function savePreferences() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) { preferences.bounds = mainWindow.getNormalBounds(); preferences.maximized = mainWindow.isMaximized(); }
  await core.writeJSON(preferencesFile, preferences);
}
function showWindow() {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setSkipTaskbar(false); mainWindow.show(); mainWindow.focus(); saveStatus();
}
function hideWindow(hint=false) {
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide(); mainWindow.setSkipTaskbar(true); saveStatus();
    if(hint && tray && !preferences.trayHintShown){preferences.trayHintShown=true;tray.displayBalloon({title:'映替已收起到系统托盘',content:'后台任务继续运行。点击托盘图标恢复窗口，右键可退出应用。'});savePreferences().catch(log);}
  }
}
function trustedEvent(event) { return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame && core.isLocalURL(event.senderFrame.url, backend?.origin); }
function prepareRenderer() {
  if (!rendered || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const requestToken=randomBytes(16).toString('hex');
    const timer=setTimeout(()=>{preparePending=null;reject(new Error('界面未完成保存，暂时没有退出。请先保存修改后重试。'));},70000);
    preparePending={token:requestToken,done:(result)=>{clearTimeout(timer);preparePending=null;result.ok?resolve():reject(new Error(result.error || '编辑尚未保存。'));}};
    mainWindow.webContents.send('yingti:prepare-exit',requestToken);
  });
}
async function exitApplication(reason='user') {
  if (exitPromise) return exitPromise;
  exitPromise=(async()=>{
    await bootPromise;
    await prepareRenderer();
    await savePreferences();
    quitting=true; lastError=''; await saveStatus();
    if(mainWindow && !mainWindow.isDestroyed())mainWindow.hide();
    if (tray) tray.setToolTip('映替 · 正在保存并退出…');
    await core.runScript(root,'stop-backend.ps1',[],dataDir,240000);
    clearInterval(requestTimer); clearInterval(healthTimer);
    if(tray) {tray.destroy();tray=null;}
    await fs.unlink(controlFile).catch(()=>{}); await fs.unlink(requestFile).catch(()=>{});
    await saveStatus();
    app.quit();
  })().catch(async error=>{
    quitting=false; exitPromise=null; lastError=error.message; await log(error); await saveStatus();
    if(tray) tray.setToolTip('映替视频工作台');
    if(reason==='user') dialog.showErrorBox('暂时无法退出',error.message);
    throw error;
  });
  return exitPromise;
}
function secureContents(contents) {
  contents.on('will-attach-webview', event=>event.preventDefault());
  contents.on('will-navigate',(event,url)=>{ if(!core.isLocalURL(url,backend.origin)){event.preventDefault();if(core.externalURL(url)) shell.openExternal(url).catch(log);} });
  contents.setWindowOpenHandler(({url})=>{
    if(core.isLocalURL(url,backend.origin)) return {action:'allow',overrideBrowserWindowOptions:{parent:mainWindow,width:1000,height:720,autoHideMenuBar:true,icon:path.join(root,'YingTiStudio.ico'),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}};
    if(core.externalURL(url)) shell.openExternal(url).catch(log);
    return {action:'deny'};
  });
  contents.on('did-create-window', child=>secureContents(child.webContents));
}
async function createWindow() {
  const area=screen.getPrimaryDisplay().workArea;
  const saved=preferences.bounds;
  const onScreen=saved && screen.getAllDisplays().some(d=>saved.x+100>d.workArea.x && saved.x<d.workArea.x+d.workArea.width-100 && saved.y+100>d.workArea.y && saved.y<d.workArea.y+d.workArea.height-100);
  const size=onScreen?{...saved,width:Math.min(saved.width,area.width),height:Math.min(saved.height,area.height)}:{width:Math.min(1440,area.width),height:Math.min(940,area.height)};
  mainWindow=new BrowserWindow({...size,minWidth:960,minHeight:640,show:false,title:'映替 · 视频工作台',backgroundColor:'#f3f5f7',autoHideMenuBar:true,icon:path.join(root,'YingTiStudio.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false,spellcheck:false,backgroundThrottling:false}});
  mainWindow.removeMenu(); secureContents(mainWindow.webContents);
  mainWindow.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(()=>false);
  mainWindow.on('minimize',event=>{event.preventDefault();hideWindow(true);});
  mainWindow.on('close',event=>{if(!quitting){event.preventDefault();hideWindow(true);}});
  for(const event of ['show','hide','restore','maximize','unmaximize']) mainWindow.on(event,()=>saveStatus());
  mainWindow.webContents.on('page-title-updated',event=>{event.preventDefault();mainWindow.setTitle('映替 · 视频工作台 '+version);});
  mainWindow.webContents.on('did-finish-load',()=>{rendered=true;saveStatus();});
  mainWindow.webContents.on('did-navigate-in-page',(event,url)=>{if(core.isLocalURL(url,backend.origin)){const u=new URL(url);const route=core.savedRoute(u.pathname+u.search);if(route){preferences.route=route;savePreferences().catch(log);}}});
  let route=core.savedRoute(preferences.route);
  if(!route){const projects=await core.getJSON(backend.origin+'/api/projects');if(projects[0]?.id) route=core.savedRoute('/?project='+projects[0].id);}
  await mainWindow.loadURL(backend.origin+(route || '/'));
  if(preferences.maximized) mainWindow.maximize();
  if(!process.argv.includes('--start-minimized')) showWindow(); else hideWindow();
  await saveStatus();
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance',()=>{secondInstances++;if(mainWindow)showWindow();else app.whenReady().then(()=>bootPromise).then(showWindow).catch(log);saveStatus();});
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();exitApplication().catch(()=>{});}});
  ipcMain.on('yingti:exit-prepared',(event,result)=>{if(trustedEvent(event)&&result?.token===preparePending?.token)preparePending.done(result);});
  ipcMain.handle('yingti:exit',event=>{if(!trustedEvent(event))throw new Error('Invalid desktop sender');setTimeout(()=>exitApplication().catch(()=>{}),50);return true;});
  app.whenReady().then(()=>{
    bootPromise=(async()=>{
      await fs.mkdir(dataDir,{recursive:true});
      preferences=await core.readJSON(preferencesFile,{});
      await core.writeJSON(controlFile,{app:'yingti-desktop',pid:process.pid,instanceId,root,token,version});
      requestTimer=setInterval(async()=>{
        const request=await core.readJSON(requestFile);
        if(!request||request.requestId===lastRequest||typeof request.token!=='string')return;
        const a=Buffer.from(request.token), b=Buffer.from(token);
        if(a.length!==b.length||!timingSafeEqual(a,b))return;
        lastRequest=request.requestId;lastError='';saveStatus();exitApplication('update').catch(()=>{});
      },500);
      backend=await core.startBackend(root,dataDir);
      const icon=nativeImage.createFromPath(path.join(root,'YingTiStudio.ico'));
      tray=new Tray(icon);tray.setToolTip('映替视频工作台');
      tray.setContextMenu(Menu.buildFromTemplate([{label:'打开映替',click:showWindow},{type:'separator'},{label:'退出映替',click:()=>exitApplication().catch(()=>{})}]));
      tray.on('click',showWindow);tray.on('double-click',showWindow);
      await createWindow();
      let missing=0;
      healthTimer=setInterval(async()=>{
        if(quitting)return;
        try{const health=await core.getJSON(backend.origin+'/api/health',1500);if(health.instanceId!==instanceId)throw new Error('Instance changed');missing=0;}
        catch{if(++missing>=3){quitting=true;clearInterval(requestTimer);clearInterval(healthTimer);if(tray)tray.destroy();await fs.unlink(controlFile).catch(()=>{});await saveStatus();app.quit();}}
      },2000);
    })();
    bootPromise.catch(async error=>{await log(error);clearInterval(requestTimer);quitting=true;if(tray)tray.destroy();await fs.unlink(controlFile).catch(()=>{});dialog.showErrorBox('映替启动失败',error.message+'\n请查看数据目录 desktop-error.log。');app.quit();});
  });
}
