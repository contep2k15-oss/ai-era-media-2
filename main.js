const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    show: false,
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
}

ipcMain.on('win-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('win-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
});
ipcMain.on('win-close', () => BrowserWindow.getFocusedWindow()?.close());

// ── Helper: get ffmpeg path (handle asar) ──
function getFFmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

// ── RENDER VIDEO: frames PNG + audio WAV → MP4 via FFmpeg ──
ipcMain.handle('render-video-ffmpeg', async (event, { frames, audioBytes, fps, width, height, filename }) => {
  const { spawn } = require('child_process');
  let ffmpegPath;
  try { ffmpegPath = getFFmpegPath(); } catch(e) {
    return { success: false, error: 'ffmpeg-static chưa cài: ' + e.message };
  }

  const tmpDir = os.tmpdir();
  const sessionId = Date.now();
  const framesDir = path.join(tmpDir, `aiera_frames_${sessionId}`);
  const audioPath = path.join(tmpDir, `aiera_audio_${sessionId}.wav`);
  const tmpOut   = path.join(tmpDir, `aiera_out_${sessionId}.mp4`);

  // Tạo folder frames
  fs.mkdirSync(framesDir, { recursive: true });

  // Ghi từng frame PNG
  for (let i = 0; i < frames.length; i++) {
    const buf = Buffer.from(frames[i], 'base64');
    fs.writeFileSync(path.join(framesDir, `frame_${String(i).padStart(6,'0')}.png`), buf);
  }

  // Ghi audio WAV
  fs.writeFileSync(audioPath, Buffer.from(audioBytes));

  // Hỏi nơi lưu
  const win = BrowserWindow.getFocusedWindow();
  const saveResult = await dialog.showSaveDialog(win, {
    title: 'Lưu video MP4',
    defaultPath: path.join(os.homedir(), 'Desktop', filename || 'video.mp4'),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    cleanup(); return { success: false, error: 'Đã hủy.' };
  }

  const outPath = saveResult.filePath;

  function cleanup() {
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}
    try { fs.unlinkSync(tmpOut); } catch(e) {}
  }

  // Chạy FFmpeg: ghép frames + audio → MP4
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame_%06d.png'),
      '-i', audioPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      outPath
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      cleanup();
      if (code === 0) {
        resolve({ success: true, outPath });
      } else {
        resolve({ success: false, error: `FFmpeg lỗi (${code}): ` + stderr.slice(-500) });
      }
    });

    proc.on('error', (e) => {
      cleanup();
      resolve({ success: false, error: 'Không chạy được FFmpeg: ' + e.message });
    });
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
