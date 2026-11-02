// Bundled UI services. Use the client's own sound engine and bundled assets.
var VoiceSounds = class {
  constructor(manager) {
    this.manager=manager;this.previous=manager.store.get();this.channel=this.previous.connection==='Connected'?this.previous.sessionChannel?.id:undefined;this.closed=false;this.last=new Map();this.active=new Map();
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
    if(old.sharing!==next.sharing&&connected)this.play(next.sharing?'streamStart':'streamStop');
  }
  resolve() {
    if(this.engine)return;
    // Retry discovery if Discord has not loaded its sound module yet.
    const now=performance.now();if(this.lookupAt!==undefined&&now-this.lookupAt<5000)return;this.lookupAt=now;
    const webpack=globalThis.BdApi?.Webpack;
    try{this.engine=webpack?.getByKeys?.('createSound');}catch{}
    try{this.parser??=webpack?.getModule?.(value=>{
      if(typeof value!=='function'||typeof value.keys!=='function')return false;
      try{const keys=value.keys();return keys.includes('./user_join.mp3')&&keys.includes('./mute.mp3');}catch{return false;}
    },{searchExports:true});}catch{}
  }
  play(kind) {
    const settings=this.manager.store.get().settings;
    if(this.closed||!settings.soundEffects)return;
    const now=performance.now();if(now-(this.last.get(kind)??-Infinity)<180)return;this.last.set(kind,now);
    const names={join:'user_join',leave:'user_leave',mute:'mute',unmute:'unmute',deafen:'deafen',undeafen:'undeafen',streamStart:'stream_started',streamStop:'stream_ended'};
    const name=names[kind];if(!name)return;
    this.resolve();
    const failed=error=>{if(!this.warned){this.warned=true;customVoiceLog('warn','[CustomVoice] Discord sound unavailable',{name,message:error?.message});}};
    try{
      let sound;
      if(this.engine?.createSound){
        sound=this.engine.createSound(name);
        if(typeof sound?.play!=='function')throw Error('Discord sound player is unavailable');
      }else if(this.parser){
        const key=`./${name}.mp3`;if(!this.parser.keys().includes(key))throw Error('Discord sound asset is unavailable');
        const source=this.parser(key);const audio=new Audio(typeof source==='string'?source:source.default);
        const nativeVolume=globalThis.BdApi?.Webpack?.getStore?.('MediaEngineStore')?.getOutputVolume?.();
        audio.volume=Number.isFinite(nativeVolume)?Math.max(0,Math.min(1,nativeVolume/100)):1;
        if(audio.setSinkId)void audio.setSinkId(settings.outputDevice==='default'?'':settings.outputDevice||'').catch(failed);
        sound={play:()=>audio.play(),stop:()=>{audio.pause();audio.removeAttribute('src');audio.load();}};
      }else throw Error('Discord sound module has not loaded');
      const timer=setTimeout(()=>{this.active.delete(sound);try{sound.stop?.();}catch{}},8000);this.active.set(sound,timer);
      Promise.resolve(sound.play()).catch(failed);
    }catch(error){failed(error);}
  }
  dispose(){this.closed=true;this.off();for(const [sound,timer] of this.active){clearTimeout(timer);try{sound.stop?.();}catch{}}this.active.clear();}
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
function BroadcastHover({manager,identity,anchor,pinned=false,onPin,onClose,onEnter,onLeave}){
  const React=BdApi.React,ref=React.useRef(null);const [ready,setReady]=React.useState(pinned),[pending,setPending]=React.useState(false);
  React.useEffect(()=>{if(pinned){setReady(true);return;}const timer=setTimeout(()=>setReady(true),250);return()=>clearTimeout(timer);},[identity,pinned]);
  React.useEffect(()=>{
    if(!ready||!ref.current||!anchor?.isConnected)return;
    const element=ref.current,doc=element.ownerDocument,win=doc.defaultView;
    const place=()=>{if(!anchor.isConnected){onClose();return;}const rect=anchor.getBoundingClientRect(),size=element.getBoundingClientRect();element.style.left=Math.max(8,Math.min(rect.right+8,win.innerWidth-size.width-8))+'px';element.style.top=Math.max(8,Math.min(rect.top,win.innerHeight-size.height-8))+'px';};
    const outside=event=>{if(!element.contains(event.target)&&!anchor.contains(event.target))onClose();};
    const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();if(pinned)anchor.querySelector('button')?.focus();}};
    element.showPopover?.();place();
    if(pinned)element.querySelector('button')?.focus();
    const observer=new ResizeObserver(place);observer.observe(element);
    win.addEventListener('resize',place);doc.addEventListener('scroll',place,true);doc.addEventListener('pointerdown',outside,true);doc.addEventListener('keydown',key,true);
    return()=>{observer.disconnect();win.removeEventListener('resize',place);doc.removeEventListener('scroll',place,true);doc.removeEventListener('pointerdown',outside,true);doc.removeEventListener('keydown',key,true);};
  },[ready,anchor,pinned,onClose]);
  if(!ready)return null;
  const participant=manager.store.get().participants.find(p=>p.mediaIdentity===identity&&p.screenSharing);
  if(!participant)return null;
  const self=participant.userId===manager.store.get().user?.id;
  return React.createElement('div',{ref,popover:'manual',role:'dialog','aria-label':'방송 미리보기',className:'cv cv-broadcast-hover',onPointerEnter:onEnter,onPointerLeave:onLeave,onClick:onPin,onFocus:onPin},
    React.createElement('div',{className:'cv-preview-heading'},React.createElement('strong',null,'방송 미리보기'),pinned&&React.createElement('button',{type:'button','aria-label':'미리보기 닫기',onClick:event=>{event.stopPropagation();onClose();}},'×')),
    React.createElement(BroadcastThumbnail,{manager,identity}),
    React.createElement('button',{type:'button',className:'cv-watch-button',disabled:pending,onClick:event=>{event.stopPropagation();onPin();setPending(true);void manager.watchParticipant(participant).then(onClose).catch(error=>manager.error(error)).finally(()=>setPending(false));}},self?'내 방송 보기':'방송 보기'));
}
var customVoiceFeatureCss=`
.cv-broadcast-thumbnail{width:100%;aspect-ratio:16/9;background:#111318;border-radius:6px;overflow:hidden;display:grid;place-items:center;margin:10px 0;color:var(--text-muted,#aaa);font-size:12px;text-align:center}
.cv-broadcast-thumbnail img{display:block;width:100%;height:100%;object-fit:contain}
.cv-broadcast-thumbnail span{padding:12px}
.cv-broadcast-hover{position:fixed;inset:auto;margin:0;width:286px;max-width:calc(100vw - 16px);padding:12px;border:1px solid var(--border-subtle,#ffffff14);border-radius:var(--radius-md,8px);background:var(--background-floating,#111214);box-shadow:var(--elevation-high,0 8px 24px #0005);pointer-events:auto;z-index:2147483647}
.cv-preview-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:14px;line-height:20px}
.cv-preview-heading button{display:grid;place-items:center;width:24px;height:24px;padding:0;font-size:20px;line-height:1;background:transparent}
.cv-broadcast-hover .cv-watch-button{margin-top:10px}
.cv-broadcast-hover .cv-broadcast-thumbnail{margin:0}
.cv-screen .cv-screen-heading{transition:opacity .15s ease,visibility .15s ease}
.cv-screen:not(.cv-controls-visible):not(:has(:focus-visible)):not(:has(dialog[open])) .cv-screen-heading{opacity:0;visibility:hidden;pointer-events:none}
`;
