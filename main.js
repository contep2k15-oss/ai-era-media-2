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

ipcMain.handle('open-file', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});

function getFFmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

// ── RENDER VIDEO: imageList + audioData → MP4 ──
ipcMain.handle('render-video-ffmpeg', async (event, { imageList, audioData, fps, width, height, filename }) => {
  const { spawn } = require('child_process');
  let ffmpegPath;
  try { ffmpegPath = getFFmpegPath(); } catch(e) {
    return { success: false, error: 'ffmpeg-static chưa cài: ' + e.message };
  }

  const tmpDir = os.tmpdir();
  const sessionId = Date.now();
  const framesDir = path.join(tmpDir, `aiera_${sessionId}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const tmpFiles = []; // track files to cleanup

  // Chuẩn bị từng ảnh → file tạm nếu cần (dataUrl → file)
  const preparedImages = [];
  for (let i = 0; i < imageList.length; i++) {
    const item = imageList[i];
    if (item.filePath && fs.existsSync(item.filePath)) {
      // Dùng thẳng file gốc — KHÔNG tốn IPC data
      preparedImages.push({ filePath: item.filePath, dur: item.dur });
    } else if (item.dataUrl) {
      // Fallback: dataUrl → ghi file tạm
      const ext = item.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
      const tmpImg = path.join(framesDir, `img_${String(i).padStart(4,'0')}.${ext}`);
      const base64 = item.dataUrl.split(',')[1];
      fs.writeFileSync(tmpImg, Buffer.from(base64, 'base64'));
      tmpFiles.push(tmpImg);
      preparedImages.push({ filePath: tmpImg, dur: item.dur });
    }
  }

  // Chuẩn bị audio
  let audioPath;
  if (audioData.filePath && fs.existsSync(audioData.filePath)) {
    audioPath = audioData.filePath; // Dùng thẳng file gốc
  } else if (audioData.wavBytes) {
    audioPath = path.join(framesDir, `audio_${sessionId}.wav`);
    fs.writeFileSync(audioPath, Buffer.from(audioData.wavBytes));
    tmpFiles.push(audioPath);
  }

  // Hỏi nơi lưu
  const win = BrowserWindow.getFocusedWindow();
  const saveResult = await dialog.showSaveDialog(win, {
    title: 'Lưu video MP4',
    defaultPath: path.join(os.homedir(), 'Desktop', filename || 'video.mp4'),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  function cleanup() {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    try { fs.rmdirSync(framesDir); } catch(e) {}
  }

  if (saveResult.canceled || !saveResult.filePath) {
    cleanup(); return { success: false, error: 'Đã hủy.' };
  }

  const outPath = saveResult.filePath;

  // Build FFmpeg args: mỗi ảnh loop đúng thời lượng
  // ffmpeg -loop 1 -t DUR -i img1 -loop 1 -t DUR -i img2 ... -i audio
  //        -filter_complex "[0][1][2]concat=n=N:v=1:a=0[v]" -map "[v]" -map N:a ...
  const args = [];
  preparedImages.forEach(img => {
    args.push('-loop', '1', '-t', String(img.dur), '-i', img.filePath);
  });
  args.push('-i', audioPath);

  const n = preparedImages.length;
  const audioIdx = n;

  // Filter: scale tất cả ảnh về cùng resolution rồi concat
  const scaleFilters = preparedImages.map((_, i) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`
  ).join(';');
  const concatInputs = preparedImages.map((_,i) => `[v${i}]`).join('');
  const filterComplex = `${scaleFilters};${concatInputs}concat=n=${n}:v=1:a=0[vout]`;

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', `${audioIdx}:a`,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    '-y',
    outPath
  );

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', (code) => {
      cleanup();
      if (code === 0) resolve({ success: true, outPath });
      else resolve({ success: false, error: `FFmpeg lỗi (${code}): ` + stderr.slice(-600) });
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
