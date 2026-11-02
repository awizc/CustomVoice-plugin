// Read capabilities in an isolated, hidden Electron instance. No screen capture,
// server connection, or media encoding is started.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setPath('userData', path.join(require('os').tmpdir(), 'customvoice-encoder-info'));
const timer = setTimeout(() => app.exit(2), 10000);
app.whenReady().then(async () => {
  let win;
  try {
    const gpu = await app.getGPUInfo('complete');
    console.log(JSON.stringify({features:app.getGPUFeatureStatus(), encoders:gpu.videoEncodeAcceleratorSupportedProfiles}));
    win = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    await win.loadFile(path.join(__dirname,'index.html'));
    console.log(JSON.stringify(await win.webContents.executeJavaScript(`(async()=>{
      const codecs=RTCRtpSender.getCapabilities('video').codecs;
      const results=[];
      for(const c of codecs.filter(c=>/h264|vp8|av1|vp9/i.test(c.mimeType))){
        const fmtp=c.sdpFmtpLine||'';
        const contentType=c.mimeType+(fmtp?';'+fmtp:'');
        try{results.push({contentType,...await navigator.mediaCapabilities.encodingInfo({type:'webrtc',video:{contentType,width:1920,height:1080,bitrate:24000000,framerate:144}})});}catch(e){results.push({contentType,error:e.message});}
      }
      return {codecs,results};
    })()`)));
  } catch(e) {console.error(e.message);process.exitCode=1;}
  finally {clearTimeout(timer);win?.destroy();app.exit(process.exitCode||0);}
});
