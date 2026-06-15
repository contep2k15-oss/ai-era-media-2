const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Window controls
ipcMain.on('win-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('win-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on('win-close', () => BrowserWindow.getFocusedWindow()?.close());

// ── FFmpeg convert WebM → MP4 ──
ipcMain.handle('convert-to-mp4', async (event, { webmBuffer, filename }) => {
  let ffmpegPath;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch(e) {
    return { success: false, error: 'ffmpeg-static chưa được cài. Chạy npm install.' };
  }

  const { spawn } = require('child_process');

  // Lưu WebM tạm
  const tmpDir = os.tmpdir();
  const tmpWebm = path.join(tmpDir, `aiera_tmp_${Date.now()}.webm`);
  const tmpMp4  = path.join(tmpDir, `aiera_tmp_${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpWebm, Buffer.from(webmBuffer));
  } catch(e) {
    return { success: false, error: 'Không ghi được file tạm: ' + e.message };
  }

  // Hỏi user lưu file ở đâu
  const win = BrowserWindow.getFocusedWindow();
  const saveResult = await dialog.showSaveDialog(win, {
    title: 'Lưu video MP4',
    defaultPath: path.join(os.homedir(), 'Desktop', filename || 'video.mp4'),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    fs.unlinkSync(tmpWebm);
    return { success: false, error: 'Đã hủy lưu file.' };
  }

  const outPath = saveResult.filePath;

  // Chạy FFmpeg convert
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-i', tmpWebm,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outPath
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      // Dọn file tạm
      try { fs.unlinkSync(tmpWebm); } catch(e) {}
      try { fs.unlinkSync(tmpMp4); } catch(e) {}

      if (code === 0) {
        resolve({ success: true, outPath });
      } else {
        resolve({ success: false, error: 'FFmpeg lỗi (code ' + code + '): ' + stderr.slice(-300) });
      }
    });

    proc.on('error', (e) => {
      resolve({ success: false, error: 'Không chạy được FFmpeg: ' + e.message });
    });
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
