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
    this.manager=manager;this.watchers=new Map();this.cache=new Map();this.requests=new Map();this.incoming=new Map();this.revision=0;
    this.off=watchVoiceState(manager.store,['connection','sessionChannel','mediaRevision','sharing','participants'],()=>this.sync());this.sync();
  }
  sync(){
    const room=this.manager.client.mediaRoom;
    if(this.room!==room){
      this.room?.off(RoomEvent.DataReceived,this.received);this.room=room;this.revision++;this.captureAbort?.abort();this.imageCache=undefined;this.cache.clear();for(const request of this.requests.values())clearTimeout(request.timer);this.requests.clear();this.incoming.clear();
      this.received=(payload,participant,_kind,topic)=>{if(topic==='customvoice.preview.v1')void this.receive(payload,participant).catch(()=>{});};
      room?.on(RoomEvent.DataReceived,this.received);
      for(const id of this.watchers.keys())this.request(id);
    }
    const state=this.manager.store.get();
    if(!state.sharing){this.imageCache=undefined;this.captureAbort?.abort();const self=room?.localParticipant.identity;if(this.cache.delete(self))this.emit(self,{error:'방송이 종료되었습니다.'});}
    for(const id of this.cache.keys())if(id!==room?.localParticipant.identity&&!state.participants.some(p=>p.mediaIdentity===id&&p.screenSharing)){this.cache.delete(id);this.emit(id,{error:'방송이 종료되었습니다.'});}
  }
  emit(id,value){for(const fn of this.watchers.get(id)?.listeners??[])fn(value);}
  subscribe(id,fn){
    let entry=this.watchers.get(id);
    if(!entry){entry={listeners:new Set(),timer:setInterval(()=>{if(!document.hidden)this.request(id);},5000)};this.watchers.set(id,entry);}
    entry.listeners.add(fn);fn(this.cache.get(id)||{});this.request(id);
    return()=>{entry.listeners.delete(fn);if(!entry.listeners.size){clearInterval(entry.timer);this.watchers.delete(id);clearTimeout(this.requests.get(id)?.timer);this.requests.delete(id);}};
  }
  request(id){
    const room=this.room;if(!room||this.manager.store.get().connection!=='Connected'){this.emit(id,{error:'음성 채널에 연결한 뒤 미리볼 수 있습니다.'});return;}
    if(id===room.localParticipant.identity){void this.picture().then(image=>{if(image){const value={image};this.cache.set(id,value);this.emit(id,value);}}).catch(()=>this.emit(id,{error:'미리보기를 준비 중입니다.'}));return;}
    if(!room.remoteParticipants.has(id)){this.emit(id,{error:'같은 음성 채널에 접속하면 미리볼 수 있습니다.'});return;}
    const previous=this.requests.get(id);if(previous&&Date.now()-previous.at<3000)return;
    clearTimeout(previous?.timer);
    const request={id:crypto.randomUUID(),at:Date.now()};this.requests.set(id,request);
    request.timer=setTimeout(()=>{if(this.requests.get(id)===request&&!this.cache.has(id))this.emit(id,{error:'미리보기 응답이 없습니다. 송출자도 최신 플러그인이 필요합니다.'});},4000);
    void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({type:'request',id:request.id})),{reliable:true,topic:'customvoice.preview.v1',destinationIdentities:[id]}).catch(()=>this.emit(id,{error:'썸네일 요청을 보내지 못했습니다.'}));
  }
  async receive(payload,participant){
    const room=this.room;if(!room||!participant||room.remoteParticipants.get(participant.identity)!==participant||payload.byteLength>15000)return;
    const message=JSON.parse(new TextDecoder().decode(payload));
    if(typeof message.id!=='string'||message.id.length>64)return;
    if(message.type==='request'){
      if(!this.manager.store.get().sharing||Date.now()-(this.incoming.get(participant.identity)??0)<2500)return;
      if(this.incoming.size>200)this.incoming.clear();this.incoming.set(participant.identity,Date.now());
      const revision=this.revision,image=await this.picture();
      if(!image||this.room!==room||this.revision!==revision||!this.manager.store.get().sharing)return;
      await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({type:'image',id:message.id,image})),{reliable:false,topic:'customvoice.preview.v1',destinationIdentities:[participant.identity]});
    }else if(message.type==='image'&&this.requests.get(participant.identity)?.id===message.id){
      if(typeof message.image!=='string'||message.image.length>12000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(message.image))return;
      if(!this.manager.store.get().participants.some(p=>p.mediaIdentity===participant.identity&&p.screenSharing))return;
      clearTimeout(this.requests.get(participant.identity)?.timer);
      const value={image:message.image};this.cache.set(participant.identity,value);this.emit(participant.identity,value);
    }
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
  dispose(){this.off();this.revision++;this.captureAbort?.abort();this.room?.off(RoomEvent.DataReceived,this.received);this.room=undefined;for(const entry of this.watchers.values())clearInterval(entry.timer);for(const request of this.requests.values())clearTimeout(request.timer);this.watchers.clear();this.cache.clear();this.requests.clear();this.incoming.clear();}
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
