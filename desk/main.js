'use strict';
/*
 * Rolling Desk — the producer's desktop app for a Rolling studio. Two ways to use it:
 *
 *   Connect to a studio   your studio runs on a server; the app opens it (the audio Console, show control…) in its
 *                         own window and saves every recording on this computer as well (see mirror.js)
 *   Host it myself        no server: the app runs the whole studio on this computer and gives guests a free
 *                         internet link to it (see host.js). Recordings are saved in the studio folder you pick.
 */
const { app, BrowserWindow, Menu, dialog, shell, session, powerSaveBlocker, ipcMain, desktopCapturer, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { Mirror, parseHostLink } = require('./mirror');
const { Updater } = require('./updater');
const { LocalStudio } = require('./host');

if (process.env.ROLLING_DESK_HOME) app.setPath('userData', process.env.ROLLING_DESK_HOME); // for tests
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');
let config = { mode: 'connect', link: '', folder: '', studioFolder: '', removeLive: true };
let win = null, mirror = null, lastStatus = null, blocker = null, quitting = false, updater = null, offerWhenSafe = false;
let studio = null, guestLink = '', studioBase = '';

const log = (level, msg, err) => { (level === 'error' || level === 'warn' ? console.error : console.log)(`[${level}] ${msg}${err ? ' — ' + (err.stack || err.message) : ''}`); };
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG(), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') log('warn', 'settings file unreadable — starting fresh', e); }
  if (!config.folder) config.folder = path.join(app.getPath('home'), 'Rolling Recordings');
  if (!config.studioFolder) config.studioFolder = path.join(app.getPath('home'), 'Rolling Studio');
}
function saveConfig() { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(config, null, 1)); }
const hosting = () => config.mode === 'host' && !!studio;
const savedFolder = () => (config.mode === 'host' ? config.studioFolder : config.folder);

// where the bundled studio and its tools are: inside the installed app, or (while developing) the project itself
const studioDir = () => (app.isPackaged ? path.join(__dirname, 'studio') : path.join(__dirname, '..'));
const toolsDir = () => process.env.ROLLING_DESK_TOOLS || (app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, 'vendor', 'tools'));

// keep the computer awake while recording/saving — or for as long as it's hosting the studio
function keepAwake(on) {
  if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

// ---------- local saving (connected to a server) ----------
function startMirror() {
  if (mirror) mirror.stop();
  mirror = new Mirror({ link: config.link, folder: config.folder, removeLive: config.removeLive, log });
  mirror.on('status', s => {
    lastStatus = s;
    if (win && !win.isDestroyed()) win.webContents.send('desk-status', s);
    keepAwake(s.busy);
    if (!s.busy && offerWhenSafe) offerRestart();
  });
  mirror.start().catch(e => log('error', 'local saving could not start', e));
}
function stopEverything() {
  if (mirror) { mirror.stop(); mirror = null; lastStatus = null; }
  if (studio) { studio.stop(); studio = null; guestLink = ''; }
  keepAwake(false);
}

// is a show going on? (recording, files still uploading or being made, or people in the studio)
async function showInProgress() {
  if (hosting()) {
    const b = await studio.busy();
    if (!b || b.unknown) return b ? 'The studio couldn\'t say whether a show is going on.' : '';
    const bits = [];
    if (b.recording.length) bits.push(`recording in ${b.recording.join(', ')}`);
    if (b.processing.length) bits.push(`still receiving or making the files for ${[...new Set(b.processing)].join(', ')}`);
    if (b.online) bits.push(`${b.online} ${b.online === 1 ? 'person is' : 'people are'} in the studio`);
    return bits.length ? `Your studio is ${bits.join(', and ')}.` : '';
  }
  return lastStatus && lastStatus.busy ? `Rolling Desk is still saving your recording. ${lastStatus.detail}` : '';
}

// ---------- updates from GitHub (never while a show is going on) ----------
async function checkForUpdates(byHand = false) {
  if (!updater) return;
  try {
    const info = await updater.check();
    if (!info) { if (byHand) dialog.showMessageBox({ message: `Rolling Desk ${app.getVersion()} is the newest version.` }); return; }
    if (updater.kind() === 'manual' || !info.asset || !updater.canReplace()) {
      const c = await dialog.showMessageBox({ type: 'info', buttons: ['Open the download page', 'Later'], defaultId: 0, cancelId: 1, message: `Rolling Desk ${info.version} is out`, detail: 'This copy can\'t update itself (Windows, the Linux .deb, or a read-only folder). Download the new version from GitHub.' });
      if (c.response === 0) shell.openExternal(info.page);
      return;
    }
    if (!updater.ready || updater.ready.version !== info.version) await updater.download(info);
    offerRestart();
  } catch (e) { log('warn', 'update check: ' + e.message, e); if (byHand) dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t check for updates', detail: e.message }); }
}
async function offerRestart() {
  if (!updater || !updater.ready) return;
  if (await showInProgress()) { // ask again once the show is over
    offerWhenSafe = true;
    if (hosting()) setTimeout(() => offerRestart().catch(e => log('warn', 'update prompt', e)), 60000);
    return;
  }
  offerWhenSafe = false;
  const c = await dialog.showMessageBox({ type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, message: `Rolling Desk ${updater.ready.version} is ready`, detail: 'Restart to start using it. Your settings and recordings are kept.' });
  if (c.response === 0) { updater.apply(); quitting = true; app.quit(); }
}

// ---------- windows ----------
// swap windows safely: the old one is hidden now and destroyed a moment later, after the new one exists (closing a
// window from inside its own menu click crashes Electron on macOS, and closing the last window would quit the app)
function closeWindow() {
  const old = win; win = null;
  if (!old || old.isDestroyed()) return;
  old.removeAllListeners('close'); old.hide();
  setTimeout(() => { if (!old.isDestroyed()) old.destroy(); }, 250);
}
function openConnect(error = '') {
  closeWindow();
  win = new BrowserWindow({ width: 680, height: 720, title: 'Rolling Desk', backgroundColor: '#0d0f12',
    webPreferences: { preload: path.join(__dirname, 'connect-preload.js'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'connect.html'), { query: { mode: config.mode, link: config.link || '', folder: config.folder, studioFolder: config.studioFolder, error } });
}

// the studio's own window: the dashboard / Console. Only the studio's pages open in it; links elsewhere open in your browser.
function studioWindow(base) {
  studioBase = base;
  closeWindow();
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'Rolling Desk', backgroundColor: '#0d0f12',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  // camera/mic (talkback) and full screen only for your studio; everything else is refused
  session.defaultSession.setPermissionRequestHandler((wc, perm, done, details) => done(new URL(details.requestingUrl || wc.getURL()).origin === studioBase && ['media', 'fullscreen', 'notifications', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => origin === studioBase && ['media', 'fullscreen'].includes(perm));
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => desktopCapturer.getSources({ types: ['screen'] }).then(s => cb(s[0] ? { video: s[0] } : {})).catch(e => { log('warn', 'screen share', e); cb({}); }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    const here = localize(url);
    if (here !== url) { win.loadURL(here); return { action: 'deny' }; } // your own studio's guest-link address: open it here
    if (new URL(url).origin === studioBase) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, webPreferences: { contextIsolation: true, sandbox: true } } };
    shell.openExternal(url).catch(e => log('warn', 'open link', e)); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const here = localize(url);
    if (here !== url) { e.preventDefault(); win.loadURL(here); return; }
    if (new URL(url).origin !== studioBase) { e.preventDefault(); shell.openExternal(url).catch(er => log('warn', 'open link', er)); } });
  win.webContents.on('did-finish-load', () => { if (lastStatus) win.webContents.send('desk-status', lastStatus); });
  win.webContents.on('did-fail-load', (e, code, desc, url) => { if (code !== -3) win.loadURL(`data:text/html,<body style="font:16px system-ui;background:#0d0f12;color:#eee;padding:40px"><h2>Can't reach your studio</h2><p>${desc} (${url})</p><p>Check the internet connection and that the studio is running, then use View › Reload.</p>`); });
  win.on('page-title-updated', e => { e.preventDefault(); setTitle(); });
  win.on('close', e => { // never cut a show off by closing too early
    if (quitting) return;
    e.preventDefault();
    showInProgress().then(why => {
      const leaving = hosting() ? 'Closing Rolling Desk stops your studio: everyone is disconnected and guests can\'t join.' : 'If you close now, the copy on this computer stops part-way. The studio server still has everything.';
      if (!why && !hosting()) { quitting = true; win.close(); return; }
      const c = dialog.showMessageBoxSync(win, { type: why ? 'warning' : 'question', buttons: [hosting() ? 'Keep the studio running' : 'Keep saving', hosting() ? 'Close and stop the studio' : 'Close anyway'], defaultId: 0, cancelId: 0,
        message: why || 'Stop hosting your studio?', detail: leaving });
      if (c === 1) { quitting = true; win.close(); }
    }).catch(er => log('warn', 'close check', er));
  });
  buildMenu();
}
// when hosting, links to the studio's public address (the dashboard shows those, for guests) open on this computer
function localize(url) {
  try {
    const u = new URL(url);
    if (hosting() && guestLink && u.origin === new URL(guestLink).origin) return studioBase + u.pathname + u.search + u.hash;
  } catch (e) { log('warn', 'odd link ' + url, e); }
  return url;
}
function setTitle() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(hosting() ? `Rolling Desk — hosting on this computer · guests: ${guestLink || 'getting a link…'}` : 'Rolling Desk');
}

function openStudio() {
  const { base } = parseHostLink(config.link);
  studioWindow(base);
  win.loadURL(config.link);
  startMirror();
}

async function openHost() {
  stopEverything();
  studioWindow('');
  win.loadURL('data:text/html,<body style="font:18px system-ui;background:#0d0f12;color:#eee;padding:60px"><h2>🎛 Starting your studio…</h2><p>Getting it ready on this computer, then a link for your guests.</p>');
  studio = new LocalStudio({ studioDir: studioDir(), toolsDir: toolsDir(), dataDir: config.studioFolder, secretsFile: path.join(app.getPath('userData'), 'studio-secrets.json'), nodePath: process.execPath, log });
  studio.on('tunnel', t => onTunnel(t).catch(e => log('warn', 'guest link', e)));
  studio.on('crashed', why => { if (!quitting) openConnect(`Your studio stopped unexpectedly (${why}). Recordings already made are safe in ${config.studioFolder}. Press Start to run it again.`); });
  let local;
  try { local = await studio.start(); }
  catch (e) { log('error', 'could not start the studio', e); stopEverything(); openConnect(e.message); return; }
  keepAwake(true);
  studioBase = local; buildMenu();
  // sign in to your own studio for you (its password is made and kept by the app)
  await win.loadURL(local + '/api/ping');
  const ok = await win.webContents.executeJavaScript(`fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ password: studio.password }))} }).then(r => r.ok)`);
  if (!ok) log('warn', 'automatic sign-in failed — the admin password was changed on the dashboard');
  await win.loadURL(local + '/');
  setTitle();
}

async function onTunnel(t) {
  if (t.url) { guestLink = t.url; setTitle(); }
  if (!win || win.isDestroyed()) return;
  const onDashboard = () => { try { return new URL(win.webContents.getURL()).pathname === '/'; } catch { return false; } };
  if (t.url && t.ready === undefined && onDashboard()) win.webContents.reload(); // the dashboard's links now show the guest link
  if (t.changed) {
    dialog.showMessageBox(win, { type: 'warning', buttons: ['Copy the new link', 'OK'], message: 'Your studio has a new internet address',
      detail: `The guest link dropped and a new one was made:\n${t.url}\n\nAnyone who was disconnected needs the new link (use "Copy guest link" in the studio). Recordings are safe — they upload when people come back.` })
      .then(c => { if (c.response === 0) clipboard.writeText(t.url); }).catch(e => log('warn', 'link dialog', e));
  }
  if (t.error && !t.url) log('warn', t.error);
}

// ---------- talking to the pages ----------
ipcMain.handle('desk:open-folder', () => shell.openPath(savedFolder()));
ipcMain.handle('desk:pick-folder', async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', defaultPath: config.folder, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
const writable = folder => { try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); return ''; } catch (er) { return `Can't save in that folder: ${er.message}`; } };
ipcMain.handle('desk:connect', async (e, { link, folder }) => {
  let parsed;
  try { parsed = parseHostLink(link); } catch (er) { return { error: er.message }; }
  try { // check the link really opens the studio before switching to it
    const res = await fetch(`${parsed.base}/api/rooms/${parsed.roomId}?k=${encodeURIComponent(parsed.key)}`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 404) return { error: 'The studio didn\'t accept that link — copy "Open studio as host" again from your dashboard' };
    if (!res.ok) return { error: `The studio answered with an error (${res.status})` };
  } catch (er) { return { error: `Couldn't reach ${parsed.base} — check the link and your internet connection (${er.message})` }; }
  const bad = writable(folder); if (bad) return { error: bad };
  stopEverything();
  Object.assign(config, { mode: 'connect', link: link.trim(), folder }); saveConfig();
  openStudio();
  return { ok: true };
});
ipcMain.handle('desk:host', async (e, { folder }) => {
  // the studio gets a folder of its own, even if you pick e.g. your home folder
  if (path.basename(folder) !== 'Rolling Studio') folder = path.join(folder, 'Rolling Studio');
  const bad = writable(folder); if (bad) return { error: bad };
  Object.assign(config, { mode: 'host', studioFolder: folder }); saveConfig();
  openHost().catch(er => { log('error', 'hosting', er); openConnect(er.message); });
  return { ok: true };
});
ipcMain.handle('desk:status', () => lastStatus);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const back = async () => {
    const why = await showInProgress();
    if (hosting() || why) {
      const c = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', hosting() ? 'Stop the studio' : 'Switch anyway'], defaultId: 0, cancelId: 0, message: why || 'Stop hosting your studio?', detail: hosting() ? 'Everyone is disconnected and guests can\'t join until you host again.' : '' });
      if (c.response !== 1) return;
    }
    stopEverything(); openConnect();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: config.mode === 'host' ? 'Open studio folder (recordings)' : 'Open recordings folder', accelerator: 'CmdOrCtrl+Shift+O', click: () => shell.openPath(savedFolder()) },
      ...(hosting() ? [{ label: 'Copy the guest link address', click: () => guestLink && clipboard.writeText(guestLink) }] : []),
      { label: hosting() ? 'Stop hosting / connect to a studio instead…' : 'Connect to a different studio, or host it myself…', click: () => setTimeout(() => back().catch(er => log('warn', 'switch', er)), 0) }, // after the menu has closed
      { label: 'Check for updates…', click: () => checkForUpdates(true) },
      { type: 'separator' },
      ...(config.mode === 'connect' ? [{ label: 'Remove live copies once the finished files are saved', type: 'checkbox', checked: config.removeLive,
        click: i => { config.removeLive = i.checked; saveConfig(); if (mirror) mirror.removeLive = i.checked; } }, { type: 'separator' }] : []),
      isMac ? { role: 'close' } : { role: 'quit' },
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
    const start = () => {
      if (config.mode === 'host') return openHost().catch(e => { log('error', 'hosting', e); openConnect(e.message); });
      let ok = false;
      try { ok = !!config.link && !!parseHostLink(config.link); } catch (e) { log('warn', 'saved studio link is not usable', e); }
      return ok ? openStudio() : openConnect();
    };
    start();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) start(); });
  });
  app.on('before-quit', e => { // Cmd+Q / Quit: ask first if a show is going on (the window's close check does that)
    if (!quitting && win && !win.isDestroyed()) { e.preventDefault(); win.close(); return; }
    stopEverything();
  });
  app.on('window-all-closed', () => app.quit());
}
