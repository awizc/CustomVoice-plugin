// Hidden fixture: renders our actual components and exercises synthetic PCM over
// local WebRTC. It does not operate Discord or capture microphone/system audio.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist/ui-check');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'fixture.html'),'<!doctype html><meta charset="utf-8"><style>:root{--font-primary:"Segoe UI",sans-serif;--background-primary:#313338;--background-secondary:#2b2d31;--background-floating:#111214;--text-normal:#dbdee1;--channels-default:#949ba4;--brand-500:#5865f2}body{margin:0;padding:24px;background:#1e1f22}#fixture{width:300px;background:var(--background-secondary);padding:12px 0;border-radius:8px}</style><div id="fixture"></div>');
app.setPath('userData',path.join(out,'electron-profile'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const bundle=fs.readFileSync(path.join(root,'CustomVoice.plugin.js'),'utf8');
const cut=(start,end)=>bundle.slice(bundle.indexOf(start),bundle.indexOf(end,bundle.indexOf(start)));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:700,height:560,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
  const watchdog=setTimeout(()=>app.exit(2),30000);
  try {
    await win.loadURL('file://'+path.join(out,'fixture.html').replaceAll('\\','/'));
    const react=path.join(out,'node_modules/react'),reactDOM=path.join(out,'node_modules/react-dom/client');
    await win.webContents.executeJavaScript(`
      var React=require(${JSON.stringify(react)}),ReactDOM=require(${JSON.stringify(reactDOM)});
      var BdApi={React},import_react6={...React,default:React},keyboardContextMenu=()=>{},run=(manager,promise)=>promise.catch(manager.error),captureContextMenuEvent=event=>event;
      var customVoiceLog=()=>{},Compatibility=class{user(){}};
      var Track={Kind:{Audio:'audio'},Source:{ScreenShare:'screen',ScreenShareAudio:'screen-audio',Microphone:'mic'}};
      ${cut('function createVoiceSnapshot(', 'var Store = class')}
      ${fs.readFileSync(path.join(root,'native/voice-extras.js'),'utf8')}
      ${fs.readFileSync(path.join(root,'native/broadcast-viewers.js'),'utf8')}
      ${fs.readFileSync(path.join(root,'native/discord-theme.js'),'utf8')}
      ${cut('var css = `','// src/components/popout-geometry.ts')}
      var style=document.createElement('style');style.textContent=css+customVoiceFeatureCss+customVoiceDiscordCss;document.head.append(style);
      var events=new Set(),state={connection:'Connected',user:{id:'self'},profiles:{one:{username:'한글 닉네임',discordId:'1'},two:{username:'닉네임이 아주 길어도 줄맞춤 유지 🎮',discordId:'2'},three:{username:'Latin ＡＢＣ・가나다',discordId:'3'}},speakers:[],watching:[],sharing:true,participants:[{userId:'one',mediaIdentity:'p1',screenSharing:true,channelId:'call'},{userId:'two',mediaIdentity:'p2',muted:true,deafened:true,channelId:'call'},{userId:'three',mediaIdentity:'p3',channelId:'call'}]};
      var store={get:()=>state,subscribe:fn=>{events.add(fn);return()=>events.delete(fn);}},watched=[];
      var manager={store,client:{mediaRoom:{localParticipant:{identity:'self'},remoteParticipants:new Map()}},previews:{subscribe:(id,fn)=>{fn({error:'방송 미리보기'});return()=>{};}},viewers:{getRevision:()=>0,getBroadcast:()=>({ids:viewerIds,availability:'available'}),subscribe:()=>()=>{}},watchParticipant:async p=>{watched.push(p.userId);},error:error=>{throw error;}};
      var viewerIds=['p1','p2'];
      var useVoice=s=>React.useSyncExternalStore(s.subscribe,s.get),Icon=({size=16})=>React.createElement('svg',{className:'cv-icon',width:size,height:size,viewBox:'0 0 16 16'},React.createElement('circle',{cx:8,cy:8,r:5,fill:'currentColor'}));
      ${cut('function identity(', 'function Channels(')}
      ${cut('function VoicePanel(', 'function MainContent(')}
      var DisconnectButton=()=>null,Controls=()=>null,ShareQuality=()=>null;
      Object.assign(state,{quality:{},sessionChannel:{name:'게임 이야기'},sessionGuild:{name:'커스텀 음성 서버'}});
      var fixtureRoot=ReactDOM.createRoot(document.getElementById('fixture'));
      fixtureRoot.render(React.createElement('section',{className:'cv cv-channel-list'},React.createElement('div',{className:'cv-category'},'음성 채널'),React.createElement('button',{className:'cv-channel'},'게임 이야기'),React.createElement(Participants,{participants:state.participants,manager,compat:new Compatibility()}),React.createElement(VoicePanel,{manager,compat:new Compatibility()}),React.createElement('div',{className:'cv-screen cv-controls-visible'},React.createElement('header',{className:'cv-screen-heading'},React.createElement(BroadcastViewerList,{manager})))));
    `);
    const ui=await win.webContents.executeJavaScript(`(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),check=(condition,message)=>{if(!condition)throw Error(message);};await wait(150);
      const rows=[...document.querySelectorAll('.cv-participant')],names=rows.map(row=>row.querySelector('.cv-user-name'));
      check(rows.length===3,'participant fixture must render three rows');
      check(!document.querySelector('.cv-voice-panel .cv-viewers'),'voice connection panel must not contain the viewer list');
      check(!!document.querySelector('.cv-screen .cv-viewers'),'viewer list remains on the broadcast screen');
      const boxes=names.map(name=>name.getBoundingClientRect());
      check(boxes.every(rect=>Math.abs(rect.left-boxes[0].left)<1),'nickname starts must align');
      check(rows.every(row=>Math.abs(row.getBoundingClientRect().height-32)<1),'badge combinations must not change row height');
      check(new Set(names.map(name=>getComputedStyle(name).fontFamily)).size===1,'nickname font must be consistent: '+JSON.stringify(names.map(name=>({text:name.textContent,font:getComputedStyle(name).fontFamily}))));
      rows[0].dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await wait(300);
      check(!!document.querySelector('.cv-broadcast-hover .cv-watch-button'),'hover has a watch action');
      rows[0].querySelector('.cv-participant-target').click();await wait(50);
      check(!!document.querySelector('.cv-preview-heading button'),'pinned preview exposes its close button');
      rows[0].dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait(300);
      check(!!document.querySelector('.cv-broadcast-hover'),'click pins preview after pointer leaves');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(50);
      check(!document.querySelector('.cv-broadcast-hover'),'Escape dismisses pinned preview');
      rows[0].querySelector('.cv-participant-target').click();await wait(50);
      document.querySelector('.cv-broadcast-hover .cv-watch-button').click();await wait(60);
      check(watched[0]==='one'&&!document.querySelector('.cv-broadcast-hover'),'watch action selects broadcaster and closes preview');
      rows[0].querySelector('.cv-participant-target').click();await wait(50);
      document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await wait(50);
      check(!document.querySelector('.cv-broadcast-hover'),'outside click dismisses preview');
      rows[0].querySelector('.cv-participant-target').click();await wait(80);document.querySelector('.cv-viewers').open=true;await wait(80);
      check(!!document.querySelector('.cv-preview-heading button'),'final preview stays pinned');
      return {nicknameLeft:boxes[0].left,rowHeight:rows[0].getBoundingClientRect().height,previewPinned:true,viewerNames:document.querySelectorAll('.cv-viewers-list li').length};
    })()`);
    fs.writeFileSync(path.join(out,'preview.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const audio=await win.webContents.executeJavaScript(`(async()=>{
      ${fs.readFileSync(path.join(root,'native/process-audio.js'),'utf8')}
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let interval,phase=0,consumed=0,stopped=0;
      globalThis.CustomVoiceNative={version:'fixture',audioStart:async()=>({session:'fixture-audio',sampleRate:48000,channels:2}),audioActivate:async()=>{interval=setInterval(()=>{
        const pcm=new ArrayBuffer(960*4),view=new DataView(pcm);for(let i=0;i<960;i++){const sample=Math.round(Math.sin(phase++*2*Math.PI*440/48000)*8192);view.setInt16(i*4,sample,true);view.setInt16(i*4+2,sample,true);}
        window.postMessage({type:'customvoice-process-audio',session:'fixture-audio',sequence:phase,pcm},'*',[pcm]);
      },20);},audioConsumed:()=>consumed++,audioStop:async()=>{clearInterval(interval);stopped++;}};
      const module=createProcessAudioModule(),track=await module.start('window:1:0',new AbortController().signal);
      const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]}),context=new AudioContext({sampleRate:48000}),analyser=context.createAnalyser();analyser.fftSize=2048;
      const quiet=context.createGain();quiet.gain.value=0;analyser.connect(quiet);quiet.connect(context.destination);await context.resume();
      const gain=context.createGain();gain.gain.value=2;gain.connect(analyser);
      const pendingA=[],pendingB=[];let remote,receiverSource,receiverElement;
      a.onicecandidate=e=>{if(e.candidate)b.remoteDescription?b.addIceCandidate(e.candidate).catch(()=>{}):pendingB.push(e.candidate);};
      b.onicecandidate=e=>{if(e.candidate)a.remoteDescription?a.addIceCandidate(e.candidate).catch(()=>{}):pendingA.push(e.candidate);};
      b.ontrack=e=>{remote=e.track;const stream=new MediaStream([e.track]);receiverElement=document.createElement('audio');receiverElement.srcObject=stream;receiverElement.muted=true;document.body.append(receiverElement);void receiverElement.play();receiverSource=context.createMediaStreamSource(stream);receiverSource.connect(gain);};
      try{
        const sender=a.addTrack(track);await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);for(const c of pendingB)await b.addIceCandidate(c);
        await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);for(const c of pendingA)await a.addIceCandidate(c);
        let peak=0;const values=new Float32Array(analyser.fftSize);
        for(let i=0;i<40;i++){await wait(100);analyser.getFloatTimeDomainData(values);peak=Math.max(...values.map(Math.abs));if(peak>0.1)break;}
        const report=await sender.getStats();let packetsSent=0;report.forEach(v=>{if(v.type==='outbound-rtp')packetsSent+=v.packetsSent;});
        if(!remote||peak<0.1||packetsSent<1||consumed<1)throw Error('Synthetic audio did not reach local WebRTC receiver: '+JSON.stringify({remote:!!remote,peak,packetsSent,consumed,phase,connection:a.connectionState,receiver:b.connectionState,context:context.state,enabled:track.enabled,muted:track.muted,stats:[...report.values()].filter(v=>v.type==='media-source'||v.type==='outbound-rtp')}));
        track.stop();await wait(20);if(track.readyState!=='ended'||stopped!==1)throw Error('Audio cleanup failed');
        return {peak,packetsSent,acknowledgedPackets:consumed,stopped};
      }finally{track.stop();module.stopAll();receiverSource?.disconnect();if(receiverElement){receiverElement.pause();receiverElement.srcObject=null;receiverElement.remove();}a.close();b.close();await context.close();}
    })()`);
    console.log(JSON.stringify({ui,audio,screenshot:path.join(out,'preview.png')}));
    clearTimeout(watchdog);win.destroy();app.exit(0);
  }catch(error){console.error(error);fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());clearTimeout(watchdog);app.exit(1);}
});
