const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  renderVideoFFmpeg: (data) => ipcRenderer.invoke('render-video-ffmpeg', data),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  // Google OAuth2 for Vertex AI
  googleOAuthLogin: () => ipcRenderer.invoke('google-oauth-login'),
  googleGetToken: () => ipcRenderer.invoke('google-get-token'),
  googleLogout: () => ipcRenderer.invoke('google-logout'),
  googleAuthStatus: () => ipcRenderer.invoke('google-auth-status'),
  edgeTTS: (params) => ipcRenderer.invoke('edge-tts', params),
});
