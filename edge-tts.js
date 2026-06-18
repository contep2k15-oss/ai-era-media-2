// Edge TTS module — gọi Microsoft Edge Text-to-Speech (miễn phí)
// Dùng WebSocket, không cần thư viện ngoài
const crypto = require('crypto');
const https = require('https');
let WebSocket;
try {
  WebSocket = require('ws'); // ưu tiên package ws
} catch (e) {
  WebSocket = global.WebSocket; // fallback Node 21+ global
}

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TRUSTED_TOKEN;
const VOICES_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=' + TRUSTED_TOKEN;

// Tạo Sec-MS-GEC token theo thuật toán của Edge
function generateSecMsGec() {
  let ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600) * 10000000n;
  ticks = ticks - (ticks % 3000000000n);
  const strToHash = ticks.toString() + TRUSTED_TOKEN;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function dateToString() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function ssmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sinh audio MP3 từ text. Trả về Buffer.
// options: { voice, rate, pitch }
function synthesize(text, options = {}) {
  return new Promise((resolve, reject) => {
    const voice = options.voice || 'en-US-AndrewNeural';
    const rate = options.rate || '+0%';
    const pitch = options.pitch || '+0Hz';

    const secMsGec = generateSecMsGec();
    const url = WSS_URL + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-130.0.2849.68';

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
    } catch (e) {
      return reject(new Error('Không tạo được WebSocket: ' + e.message));
    }

    const audioChunks = [];
    let timeout = setTimeout(() => {
      try { ws.close(); } catch(e){}
      reject(new Error('Edge TTS timeout (30s)'));
    }, 30000);

    ws.on('open', () => {
      // 1. Gửi config
      const configMsg =
        `X-Timestamp:${dateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      ws.send(configMsg);

      // 2. Gửi SSML
      const requestId = crypto.randomUUID().replace(/-/g, '');
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody rate='${rate}' pitch='${pitch}'>` +
        ssmlEscape(text) +
        `</prosody></voice></speak>`;
      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateToString()}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text message — check turn.end
        const str = data.toString('utf-8');
        if (str.includes('Path:turn.end')) {
          clearTimeout(timeout);
          try { ws.close(); } catch(e){}
          if (audioChunks.length === 0) {
            return reject(new Error('Edge TTS không trả về audio'));
          }
          resolve(Buffer.concat(audioChunks));
        }
      } else {
        // Binary message — audio data
        const buf = Buffer.from(data);
        const headerLen = (buf[0] << 8) | buf[1];
        const audioStart = 2 + headerLen;
        const header = buf.slice(2, audioStart).toString('utf-8');
        if (header.includes('Path:audio')) {
          audioChunks.push(buf.slice(audioStart));
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error('Edge TTS WebSocket lỗi: ' + (err.message || 'unknown')));
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

module.exports = { synthesize };
