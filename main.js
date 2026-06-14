const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

// Fix for fetch/API calls in Electron
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,          // dùng custom titlebar của app
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,  // cho phép fetch API bên ngoài (Anthropic, OpenAI...)
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
  });

  // Mở link ngoài bằng trình duyệt hệ thống
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// IPC: window controls (minimize / maximize / close)
ipcMain.on('win-minimize', () => {
  BrowserWindow.getFocusedWindow()?.minimize();
});
ipcMain.on('win-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on('win-close', () => {
  BrowserWindow.getFocusedWindow()?.close();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
