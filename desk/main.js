'use strict';
/*
 * Rolling Desk — the producer's desktop app for a Rolling studio.
 * Opens your studio (the audio Console, show control…) in its own window and saves every recording on this
 * computer as well as on the server (see mirror.js). Nothing about the studio itself changes: the app is a client
 * of the same server, using the same host link as a browser.
 */
const { app, BrowserWindow, Menu, dialog, shell, session, powerSaveBlocker, ipcMain, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { Mirror, parseHostLink } = require('./mirror');
const { Updater } = require('./updater');

if (process.env.ROLLING_DESK_HOME) app.setPath('userData', process.env.ROLLING_DESK_HOME); // for tests
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');
let config = { link: '', folder: '', removeLive: true };
let win = null, mirror = null, lastStatus = null, blocker = null, quitting = false, updater = null, offerWhenSafe = false;

const log = (level, msg, err) => { (level === 'error' || level === 'warn' ? console.error : console.log)(`[${level}] ${msg}${err ? ' — ' + (err.stack || err.message) : ''}`); };
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG(), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') log('warn', 'settings file unreadable — starting fresh', e); }
  if (!config.folder) config.folder = path.join(app.getPath('home'), 'Rolling Recordings');
}
function saveConfig() { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(config, null, 1)); }

// ---------- local saving ----------
function startMirror() {
  if (mirror) mirror.stop();
  mirror = new Mirror({ link: config.link, folder: config.folder, removeLive: config.removeLive, log });
  mirror.on('status', s => {
    lastStatus = s;
    if (win && !win.isDestroyed()) win.webContents.send('desk-status', s);
    // keep the computer awake while recording or saving; let it sleep when everything is safe
    if (s.busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!s.busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    if (!s.busy && offerWhenSafe) offerRestart();
  });
  mirror.start().catch(e => log('error', 'local saving could not start', e));
}

// ---------- updates from GitHub (never while recording or saving) ----------
async function checkForUpdates(byHand = false) {
  if (!updater) return;
  try {
    const info = await updater.check();
    if (!info) { if (byHand) dialog.showMessageBox({ message: `Rolling Desk ${app.getVersion()} is the newest version.` }); return; }
    if (updater.kind() === 'manual' || !info.asset || !updater.canReplace()) {
      const c = await dialog.showMessageBox({ type: 'info', buttons: ['Open the download page', 'Later'], defaultId: 0, cancelId: 1, message: `Rolling Desk ${info.version} is out`, detail: 'This copy can\'t update itself (it was installed from the .deb, or its folder is read-only). Download the new version from GitHub.' });
      if (c.response === 0) shell.openExternal(info.page);
      return;
    }
    if (!updater.ready || updater.ready.version !== info.version) await updater.download(info);
    offerRestart();
  } catch (e) { log('warn', 'update check: ' + e.message, e); if (byHand) dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t check for updates', detail: e.message }); }
}
function offerRestart() {
  if (!updater || !updater.ready) return;
  if (lastStatus && lastStatus.busy) { offerWhenSafe = true; return; } // ask again once everything is saved
  offerWhenSafe = false;
  dialog.showMessageBox({ type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, message: `Rolling Desk ${updater.ready.version} is ready`, detail: 'Restart to start using it. Your settings and recordings are kept.' })
    .then(c => { if (c.response === 0) { updater.apply(); quitting = true; app.quit(); } })
    .catch(e => log('warn', 'update prompt', e));
}

// ---------- windows ----------
function openConnect(error = '') {
  if (win) { win.removeAllListeners('close'); win.close(); }
  win = new BrowserWindow({ width: 640, height: 560, title: 'Rolling Desk', backgroundColor: '#0d0f12',
    webPreferences: { preload: path.join(__dirname, 'connect-preload.js'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'connect.html'), { query: { link: config.link || '', folder: config.folder, error } });
}
function openStudio() {
  const { base } = parseHostLink(config.link);
  if (win) { win.removeAllListeners('close'); win.close(); }
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'Rolling Desk', backgroundColor: '#0d0f12',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  // camera/mic (talkback) and full screen only for your studio; everything else is refused
  session.defaultSession.setPermissionRequestHandler((wc, perm, done, details) => done(new URL(details.requestingUrl || wc.getURL()).origin === base && ['media', 'fullscreen', 'notifications', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => origin === base && ['media', 'fullscreen'].includes(perm));
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => desktopCapturer.getSources({ types: ['screen'] }).then(s => cb(s[0] ? { video: s[0] } : {})).catch(e => { log('warn', 'screen share', e); cb({}); }));
  // links to your studio open in the app (e.g. Recordings); anything else in your normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === base) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, webPreferences: { contextIsolation: true, sandbox: true } } };
    shell.openExternal(url).catch(e => log('warn', 'open link', e)); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== base) { e.preventDefault(); shell.openExternal(url).catch(er => log('warn', 'open link', er)); } });
  win.webContents.on('did-finish-load', () => { if (lastStatus) win.webContents.send('desk-status', lastStatus); });
  win.webContents.on('did-fail-load', (e, code, desc, url) => { if (code !== -3) win.loadURL(`data:text/html,<body style="font:16px system-ui;background:#0d0f12;color:#eee;padding:40px"><h2>Can't reach your studio</h2><p>${desc} (${url})</p><p>Check the internet connection and that the studio is running, then use View › Reload.</p>`); });
  win.on('close', e => { // never lose a recording by closing too early
    if (quitting || !lastStatus || !lastStatus.busy) return;
    const c = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep saving', 'Close anyway'], defaultId: 0, cancelId: 0,
      message: 'Rolling Desk is still saving your recording', detail: `${lastStatus.detail}\n\nIf you close now, the copy on this computer stops part-way. The studio server still has everything.` });
    if (c === 0) e.preventDefault(); else quitting = true;
  });
  win.loadURL(config.link);
  startMirror();
  buildMenu();
}

// ---------- talking to the pages ----------
ipcMain.handle('desk:open-folder', () => shell.openPath(config.folder));
ipcMain.handle('desk:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should Rolling Desk save recordings?', defaultPath: config.folder, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('desk:connect', async (e, { link, folder }) => {
  let parsed;
  try { parsed = parseHostLink(link); } catch (er) { return { error: er.message }; }
  try { // check the link really opens the studio before switching to it
    const res = await fetch(`${parsed.base}/api/rooms/${parsed.roomId}?k=${encodeURIComponent(parsed.key)}`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 404) return { error: 'The studio didn\'t accept that link — copy "Open studio as host" again from your dashboard' };
    if (!res.ok) return { error: `The studio answered with an error (${res.status})` };
  } catch (er) { return { error: `Couldn't reach ${parsed.base} — check the link and your internet connection (${er.message})` }; }
  try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); }
  catch (er) { return { error: `Can't save in that folder: ${er.message}` }; }
  config.link = link.trim(); config.folder = folder; saveConfig();
  openStudio();
  return { ok: true };
});
ipcMain.handle('desk:status', () => lastStatus);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open recordings folder', accelerator: 'CmdOrCtrl+Shift+O', click: () => shell.openPath(config.folder) },
      { label: 'Connect to a different studio or show…', click: () => openConnect() },
      { label: 'Check for updates…', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Remove live copies once the finished files are saved', type: 'checkbox', checked: config.removeLive,
        click: i => { config.removeLive = i.checked; saveConfig(); if (mirror) mirror.removeLive = i.checked; } },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Rolling on GitHub', click: () => shell.openExternal('https://github.com/Samfox84/Rolling') }] },
  ]));
}

// ---------- start ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    loadConfig(); buildMenu();
    updater = new Updater({ current: app.getVersion(), workDir: app.getPath('userData'), log, ...(process.env.ROLLING_DESK_UPDATE_API ? { api: process.env.ROLLING_DESK_UPDATE_API } : {}) });
    if (app.isPackaged || process.env.ROLLING_DESK_UPDATE_API) { setTimeout(() => checkForUpdates(), 15000); setInterval(() => checkForUpdates(), 6 * 3600 * 1000); }
    let ok = false;
    try { ok = !!config.link && !!parseHostLink(config.link); } catch (e) { log('warn', 'saved studio link is not usable', e); }
    if (ok) openStudio(); else openConnect();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) (config.link ? openStudio() : openConnect()); });
  });
  app.on('before-quit', () => { if (mirror) mirror.stop(); });
  app.on('window-all-closed', () => app.quit());
}
