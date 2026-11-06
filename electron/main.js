// Agent Hub — оболочка приложения (Electron). Запускает сервер внутри себя и показывает интерфейс
// в собственном окне: свой заголовок, иконка, без адресной строки и меню браузера.
const { app, BrowserWindow, shell, Menu, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Agent Hub');
app.setAppUserModelId('AgentHub.App');
nativeTheme.themeSource = 'dark';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// данные — в профиле пользователя, проекты — в «Документах»
process.env.AGENT_HUB_DATA = path.join(app.getPath('userData'), 'data');
process.env.AGENT_HUB_PROJECTS = path.join(app.getPath('documents'), 'AgentHub');

// одноразовый перенос данных из прежней версии (exe рядом с папкой data)
function migrateLegacy() {
  const target = process.env.AGENT_HUB_DATA;
  if (fs.existsSync(path.join(target, 'state.json'))) return;
  const candidates = [
    path.join(app.getPath('desktop'), 'AgentHub', 'agent-hub', 'dist', 'data'),
    path.join(path.dirname(process.execPath), '..', 'agent-hub', 'dist', 'data'),
  ];
  const src = candidates.find((p) => fs.existsSync(path.join(p, 'state.json')));
  if (!src) return;
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === 'window' || name.endsWith('.log')) continue; // профиль окна Edge и логи не нужны
    fs.cpSync(path.join(src, name), path.join(target, name), { recursive: true });
  }
}
try { migrateLegacy(); } catch (e) { console.error('migrate', e); }

const hub = require('../server.js');
let win = null;
let quitting = false;

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1000, minHeight: 640,
    title: 'Agent Hub',
    backgroundColor: '#0a0c11',
    icon: path.join(__dirname, 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1117', symbolColor: '#aab3c5', height: 44 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(url);
  // все внешние ссылки — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u); } });
  // без браузерных зума и перезагрузок по случайным клавишам
  win.webContents.on('before-input-event', (e, input) => {
    if (input.control && ['+', '-', '=', '0'].includes(input.key) && !app.isPackaged) return;
    if (input.control && input.key.toLowerCase() === 'r' && app.isPackaged) e.preventDefault();
  });
  win.webContents.setVisualZoomLevelLimits(1, 1);
  // закрытие окна, когда агенты ещё работают, — спрашиваем
  win.on('close', async (e) => {
    if (quitting || !hub.isBusy()) return;
    e.preventDefault();
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Закрыть', 'Отмена'], defaultId: 1, cancelId: 1, title: 'Agent Hub', message: 'Агенты ещё работают. Закрыть приложение и остановить их?' });
    if (r.response === 0) { quitting = true; win.close(); }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Папка проекта', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const url = await hub.start();
    createWindow(url);
  } catch (e) {
    dialog.showErrorBox('Agent Hub', 'Не удалось запустить: ' + e.message);
    app.quit();
  }
});

app.on('before-quit', () => { quitting = true; hub.shutdown(); });
app.on('window-all-closed', () => app.quit());
