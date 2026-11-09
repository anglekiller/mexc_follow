const { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB_ROOT = path.join(__dirname, 'web');
const APP_ORIGIN = 'app://mexc-guard';

// The web export uses absolute paths ("/_expo/..."), which need a real origin rather than file://.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------- Encrypted key/value store (API keys, settings) ----------

const storeFile = () => path.join(app.getPath('userData'), 'secure-store.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  const file = storeFile();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function registerStore() {
  ipcMain.handle('store:get', (_e, key) => {
    const value = readStore()[key];
    return value === undefined ? null : safeStorage.decryptString(Buffer.from(value, 'base64'));
  });
  ipcMain.handle('store:set', (_e, key, value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is unavailable');
    writeStore({ ...readStore(), [key]: safeStorage.encryptString(String(value)).toString('base64') });
  });
  ipcMain.handle('store:remove', (_e, key) => {
    const data = readStore();
    delete data[key];
    writeStore(data);
  });
}

// ---------- Window ----------

function serveApp() {
  protocol.handle('app', (request) => {
    const requested = path.normalize(path.join(WEB_ROOT, decodeURIComponent(new URL(request.url).pathname)));
    const inside = requested.startsWith(WEB_ROOT + path.sep);
    const file = inside && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(WEB_ROOT, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Google News answers 403 to requests that reveal an app:// origin or an Electron user agent. */
function normalizeOutgoingRequests() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers.Origin;
    delete headers.Referer;
    headers['User-Agent'] = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 430,
    height: 880,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Exchange and news APIs send no CORS headers. Only the bundled app ever runs in this window.
      webSecurity: false,
    },
  });

  const isHttp = (url) => /^https?:\/\//i.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    event.preventDefault();
    if (isHttp(url)) shell.openExternal(url);
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerStore();
    serveApp();
    normalizeOutgoingRequests();
    createWindow();
  });
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
