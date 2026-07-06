const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { URL } = require('url');
const edgeTTS = require('./edge-tts');

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Edge TTS IPC
ipcMain.handle('edge-tts', async (event, { text, voice, rate, pitch }) => {
  try {
    console.log('[Edge TTS] voice=' + voice + ' text=' + text.length + ' chars');
    const buf = await edgeTTS.synthesize(text, { voice, rate, pitch });
    console.log('[Edge TTS] OK ' + buf.length + ' bytes');
    return { ok: true, data: buf.toString('base64') };
  } catch (e) {
    console.error('[Edge TTS] FAIL:', e.message);
    return { ok: false, error: e.message || 'Edge TTS error' };
  }
});

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

// Project ID tự động detect sau login
let vertexProjectId = null; // sẽ được detect tự động sau OAuth login

ipcMain.handle('google-get-project', async () => {
  return vertexProjectId;
});

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

            // Tự động: detect project → enable Vertex AI API
            try {
              // Bước 1: Lấy Project ID
              const projRes = await fetch(
                'https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE',
                { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
              );
              const projData = await projRes.json();
              const projects = projData.projects || [];
              const best = projects.find(p => p.projectId.startsWith('gen-lang-client')) || projects[0];
              if (best) {
                vertexProjectId = best.projectId;
                console.log('[Auto] Project detected:', vertexProjectId);
              }

              // Bước 2: Enable Vertex AI API (aiplatform.googleapis.com)
              if (vertexProjectId) {
                console.log('[Auto] Enabling Vertex AI API...');
                const enableRes = await fetch(
                  `https://serviceusage.googleapis.com/v1/projects/${vertexProjectId}/services/aiplatform.googleapis.com:enable`,
                  {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${tokenData.access_token}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({})
                  }
                );
                const enableData = await enableRes.json();
                if (enableData.error) {
                  console.log('[Auto] Enable API warning:', enableData.error.message);
                } else {
                  console.log('[Auto] Vertex AI API enabled/already enabled');

                  // Bước 3: Chờ API ready (poll tối đa 60s)
                  let ready = false;
                  for (let attempt = 0; attempt < 12; attempt++) {
                    await new Promise(r => setTimeout(r, 5000));
                    const checkRes = await fetch(
                      `https://serviceusage.googleapis.com/v1/projects/${vertexProjectId}/services/aiplatform.googleapis.com`,
                      { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
                    );
                    const checkData = await checkRes.json();
                    if (checkData.state === 'ENABLED') {
                      ready = true;
                      console.log('[Auto] Vertex AI API ready!');
                      break;
                    }
                    console.log(`[Auto] Waiting for API... attempt ${attempt + 1}/12`);
                  }
                  if (!ready) console.log('[Auto] API may need more time to activate');
                }
              }
            } catch(e) {
              console.log('[Auto] Setup warning:', e.message);
            }

            server.close();
            resolve({ success: true, projectId: vertexProjectId });
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

// ══════════════════════════════════════════════════
//  GEMINI WEB SIMULATION — tự động hóa gemini.google.com
//  Dùng quota MIỄN PHÍ của tài khoản Google cá nhân, KHÔNG
//  dùng Vertex AI / không tốn credit $300.
//  ⚠️ Thử nghiệm: selector có thể cần chỉnh lại khi Google đổi giao diện.
// ══════════════════════════════════════════════════
let geminiWebWin = null;

function getGeminiWebWindow() {
  if (geminiWebWin && !geminiWebWin.isDestroyed()) return geminiWebWin;
  geminiWebWin = new BrowserWindow({
    width: 1100, height: 850,
    title: 'Gemini Web (Chế độ Giả lập)',
    webPreferences: {
      partition: 'persist:gemini-automation', // giữ đăng nhập lâu dài, tách biệt session app chính
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  geminiWebWin.on('closed', () => { geminiWebWin = null; });
  return geminiWebWin;
}

// Điều khiển gán file vào input[type=file] qua Chrome DevTools Protocol
// (JS thường không thể gán file vào input vì lý do bảo mật của trình duyệt)
async function attachFileViaCDP(win, filePath) {
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  // Tìm input[type=file] trong DOM qua Runtime + DOM domain
  await wc.debugger.sendCommand('DOM.enable');
  const doc = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  const nodeIdResult = await wc.debugger.sendCommand('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeIdResult.nodeId) throw new Error('Không tìm thấy input[type=file] trên trang Gemini — giao diện có thể đã đổi.');
  await wc.debugger.sendCommand('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: nodeIdResult.nodeId,
  });
}

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

ipcMain.handle('gemini-web-generate-image', async (event, { prompt, refImageBase64 }) => {
  const win = getGeminiWebWindow();
  const wc = win.webContents;
  let tmpImgPath = null;

  try {
    win.show();

    // Mở cuộc trò chuyện mới bằng cách nạp lại trang gốc
    await wc.loadURL('https://gemini.google.com/app');
    await sleepMs(3000); // chờ trang tải xong hoàn toàn

    // ── BƯỚC 1: chọn model "3.5 Flash" ──
    // Thử tìm nút chọn model (thường hiển thị tên model hiện tại) rồi bấm vào lựa chọn "3.5 Flash"
    const modelSelectResult = await wc.executeJavaScript(`
      (function(){
        try{
          const btns=[...document.querySelectorAll('button, [role="button"]')];
          const modelBtn=btns.find(b=>/flash|pro|model/i.test(b.textContent||'') && b.offsetParent!==null);
          if(modelBtn){ modelBtn.click(); return {clicked:true}; }
          return {clicked:false};
        }catch(e){return {error:e.message};}
      })();
    `);
    if (modelSelectResult && modelSelectResult.clicked) {
      await sleepMs(800);
      await wc.executeJavaScript(`
        (function(){
          const opts=[...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')];
          const target=opts.find(o=>/3\\.5\\s*flash/i.test(o.textContent||''));
          if(target){ target.click(); return true; }
          return false;
        })();
      `);
      await sleepMs(500);
    }
    // Nếu không tìm được nút chọn model, bỏ qua bước này — dùng model mặc định hiện tại của trang

    // ── BƯỚC 2: đính kèm ảnh tham chiếu (nếu có) ──
    if (refImageBase64) {
      tmpImgPath = path.join(os.tmpdir(), `gemini_ref_${Date.now()}.png`);
      fs.writeFileSync(tmpImgPath, Buffer.from(refImageBase64, 'base64'));
      // Cần bấm nút "đính kèm/upload" trước để input[type=file] xuất hiện trong DOM (nếu bị ẩn/lazy-render)
      await wc.executeJavaScript(`
        (function(){
          const btns=[...document.querySelectorAll('button, [role="button"]')];
          const attachBtn=btns.find(b=>/attach|upload|add file|hình ảnh|tệp/i.test(b.getAttribute('aria-label')||''));
          if(attachBtn){ attachBtn.click(); return true; }
          return false;
        })();
      `);
      await sleepMs(500);
      await attachFileViaCDP(win, tmpImgPath);
      await sleepMs(1500); // chờ ảnh upload xong lên giao diện
    }

    // ── BƯỚC 3: gõ prompt vào ô chat ──
    const typeResult = await wc.executeJavaScript(`
      (function(){
        const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if(!input) return {ok:false, reason:'khong tim thay o nhap prompt'};
        input.focus();
        if(input.isContentEditable){
          input.innerText = ${JSON.stringify(prompt)};
        } else {
          input.value = ${JSON.stringify(prompt)};
        }
        input.dispatchEvent(new InputEvent('input', {bubbles:true}));
        return {ok:true};
      })();
    `);
    if (!typeResult || !typeResult.ok) {
      throw new Error('Không tìm thấy ô nhập prompt trên trang Gemini — giao diện có thể đã đổi. Chi tiết: ' + (typeResult && typeResult.reason));
    }
    await sleepMs(500);

    // ── BƯỚC 4: bấm Gửi ──
    const sendResult = await wc.executeJavaScript(`
      (function(){
        const btns=[...document.querySelectorAll('button, [role="button"]')];
        const sendBtn=btns.find(b=>/send|gửi/i.test(b.getAttribute('aria-label')||'') && !b.disabled);
        if(sendBtn){ sendBtn.click(); return true; }
        return false;
      })();
    `);
    if (!sendResult) throw new Error('Không tìm thấy nút Gửi trên trang Gemini — giao diện có thể đã đổi.');

    // ── BƯỚC 5: đợi ảnh xuất hiện trong câu trả lời (tối đa 60s) ──
    let imageDataUrl = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleepMs(2000);
      imageDataUrl = await wc.executeJavaScript(`
        (async function(){
          const imgs=[...document.querySelectorAll('img')];
          const genImg=imgs.reverse().find(im=>im.naturalWidth>200 && im.naturalHeight>200);
          if(!genImg) return null;
          try{
            const res=await fetch(genImg.src, {credentials:'include'});
            const blob=await res.blob();
            return await new Promise((resolve,reject)=>{
              const fr=new FileReader();
              fr.onload=()=>resolve(fr.result);
              fr.onerror=reject;
              fr.readAsDataURL(blob);
            });
          }catch(e){ return null; }
        })();
      `);
      if (imageDataUrl) break;
    }

    if (!imageDataUrl) {
      throw new Error('Hết thời gian chờ (60s) mà không thấy ảnh được tạo ra. Có thể Gemini web từ chối yêu cầu, hoặc giao diện đã đổi.');
    }

    return { success: true, imageDataUrl };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (tmpImgPath) { try { fs.unlinkSync(tmpImgPath); } catch (e) {} }
  }
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
      backgroundThrottling: false,
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
ipcMain.on('toggle-devtools', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
  else win.webContents.openDevTools();
});

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
    try { fs.rmdirSync(framesDir, { recursive: true }); } catch(e) {}
  }

  if (saveResult.canceled || !saveResult.filePath) {
    cleanup(); return { success: false, error: 'Đã hủy.' };
  }

  const outPath = saveResult.filePath;

  // ── CONCAT DEMUXER: dùng 1 file danh sách ảnh+thời lượng thay vì N input riêng ──
  // Cách cũ (N input "-loop -t -i" + filter concat) không mở rộng tốt khi có nhiều ảnh
  // (video dài, nhiều cảnh) → dễ lỗi/treo khi render. Concat demuxer là cách FFmpeg
  // khuyến nghị chính thức cho slideshow nhiều ảnh, chỉ cần 1 input duy nhất.
  const listPath = path.join(framesDir, `concat_${sessionId}.txt`);
  const escapeForConcat = p => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  let listContent = '';
  preparedImages.forEach(img => {
    listContent += `file '${escapeForConcat(img.filePath)}'\nduration ${img.dur}\n`;
  });
  // Quirk của concat demuxer: duration của file CUỐI hay bị bỏ qua → lặp lại file cuối
  // thêm 1 lần (không kèm duration) để FFmpeg giữ đúng thời lượng khung hình cuối
  if (preparedImages.length) {
    listContent += `file '${escapeForConcat(preparedImages[preparedImages.length - 1].filePath)}'\n`;
  }
  fs.writeFileSync(listPath, listContent, 'utf8');
  tmpFiles.push(listPath);

  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;

  const args = [
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-i', audioPath,
    '-vf', vf,
    '-map', '0:v',
    '-map', '1:a',
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
  ];

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
