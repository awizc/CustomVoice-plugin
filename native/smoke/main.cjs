// An isolated, hidden Electron window tests the GPU bridge and a local WebRTC
// connection. It does not operate Discord, save frames, or contact a server.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'customvoice-native-smoke'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('../host-main.cjs').install({ allowTest: true });
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'warning' || event.level === 'error') console.error(event.message); });
  const watchdog = setTimeout(() => app.exit(2), 18000);
  let failed = false;
  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    const bundle = require('node:fs').readFileSync(path.resolve(__dirname, '../../CustomVoice.plugin.js'), 'utf8');
    const captureSource = bundle.slice(bundle.indexOf('// <CustomVoiceNativeRenderer>'), bundle.indexOf('// </CustomVoiceNativeRenderer>'));
    const codecSource = bundle.slice(bundle.indexOf('async function selectScreenCodec('), bundle.indexOf('// node_modules/zod/'));
    if (!captureSource) throw Error('Bundled native renderer adapter is missing');
    const result = await window.webContents.executeJavaScript(`(async () => {
      window.require = name => { throw Error('Renderer cannot load Node module: ' + name); };
      ${captureSource}
      ${codecSource}
      const customVoiceLog = (...args) => console.log(...args);
      const capture = createNativeCaptureModule();
      const control = await capture.start('screen:0:0', 144, '1080p', new AbortController().signal);
      const a = new RTCPeerConnection({iceServers: []}), b = new RTCPeerConnection({iceServers: []});
      try {
        const pendingA = [], pendingB = [];
        a.onicecandidate = e => { if(e.candidate) b.remoteDescription ? b.addIceCandidate(e.candidate).catch(()=>{}) : pendingB.push(e.candidate); };
        b.onicecandidate = e => { if(e.candidate) a.remoteDescription ? a.addIceCandidate(e.candidate).catch(()=>{}) : pendingA.push(e.candidate); };
        const t = a.addTransceiver(control.track, {direction:'sendonly', sendEncodings:[{maxFramerate:144,maxBitrate:24000000,scaleResolutionDownBy:1}]});
        const codec = await selectScreenCodec(1920,1080,144,24000000,control.track);
        applyScreenCodecPreferences(t,control.track,codec);
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        for(const c of pendingB) await b.addIceCandidate(c);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        for(const c of pendingA) await a.addIceCandidate(c);
        const parameters=t.sender.getParameters(); parameters.degradationPreference='maintain-resolution'; await t.sender.setParameters(parameters);
        const sample = async () => {
          const stats = await t.sender.getStats(); let s;
          stats.forEach(v => {if(v.type==='outbound-rtp' && v.kind==='video')s=v;});
          const source=stats.get(s?.mediaSourceId);
          return {time:s?.timestamp,frames:s?.framesEncoded,sourceFrames:source?.frames,encoder:s?.encoderImplementation,powerEfficient:s?.powerEfficientEncoder,fmtp:stats.get(s?.codecId)?.sdpFmtpLine,codec:stats.get(s?.codecId)?.mimeType,encodeTime:s?.totalEncodeTime,reason:s?.qualityLimitationReason};
        };
        await new Promise(r=>setTimeout(r,1000)); const first=await sample();
        await new Promise(r=>setTimeout(r,1500)); const second=await sample();
        if(!control.diagnostics.nativePacing) throw Error('Native pacing channel is missing');
        CustomVoiceNative.pace(control.metadata.session,30);
        await new Promise(r=>setTimeout(r,250)); const beforePace=await sample();
        await new Promise(r=>setTimeout(r,1100)); const afterPace=await sample();
        const pacedFps=(afterPace.sourceFrames-beforePace.sourceFrames)*1000/(afterPace.time-beforePace.time);
        CustomVoiceNative.pace(control.metadata.session,144);
        await new Promise(r=>setTimeout(r,250)); const beforeRecovery=await sample();
        await new Promise(r=>setTimeout(r,1100)); const afterRecovery=await sample();
        const recoveredFps=(afterRecovery.sourceFrames-beforeRecovery.sourceFrames)*1000/(afterRecovery.time-beforeRecovery.time);
        if(!(pacedFps>10&&pacedFps<50&&recoveredFps>pacedFps*1.6)) throw Error('Native pacing/recovery failed: '+JSON.stringify({pacedFps,recoveredFps}));
        const diagnostics=control.diagnostics;
        if(!Number.isFinite(diagnostics.outputWorkMs)||!Number.isFinite(diagnostics.outputOverrunFps)||diagnostics.handoffWindowMs!==10000)
          throw Error('Native work/recent handoff diagnostics are missing');
        const changed=await control.configure('720p',120);
        if(changed.fps!==120||changed.height>720)throw Error('Configuration did not reach native helper');
        return {isolated:true,nodeInPage:typeof process,native:control.metadata,diagnostics,pacedFps,recoveredFps,captureFps:(second.sourceFrames-first.sourceFrames)*1000/(second.time-first.time),sendFps:(second.frames-first.frames)*1000/(second.time-first.time),encodeMs:(second.encodeTime-first.encodeTime)*1000/(second.frames-first.frames),encoder:second.encoder,powerEfficient:second.powerEfficient,fmtp:second.fmtp,codec:second.codec};
      } finally {a.close();b.close();control.stop();}
    })()`);
    console.log(JSON.stringify(result));
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) { console.error(error.stack); failed = true; }
  finally { clearTimeout(watchdog); window.destroy(); app.exit(failed ? 1 : 0); }
});
