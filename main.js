const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { URL } = require('url');

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

// ── GOOGLE OAUTH2 CONFIG ──
// Credentials được load từ file config riêng (không commit lên Git)
let OAUTH_CLIENT_ID = '738539837274-00os94b9bbn5iid8bkmbhuq647t4qc80.apps.googleusercontent.com';
let OAUTH_CLIENT_SECRET = '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';
const OAUTH_SCOPES = 'https://www.googleapis.com/auth/cloud-platform';
let TOKEN_PATH = '';

// Load credentials từ file config
function loadOAuthConfig() {
  // Thử các đường dẫn theo thứ tự
  const paths = [
    path.join(process.resourcesPath || '', 'oauth_config.json'),
    path.join(__dirname, 'oauth_config.json'),
    path.join(app.getPath('userData'), 'oauth_config.json'),
  ];
  for (const configPath of paths) {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        OAUTH_CLIENT_ID = config.client_id || '';
        OAUTH_CLIENT_SECRET = config.client_secret || '';
        console.log('OAuth config loaded from:', configPath);
        return;
      }
    } catch(e) {}
  }
  // Fallback: dùng credentials mặc định
  OAUTH_CLIENT_ID = '738539837274-00os94b9bbn5iid8bkmbhuq647t4qc80.apps.googleusercontent.com';
  OAUTH_CLIENT_SECRET = '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';
  console.log('OAuth config: using default credentials');
}
let vertexTokenData = null;

// Load saved token on startup
function loadSavedToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      vertexTokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    }
  } catch(e) {}
}

// Save token to disk
function saveToken(tokenData) {
  vertexTokenData = tokenData;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData));
}

// Get valid access token (refresh if expired)
async function getValidAccessToken() {
  if (!vertexTokenData) return null;
  const now = Date.now();
  // Token còn hạn (buffer 5 phút)
  if (vertexTokenData.access_token && vertexTokenData.expires_at > now + 300000) {
    return vertexTokenData.access_token;
  }
  // Refresh token
  if (vertexTokenData.refresh_token) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: OAUTH_CLIENT_ID,
          client_secret: OAUTH_CLIENT_SECRET,
          refresh_token: vertexTokenData.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const data = await res.json();
      if (data.access_token) {
        vertexTokenData.access_token = data.access_token;
        vertexTokenData.expires_at = Date.now() + (data.expires_in * 1000);
        saveToken(vertexTokenData);
        return data.access_token;
      }
    } catch(e) {}
  }
  return null;
}

// OAuth2 login flow với local redirect server
ipcMain.handle('google-oauth-login', async () => {
  return new Promise((resolve) => {
    // Start local server để catch OAuth callback
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:4389');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;padding:20px"><h2>❌ Đã hủy đăng nhập</h2><p>Bạn có thể đóng tab này.</p></body></html>');
        server.close();
        resolve({ success: false, error });
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;padding:20px;background:#0a0f0e;color:#10b981"><h2>✅ Đăng nhập thành công!</h2><p style="color:#94a3b8">Bạn có thể đóng tab này và quay lại app.</p></body></html>');

        // Exchange code for token
        try {
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: OAUTH_CLIENT_ID,
              client_secret: OAUTH_CLIENT_SECRET,
              redirect_uri: 'http://localhost:4389/callback',
              grant_type: 'authorization_code'
            })
          });
          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            tokenData.expires_at = Date.now() + (tokenData.expires_in * 1000);
            saveToken(tokenData);
            server.close();
            resolve({ success: true });
          } else {
            server.close();
            resolve({ success: false, error: tokenData.error_description || 'Token exchange failed' });
          }
        } catch(e) {
          server.close();
          resolve({ success: false, error: e.message });
        }
      }
    });

    server.listen(4389, () => {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${OAUTH_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent('http://localhost:4389/callback')}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
        `&access_type=offline` +
        `&prompt=consent`;
      shell.openExternal(authUrl);
    });

    // Timeout sau 5 phút
    setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'Timeout' });
    }, 300000);
  });
});

ipcMain.handle('google-get-token', async () => {
  const token = await getValidAccessToken();
  return token;
});

ipcMain.handle('google-logout', async () => {
  vertexTokenData = null;
  try { fs.unlinkSync(TOKEN_PATH); } catch(e) {}
  return { success: true };
});

ipcMain.handle('google-auth-status', async () => {
  const token = await getValidAccessToken();
  return { loggedIn: !!token };
});

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

app.whenReady().then(() => {
  TOKEN_PATH = path.join(app.getPath('userData'), 'vertex_token.json');
  loadOAuthConfig();
  loadSavedToken();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
