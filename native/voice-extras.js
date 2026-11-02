// Bundled UI services. Notification tones are generated locally; no sound assets.
var VoiceSounds = class {
  constructor(manager) {
    this.manager=manager;this.previous=manager.store.get();this.channel=undefined;this.closed=false;this.last=new Map();
    this.unlock=()=>{if(this.closed)return;try{this.context??=new AudioContext({latencyHint:'interactive'});void this.context.resume().catch(()=>{});}catch{}};
    window.addEventListener('pointerdown',this.unlock,true);window.addEventListener('keydown',this.unlock,true);
    this.off=watchVoiceState(manager.store,['connection','sessionChannel','participants','muted','deafened','sharing','settings'],()=>this.changed());
  }
  changed() {
    const next=this.manager.store.get(),old=this.previous;this.previous=next;
    const connected=next.connection==='Connected'&&next.sessionChannel?.id;
    if(connected&&this.channel!==connected){this.channel=connected;this.play('join');}
    else if(this.channel&&(['Disconnected','Disconnecting','Error'].includes(next.connection)||next.connection==='Connecting'&&old.connection==='Connected')){this.channel=undefined;this.play('leave');}
    if(connected&&old.connection==='Connected'&&old.sessionChannel?.id===connected){
      const before=new Set(old.participants.filter(p=>p.channelId===connected&&p.userId!==old.user?.id).map(p=>p.userId));
      const after=new Set(next.participants.filter(p=>p.channelId===connected&&p.userId!==next.user?.id).map(p=>p.userId));
      if([...after].some(id=>!before.has(id)))this.play('join');
      if([...before].some(id=>!after.has(id)))this.play('leave');
      if(old.deafened!==next.deafened)this.play(next.deafened?'deafen':'undeafen');
      else if(old.muted!==next.muted&&performance.now()-Math.max(this.last.get('deafen')??-Infinity,this.last.get('undeafen')??-Infinity)>400)this.play(next.muted?'mute':'unmute');
    }
    if(old.sharing!==next.sharing)this.play(next.sharing?'streamStart':'streamStop');
  }
  play(kind) {
    const settings=this.manager.store.get().settings;
    if(this.closed||!settings.soundEffects)return;
    const now=performance.now();if(now-(this.last.get(kind)??-Infinity)<180)return;this.last.set(kind,now);
    this.unlock();const context=this.context;if(context?.state!=='running')return;
    const patterns={join:[660,880],leave:[660,440],mute:[440,330],unmute:[440,660],deafen:[330,262,220],undeafen:[330,440,660],streamStart:[523,659,784],streamStop:[659,523,392]};
    const volume=Math.max(0,Math.min(1,Number(settings.soundVolume)||0))*0.12;
    if(!volume)return;
    if(context.setSinkId&&this.output!==settings.outputDevice){this.output=settings.outputDevice;void context.setSinkId(this.output||'default').catch(()=>{});}
    patterns[kind].forEach((frequency,index)=>{
      const oscillator=context.createOscillator(),gain=context.createGain(),start=context.currentTime+index*0.075;
      oscillator.type='sine';oscillator.frequency.value=frequency;
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume,start+0.008);gain.gain.exponentialRampToValueAtTime(0.0001,start+0.10);
      oscillator.connect(gain);gain.connect(context.destination);oscillator.start(start);oscillator.stop(start+0.11);
      oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
    });
  }
  dispose(){this.closed=true;this.off();window.removeEventListener('pointerdown',this.unlock,true);window.removeEventListener('keydown',this.unlock,true);void this.context?.close().catch(()=>{});}
};

var BroadcastPreviews = class {
  constructor(manager){
    this.manager=manager;this.watchers=new Map();this.cache=new Map();this.requests=new Map();this.revision=0;this.closed=false;
    this.off=watchVoiceState(manager.store,['auth','connection','sessionChannel','mediaRevision','sharing','participants'],()=>this.sync());
    this.publisherTimer=setInterval(()=>void this.publish(),5000);this.sync();
  }
  sync(){
    if(this.closed)return;
    const room=this.manager.client.mediaRoom,state=this.manager.store.get(),client=this.manager.client;
    if(this.client!==client){this.client=client;this.cache.clear();this.requests.clear();}
    if(this.room!==room){this.room=room;this.revision++;this.captureAbort?.abort();this.imageCache=undefined;}
    if(!state.sharing){
      this.imageCache=undefined;this.captureAbort?.abort();
      if(this.broadcast){this.broadcast=undefined;void client.request('/api/v1/screenshare/preview','DELETE').catch(()=>{});}
    }
    for(const id of this.cache.keys()){
      const participant=state.participants.find(p=>p.mediaIdentity===id&&p.screenSharing);
      if(!participant){this.cache.delete(id);this.emit(id,{error:'방송이 종료되었습니다.'});}
    }
    if(state.sharing)void this.publish();
  }
  emit(id,value){for(const fn of this.watchers.get(id)?.listeners??[])fn(value);}
  subscribe(id,fn){
    let entry=this.watchers.get(id);
    if(!entry){entry={listeners:new Set(),timer:setInterval(()=>{if(!document.hidden)this.request(id);},5000)};this.watchers.set(id,entry);}
    entry.listeners.add(fn);
    const cached=this.cache.get(id);fn(cached&&Date.now()-Date.parse(cached.updatedAt)<20000?cached:{});this.request(id);
    return()=>{entry.listeners.delete(fn);if(!entry.listeners.size){clearInterval(entry.timer);this.watchers.delete(id);this.requests.delete(id);}};
  }
  request(id){
    if(this.closed)return;
    const state=this.manager.store.get(),client=this.manager.client;
    if(state.auth!=='authenticated'){this.emit(id,{error:'로그인한 뒤 미리볼 수 있습니다.'});return;}
    if(this.requests.has(id))return;
    const request={client};this.requests.set(id,request);
    void client.request('/api/v1/screenshare/previews/'+encodeURIComponent(id)).then(value=>{
      if(this.closed||this.manager.client!==client||this.requests.get(id)!==request)return;
      if(typeof value.image!=='string'||value.image.length>12000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value.image))throw Error('Invalid preview');
      this.cache.set(id,value);this.emit(id,value);
    }).catch(error=>{
      if(this.closed||this.manager.client!==client||this.requests.get(id)!==request)return;
      const cached=this.cache.get(id);
      if(error.status!==401&&error.status!==403&&cached&&Date.now()-Date.parse(cached.updatedAt)<20000)return;
      this.cache.delete(id);
      this.emit(id,{error:error.status===403?'이 방송을 볼 권한이 없습니다.':error.status===401?'다시 로그인해 주세요.':'미리보기를 준비 중입니다. 송출자도 최신 플러그인이 필요합니다.'});
    }).finally(()=>{if(this.requests.get(id)===request)this.requests.delete(id);});
  }
  async publish(){
    if(this.closed||this.publishing)return;
    const client=this.manager.client,state=this.manager.store.get(),room=this.room;
    const publication=room?.localParticipant.getTrackPublication(Track.Source.ScreenShare),streamId=publication?.trackSid;
    if(state.auth!=='authenticated'||!state.sharing||!streamId)return;
    const key=room.localParticipant.identity+':'+streamId;
    if(this.lastAttempt?.key===key&&Date.now()-this.lastAttempt.at<4500)return;
    this.lastAttempt={key,at:Date.now()};
    const revision=this.revision;this.publishing=true;
    try{
      const image=await this.picture();
      if(!image||this.closed||this.manager.client!==client||this.room!==room||this.revision!==revision||!this.manager.store.get().sharing||room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.trackSid!==streamId)return;
      await client.request('/api/v1/screenshare/preview','POST',{streamId,image});
      if(this.manager.client===client&&this.room===room&&this.manager.store.get().sharing){this.broadcast=key;this.lastUpload={key,at:Date.now()};}
      this.uploadError=undefined;
    }catch(error){this.uploadError=String(error);}
    finally{this.publishing=false;}
  }
  picture(){
    const room=this.room,track=room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if(!track||track.readyState==='ended'||!this.manager.store.get().sharing)return Promise.resolve();
    if(this.imageCache?.track===track&&Date.now()-this.imageCache.at<3000)return Promise.resolve(this.imageCache.image);
    if(this.captureWork?.track===track)return this.captureWork.promise;
    this.captureAbort?.abort();const controller=this.captureAbort=new AbortController();
    const work={track,promise:null};
    work.promise=(async()=>{
      const video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=new MediaStream([track]);
      let timer,callback;
      try{
        await new Promise((resolve,reject)=>{
          const ready=()=>resolve();const abort=()=>reject(new DOMException('Preview cancelled','AbortError'));
          controller.signal.addEventListener('abort',abort,{once:true});
          timer=setTimeout(()=>reject(Error('Preview frame unavailable')),1500);
          video.onloadeddata=ready;
          if(video.requestVideoFrameCallback)callback=video.requestVideoFrameCallback(ready);
          void video.play().catch(reject);
        });
        if(controller.signal.aborted||this.room!==room||track.readyState==='ended'||!this.manager.store.get().sharing||!video.videoWidth)return;
        const canvas=document.createElement('canvas');canvas.width=256;canvas.height=144;
        canvas.getContext('2d',{alpha:false}).drawImage(video,0,0,256,144);
        let image=canvas.toDataURL('image/jpeg',0.45);
        if(image.length>12000){canvas.width=192;canvas.height=108;canvas.getContext('2d',{alpha:false}).drawImage(video,0,0,192,108);image=canvas.toDataURL('image/jpeg',0.25);}
        if(image.length>12000)return;
        this.imageCache={track,image,at:Date.now()};return image;
      }finally{clearTimeout(timer);if(callback!==undefined)video.cancelVideoFrameCallback(callback);video.pause();video.srcObject=null;controller.abort();if(this.captureWork===work)this.captureWork=undefined;}
    })();this.captureWork=work;return work.promise;
  }
  dispose(){this.closed=true;this.off();this.revision++;this.captureAbort?.abort();clearInterval(this.publisherTimer);for(const entry of this.watchers.values())clearInterval(entry.timer);this.watchers.clear();this.cache.clear();this.requests.clear();this.room=undefined;}
};

function BroadcastThumbnail({manager,identity}){
  const React=BdApi.React;
  const [preview,setPreview]=React.useState({});
  React.useEffect(()=>{setPreview({});return manager.previews?.subscribe(identity,setPreview);},[manager,identity]);
  return React.createElement('div',{className:'cv-broadcast-thumbnail'},preview.image
    ?React.createElement('img',{src:preview.image,alt:'방송 미리보기',draggable:false})
    :React.createElement('span',null,preview.error||'방송 미리보기 요청 중…'));
}
function BroadcastHover({manager,identity,anchor}){
  const React=BdApi.React,ref=React.useRef(null);const [ready,setReady]=React.useState(false);
  React.useEffect(()=>{const timer=setTimeout(()=>setReady(true),250);return()=>clearTimeout(timer);},[identity]);
  React.useEffect(()=>{if(!ready||!ref.current||!anchor?.isConnected)return;const element=ref.current;const place=()=>{const rect=anchor.getBoundingClientRect();element.style.left=Math.max(8,Math.min(rect.right+10,window.innerWidth-278))+'px';element.style.top=Math.max(8,Math.min(rect.top,window.innerHeight-178))+'px';};element.showPopover?.();place();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);},[ready,anchor]);
  return ready?React.createElement('div',{ref,popover:'manual',role:'tooltip',className:'cv cv-broadcast-hover'},React.createElement(BroadcastThumbnail,{manager,identity})):null;
}
var customVoiceFeatureCss=`
.cv-broadcast-thumbnail{width:100%;aspect-ratio:16/9;background:#111318;border-radius:6px;overflow:hidden;display:grid;place-items:center;margin:10px 0;color:var(--text-muted,#aaa);font-size:12px;text-align:center}
.cv-broadcast-thumbnail img{display:block;width:100%;height:100%;object-fit:contain}
.cv-broadcast-thumbnail span{padding:12px}
.cv-broadcast-hover{position:fixed;inset:auto;margin:0;width:270px;padding:7px;border:1px solid #45464b;border-radius:8px;background:#202127;box-shadow:0 8px 24px #0005;pointer-events:none;z-index:2147483647}
.cv-broadcast-hover .cv-broadcast-thumbnail{margin:0}
.cv-screen .cv-screen-heading{transition:opacity .15s ease,visibility .15s ease}
.cv-screen:not(.cv-controls-visible):not(:has(:focus-visible)):not(:has(dialog[open])) .cv-screen-heading{opacity:0;visibility:hidden;pointer-events:none}
`;
