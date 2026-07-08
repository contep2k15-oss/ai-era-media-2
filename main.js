const { app, BrowserWindow, shell, ipcMain, dialog, clipboard, nativeImage } = require('electron');
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
//
//  THIẾT KẾ: Đăng nhập tách riêng khỏi tạo ảnh —
//  - "Đăng nhập" (gemini-web-login): hiện cửa sổ, chờ bạn đăng nhập tay,
//    xong thì ẨN cửa sổ (không đóng/hủy) để giữ nguyên phiên.
//  - "Tạo ảnh" (gemini-web-generate-image): dùng LẠI đúng cửa sổ đó,
//    không tải lại URL gốc mỗi lần (tránh làm mất trạng thái phiên).
// ══════════════════════════════════════════════════
let geminiWebWin = null;
let geminiWebLoggedIn = false;
let geminiModelSelected = false; // chỉ chọn model 1 lần/phiên, tránh bấm nhầm khi lặp lại

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

function getGeminiWebWindow() {
  if (geminiWebWin && !geminiWebWin.isDestroyed()) return geminiWebWin;
  geminiWebWin = new BrowserWindow({
    width: 1100, height: 850,
    title: 'Gemini Web (Chế độ Giả lập)',
    show: false,
    webPreferences: {
      partition: 'persist:gemini-automation', // giữ đăng nhập lâu dài, tách biệt session app chính
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // QUAN TRỌNG: khi bạn bấm nút X đóng cửa sổ, KHÔNG hủy thật — chỉ ẩn đi,
  // để giữ nguyên phiên đăng nhập/trạng thái trang cho lần tạo ảnh tiếp theo
  geminiWebWin.on('close', (e) => {
    e.preventDefault();
    geminiWebWin.hide();
  });
  return geminiWebWin;
}

async function isGeminiPageReady(wc) {
  return await wc.executeJavaScript(`
    !!(document.querySelector('[contenteditable="true"]') || document.querySelector('textarea'))
  `).catch(() => false);
}

// Đăng nhập: hiện cửa sổ, chờ bạn tự đăng nhập, phát hiện khi trang chat sẵn sàng
ipcMain.handle('gemini-web-login', async () => {
  const win = getGeminiWebWindow();
  const wc = win.webContents;
  win.show();
  win.focus();
  try {
    await wc.loadURL('https://gemini.google.com/app');
  } catch (e) {}

  const deadline = Date.now() + 5 * 60 * 1000; // tối đa 5 phút chờ bạn đăng nhập
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return { success: false, error: 'Cửa sổ đã bị đóng.' };
    await sleepMs(2000);
    if (await isGeminiPageReady(wc)) {
      geminiWebLoggedIn = true;
      geminiModelSelected = false; // đăng nhập lại → thử chọn model lại 1 lần nữa
      win.hide(); // Ẩn đi, giữ nguyên phiên — KHÔNG đóng
      return { success: true };
    }
  }
  return { success: false, error: 'Hết thời gian chờ đăng nhập (5 phút). Hãy thử lại.' };
});

// Kiểm tra trạng thái đăng nhập hiện tại (dùng khi mở lại app, hoặc trước khi tạo ảnh)
ipcMain.handle('gemini-web-check-session', async () => {
  try {
    const win = getGeminiWebWindow();
    const wc = win.webContents;
    if (!geminiWebLoggedIn) {
      // App vừa khởi động lại — thử kiểm tra xem phiên cũ (lưu trên đĩa) còn dùng được không
      try { await wc.loadURL('https://gemini.google.com/app'); } catch (e) {}
      await sleepMs(2500);
      geminiWebLoggedIn = await isGeminiPageReady(wc);
    }
    return { loggedIn: geminiWebLoggedIn };
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }
});

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

ipcMain.handle('gemini-web-generate-image', async (event, { prompt, refImageBase64, videoUrl }) => {
  const win = getGeminiWebWindow();
  const wc = win.webContents;
  let tmpImgPath = null;

  try {
    if (!geminiWebLoggedIn) {
      throw new Error('Chưa đăng nhập Gemini Web. Vào Cài đặt → bấm "Đăng nhập Gemini Web" trước.');
    }

    win.show(); // Hiện cửa sổ trong lúc tạo ảnh để có thể theo dõi/debug

    // Mở cuộc trò chuyện mới bằng TỔ HỢP PHÍM Ctrl+Shift+O — hoàn toàn không dò/click DOM,
    // tránh triệt để rủi ro bấm nhầm nút khác trên trang (nguồn gốc mọi lỗi trước đây).
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'char', keyCode: 'O', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    await sleepMs(1200); // chờ trang chuyển sang cuộc trò chuyện mới

    // ── BƯỚC 1: chọn model "3.5 Flash" — CHỈ làm 1 LẦN DUY NHẤT trong cả phiên làm việc ──
    // (model đã chọn sẽ được Gemini nhớ cho các cuộc trò chuyện mới tiếp theo — không cần chọn lại,
    // vừa nhanh hơn vừa tránh rủi ro bấm nhầm mỗi lần lặp lại bước này)
    if (!geminiModelSelected) {
      const modelSelectResult = await wc.executeJavaScript(`
        (function(){
          try{
            // Dùng đúng aria-label cố định của nút chọn model: "Mở công cụ chọn chế độ, hiện tại là X"
            // — cụm "Mở công cụ chọn chế độ" không đổi dù model hiện tại là gì, và không trùng
            // với bất kỳ phần tử nào khác trên trang (khác hẳn so khớp chữ "Flash"/"Pro" đơn thuần).
            const btns=[...document.querySelectorAll('button, [role="button"]')];
            const modelBtn=btns.find(b=>{
              const label=(b.getAttribute('aria-label')||'');
              return /mở công cụ chọn chế độ|open model selector|model selector/i.test(label) && b.offsetParent!==null;
            });
            if(modelBtn){ modelBtn.click(); return {clicked:true}; }
            return {clicked:false};
          }catch(e){return {error:e.message};}
        })();
      `);
      if (modelSelectResult && modelSelectResult.clicked) {
        await sleepMs(800);
        await wc.executeJavaScript(`
          (function(){
            const opts=[...document.querySelectorAll('[role="menuitem"], [role="option"]')];
            const target=opts.find(o=>/3\\.5\\s*flash/i.test((o.textContent||'').trim()));
            if(target){ target.click(); return true; }
            return false;
          })();
        `);
        await sleepMs(500);
      }
      geminiModelSelected = true; // đánh dấu đã xử lý — không thử lại nữa dù thành công hay không
    }

    // ── BƯỚC 2: đính kèm ảnh tham chiếu (nếu có) ──
    // Cách CHÍNH: bấm nút "+" → "Tải tệp lên" → gán file qua CDP — không đụng tới clipboard
    // của bạn, an toàn tuyệt đối nếu bạn đang copy/paste thứ khác song song.
    // Cách DỰ PHÒNG (nếu cách chính lỡ thất bại): clipboard + Ctrl+V như trước.
    let savedClipboard = null; // để khôi phục lại clipboard gốc của bạn nếu phải dùng cách dự phòng
    if (refImageBase64) {
      // Mở cuộc trò chuyện MỚI trước khi đính kèm ảnh tham chiếu mới — đảm bảo ô soạn tin
      // hoàn toàn sạch, không bị dính ảnh tham chiếu của lượt tạo ảnh trước đó
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'char', keyCode: 'O', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
      await sleepMs(1200);

      tmpImgPath = path.join(os.tmpdir(), `gemini_ref_${Date.now()}.png`);
      fs.writeFileSync(tmpImgPath, Buffer.from(refImageBase64, 'base64'));

      let attachedViaMenu = false;
      try {
        // 1) Bấm nút "+" — dùng đúng aria-label cố định: "Nội dung tải lên và công cụ"
        const plusClicked = await wc.executeJavaScript(`
          (function(){
            const btns=[...document.querySelectorAll('button, [role="button"]')];
            const plusBtn=btns.find(b=>/nội dung tải lên và công cụ|upload content and tools/i.test(b.getAttribute('aria-label')||'') && b.offsetParent!==null);
            if(plusBtn){ plusBtn.click(); return true; }
            return false;
          })();
        `).catch(() => false);

        if (plusClicked) {
          await sleepMs(700);
          // 2) Bấm "Tải tệp lên" — dùng đúng data-test-id cố định của icon bên trong mục đó
          const uploadClicked = await wc.executeJavaScript(`
            (function(){
              const icon = document.querySelector('[data-test-id="local-images-files-uploader-icon"]');
              let target = icon ? (icon.closest('[role="menuitem"]') || icon.closest('button') || icon.closest('li')) : null;
              if(!target){
                const items=[...document.querySelectorAll('[role="menuitem"], li')];
                target = items.find(o=>/tải tệp lên|upload file/i.test((o.textContent||'').trim()));
              }
              if(target){ target.click(); return true; }
              return false;
            })();
          `).catch(() => false);

          if (uploadClicked) {
            await sleepMs(700);
            await attachFileViaCDP(win, tmpImgPath);
            await sleepMs(1500);
            attachedViaMenu = true;
          }
        }
      } catch (e) { attachedViaMenu = false; }

      // ── DỰ PHÒNG: nếu cách chính thất bại, dùng clipboard + Ctrl+V ──
      if (!attachedViaMenu) {
        // 1) Lưu lại clipboard hiện tại của bạn trước khi ghi đè
        try {
          const formats = clipboard.availableFormats();
          savedClipboard = {
            text: formats.includes('text/plain') ? clipboard.readText() : '',
            html: formats.includes('text/html') ? clipboard.readHTML() : '',
            imageDataURL: (() => {
              const img = clipboard.readImage();
              return img && !img.isEmpty() ? img.toDataURL() : null;
            })(),
          };
        } catch (e) { savedClipboard = null; }

        // 2) Ghi ảnh tham chiếu vào clipboard
        const img = nativeImage.createFromBuffer(Buffer.from(refImageBase64, 'base64'));
        clipboard.writeImage(img);

        // 3) Focus vào ô chat rồi giả lập Ctrl+V
        await wc.executeJavaScript(`
          (function(){
            const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            if(input) input.focus();
            return !!input;
          })();
        `).catch(() => false);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'char', keyCode: 'V', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
        await sleepMs(1500); // chờ ảnh dán xong hiện lên giao diện

        // 4) Khôi phục lại clipboard gốc của bạn ngay sau khi dán xong
        try {
          if (savedClipboard) {
            if (savedClipboard.imageDataURL) {
              clipboard.writeImage(nativeImage.createFromDataURL(savedClipboard.imageDataURL));
            } else if (savedClipboard.html) {
              clipboard.writeHTML(savedClipboard.html);
            } else if (savedClipboard.text) {
              clipboard.writeText(savedClipboard.text);
            } else {
              clipboard.clear();
            }
          } else {
            clipboard.clear();
          }
        } catch (e) {}
      }
    }

    // Ghi lại danh sách TOÀN BỘ ảnh đã có sẵn trên trang trước khi gửi (bao gồm ảnh tham
    // chiếu vừa dán) — dùng để lọc bỏ, tránh lấy nhầm ảnh tham chiếu làm "ảnh vừa tạo ra"
    const existingImgSrcs = await wc.executeJavaScript(`
      [...document.querySelectorAll('img')].map(im => im.src)
    `).catch(() => []);

    // ── BƯỚC 3: gõ prompt vào ô chat (kèm link YouTube nếu có, để Gemini xem video làm ngữ cảnh) ──
    const fullText = videoUrl ? (videoUrl + '\n\n' + prompt) : prompt;
    const typeResult = await wc.executeJavaScript(`
      (function(){
        const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if(!input) return {ok:false, reason:'khong tim thay o nhap prompt'};
        input.focus();
        if(input.isContentEditable){
          input.innerText = ${JSON.stringify(fullText)};
        } else {
          input.value = ${JSON.stringify(fullText)};
        }
        input.dispatchEvent(new InputEvent('input', {bubbles:true}));
        return {ok:true};
      })();
    `);
    if (!typeResult || !typeResult.ok) {
      throw new Error('Không tìm thấy ô nhập prompt trên trang Gemini — giao diện có thể đã đổi. Chi tiết: ' + (typeResult && typeResult.reason));
    }
    // Nếu có link video, chờ thêm để Gemini kịp nhận diện link và hiện preview (nếu có)
    await sleepMs(videoUrl ? 2500 : 500);

    // ── BƯỚC 4: GỬI — giả lập tổ hợp phím Ctrl+Enter thay vì dò tìm nút bấm ──
    // (Gemini web dùng Ctrl+Enter để gửi — tránh hoàn toàn rủi ro bấm nhầm nút khác
    // trên trang, vốn rất mong manh khi giao diện có nhiều nút)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'char', keyCode: 'Enter', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    await sleepMs(1000);

    // Kiểm tra xem tin nhắn đã thực sự được gửi chưa (ô nhập phải trống lại sau khi gửi)
    const sentCheck = await wc.executeJavaScript(`
      (function(){
        const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if(!input) return {ok:false, reason:'mat o nhap sau khi nhan Enter'};
        const stillHasText = (input.isContentEditable ? input.innerText : input.value).trim().length > 0;
        return {ok:!stillHasText, stillHasText};
      })();
    `).catch(e => ({ok:false, reason:'loi kiem tra: '+e.message}));

    // Nếu Ctrl+Enter không gửi được (ô nhập vẫn còn text), thử phương án dự phòng:
    // dùng đúng icon mũi tên lên bên trong nút Gửi (data-mat-icon-name="arrow_upward")
    // — thuộc tính kỹ thuật đặc trưng, không thể trùng với phần tử nào khác trên trang.
    if (!sentCheck || !sentCheck.ok) {
      const fallbackSend = await wc.executeJavaScript(`
        (function(){
          const icon = document.querySelector('[data-mat-icon-name="arrow_upward"]');
          if(!icon) return {ok:false, reason:'khong tim thay icon gui (arrow_upward)'};
          const btn = icon.closest('button');
          if(!btn) return {ok:false, reason:'khong tim thay button cha cua icon gui'};
          if(btn.disabled) return {ok:false, reason:'nut Gui dang bi disabled'};
          btn.click();
          return {ok:true};
        })();
      `);
      if (!fallbackSend || !fallbackSend.ok) {
        throw new Error('Nhấn Ctrl+Enter không gửi được, và không tìm thấy nút Gửi dự phòng. Chi tiết: ' + JSON.stringify(fallbackSend));
      }
    }

    // ── BƯỚC 5: đọc trực tiếp dữ liệu ảnh ĐÃ HIỂN THỊ bằng canvas — không qua mạng,
    // không phụ thuộc địa chỉ blob: (dễ hết hạn) hay session.downloadURL (không hiểu blob:) ──
    let imageDataUrl = null;
    let lastDiag = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleepMs(1500);
      const result = await wc.executeJavaScript(`
        (function(){
          const existingSrcs = new Set(${JSON.stringify(existingImgSrcs)});
          const imgs=[...document.querySelectorAll('img')].reverse();
          const genImg=imgs.find(im=>im.naturalWidth>200 && im.naturalHeight>200 && im.complete && !existingSrcs.has(im.src));
          if(!genImg) return {ok:false, reason:'chua thay anh MOI nao du lon/tai xong (co the anh tham chieu cu con dinh)', totalImgs:imgs.length};
          try{
            const canvas=document.createElement('canvas');
            canvas.width=genImg.naturalWidth;
            canvas.height=genImg.naturalHeight;
            const ctx=canvas.getContext('2d');
            ctx.drawImage(genImg,0,0);
            const dataUrl=canvas.toDataURL('image/png');
            return {ok:true, dataUrl};
          }catch(e){
            return {ok:false, reason:'canvas bi chan (tainted): '+e.message};
          }
        })();
      `).catch(e => ({ ok: false, reason: 'loi thuc thi JS: ' + e.message }));
      lastDiag = result;
      if (result && result.ok && result.dataUrl) { imageDataUrl = result.dataUrl; break; }
    }

    if (!imageDataUrl) {
      throw new Error('Hết thời gian chờ (90s) mà không lấy được ảnh. Chẩn đoán: ' + JSON.stringify(lastDiag));
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
