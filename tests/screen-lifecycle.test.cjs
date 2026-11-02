const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'),'utf8');
const cut = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const Track={Source:{ScreenShare:'screen',ScreenShareAudio:'screen-audio',Microphone:'mic'},Kind:{Audio:'audio',Video:'video'}};
const RoomEvent={TrackUnpublished:'unpublished',TrackPublished:'published',ParticipantDisconnected:'disconnected',LocalTrackUnpublished:'local-unpublished'};
function api() {
  const context=vm.createContext({Track,RoomEvent,defaults:{},crypto:require('node:crypto').webcrypto,customVoiceLog(){},setTimeout,clearTimeout,setInterval,clearInterval,DOMException,AbortController});
  vm.runInContext(cut('var VoiceClient = class','function base64url3(')+cut('var Store = class','function loadSettings('),context);
  return context;
}
function fixture() {
  const context=api(), client=new context.VoiceClient('https://example.test');
  const captures=[],stops=[],unpublished=[],commands=[];
  const tracks=['screen','screen-audio','mic'].map(source=>({source,mediaStreamTrack:{readyState:'live',stop(){captures.push(source);this.readyState='ended';}},stop:()=>stops.push(source)}));
  const pubs=new Map(tracks.map(track=>[track.source,{track,source:track.source,trackSid:track.source+'-sid'}]));
  const room=new EventEmitter();room.remoteParticipants=new Map();
  room.localParticipant={identity:'self',getTrackPublication:source=>pubs.get(source),unpublishTrack:async track=>{unpublished.push(track.source);if(pubs.get(track.source)?.track===track)pubs.delete(track.source);}};
  client.room=room;client.activeShare={fps:144};client.command=async(...args)=>commands.push(args);
  return {context,client,room,pubs,tracks,captures,stops,unpublished,commands};
}
test('stop notification and both capture tracks finish even when video unpublishing fails',async()=>{
  const f=fixture();
  f.room.localParticipant.unpublishTrack=async track=>{f.unpublished.push(track.source);if(track.source==='screen')throw Error('renegotiation failed');};
  await assert.rejects(f.client.stopScreenShare());
  assert.equal(f.commands.filter(c=>c[0]==='SCREEN_SHARE_STOP').length,1);
  assert.deepEqual(f.captures,['screen','screen-audio']);assert.deepEqual(f.stops,['screen','screen-audio']);
  assert.deepEqual(f.unpublished,['screen','screen-audio']);assert.equal(f.client.activeShare,undefined);
});

test('disabling screen audio stops capture before signaling and negotiation finish, even when both fail',async()=>{
  const f=fixture();let rejectCommand,rejectUnpublish;
  f.client.command=()=>new Promise((_,reject)=>{rejectCommand=reject;});
  f.room.localParticipant.unpublishTrack=()=>new Promise((_,reject)=>{rejectUnpublish=reject;});
  const off=f.client.setScreenShareAudio(false);
  const failed=assert.rejects(off);
  await new Promise(setImmediate);
  const stoppedBeforeResponse=f.captures.includes('screen-audio');
  rejectCommand(Error('socket closed'));rejectUnpublish?.(Error('negotiation failed'));
  await failed;
  assert.equal(stoppedBeforeResponse,true);
  assert.equal(f.client.screenShareAudioEnabled,false);
  assert.equal(f.tracks[0].mediaStreamTrack.readyState,'live');
  assert.equal(f.tracks[2].mediaStreamTrack.readyState,'live');
});

test('audio picker result from an old broadcast cannot publish into a newer broadcast',async()=>{
  const f=fixture();f.pubs.delete('screen-audio');let finish;
  f.client.screenCaptureAbort=new AbortController();
  f.client.options.screenCapture={captureAudio:()=>new Promise(resolve=>{finish=resolve;})};
  const audio=f.tracks[1];let published=0;
  f.room.localParticipant.publishTrack=async()=>{published++;};
  const work=f.client.setScreenShareAudio(true),failed=assert.rejects(work,{name:'AbortError'});
  f.client.screenCaptureAbort.abort();f.client.screenCaptureAbort=new AbortController();
  f.client.activeShare={quality:'1080p',fps:144};
  f.pubs.set('screen',{track:{mediaStreamTrack:{readyState:'live'}}});
  finish([audio]);await failed;
  assert.equal(published,0);assert.equal(f.commands.length,0);
  assert.equal(audio.mediaStreamTrack.readyState,'ended');
});

test('failed audio state synchronization retries its request and cannot cross video publications',async()=>{
  const f=fixture();let online=false;
  f.client.command=async(...args)=>{f.commands.push(args);if(!online)throw Error('offline');};
  await assert.rejects(f.client.setScreenShareAudio(false));
  assert.ok(f.client.pendingScreenAudio);const request=f.commands[0][2];
  online=true;await f.client.flushScreenAudio();
  assert.equal(f.commands.length,2);assert.equal(f.commands[1][2],request);
  assert.equal(f.client.pendingScreenAudio,undefined);
  const g=fixture();g.client.command=async(...args)=>{g.commands.push(args);throw Error('offline');};
  await assert.rejects(g.client.setScreenShareAudio(false));
  g.pubs.set('screen',{track:{mediaStreamTrack:{readyState:'live'}}});
  await g.client.flushScreenAudio();
  assert.equal(g.commands.length,1);assert.equal(g.client.pendingScreenAudio,undefined);
});

test('a slow audio announcement cannot arrive after STOP and local capture stops immediately',async()=>{
  const f=fixture();let finish;
  f.client.command=(...args)=>{f.commands.push(args);return args[0]==='SCREEN_SHARE_START'?new Promise(resolve=>{finish=resolve;}):Promise.resolve();};
  const audioOff=f.client.setScreenShareAudio(false);await new Promise(setImmediate);
  const stop=f.client.stopScreenShare();await new Promise(setImmediate);
  assert.deepEqual(f.commands.map(c=>c[0]),['SCREEN_SHARE_START']);
  assert.equal(f.tracks[0].mediaStreamTrack.readyState,'ended');
  finish();await Promise.all([audioOff,stop]);
  assert.deepEqual(f.commands.map(c=>c[0]),['SCREEN_SHARE_START','SCREEN_SHARE_STOP']);
  await f.client.flushScreenAudio();assert.equal(f.commands.length,2);
});

test('a failed replacement audio picker preserves the pending silent-state retry',async()=>{
  const f=fixture();f.client.command=async()=>{throw Error('offline');};
  await assert.rejects(f.client.setScreenShareAudio(false));
  const pending=f.client.pendingScreenAudio;
  f.client.options.screenCapture={captureAudio:async()=>{throw new DOMException('cancelled','AbortError');}};
  await assert.rejects(f.client.setScreenShareAudio(true),{name:'AbortError'});
  assert.equal(f.client.pendingScreenAudio,pending);
});

test('audio settings reflect locally stopped capture when server synchronization fails',async()=>{
  const f=fixture();
  vm.runInContext('var Manager = class {'+cut('  changeShareAudio(audio)','  watch(identity2,')+'};',f.context);
  const manager=new f.context.Manager(),store=new f.context.Store();store.set({settings:{shareAudio:true,shareFps:144}});
  manager.serial=fn=>fn();manager.store=store;manager.client=f.client;let saved;
  manager.save=settings=>{saved=settings;};f.client.command=async()=>{throw Error('offline');};
  await assert.rejects(manager.changeShareAudio(false));
  assert.equal(store.get().settings.shareAudio,false);assert.equal(saved.shareAudio,false);
  assert.equal(saved.shareFps,144);
});

test('late failed start only cleans its own tracks while the newer broadcast starts normally',async()=>{
  const f=fixture();f.pubs.clear();f.client.activeShare=undefined;let captured=0,finish;
  const profile={width:1920,height:1080,fps:144,captureFps:144,bitrate:24000000,publish:{}};
  Object.assign(f.context,{shareFrameRates:[144],screenProfile:()=>({...profile,publish:{}}),
    fixScreenCapture:async()=>({...profile,publish:{}}),selectScreenCodec:async()=> 'h264',
    configureScreenSender:async()=>{},reportScreenCaptureLimit:()=>{}});
  const videos=[0,1].map(index=>({kind:'video',source:'screen',sender:{},stop(){},
    mediaStreamTrack:{readyState:'live',getSettings:()=>({width:1920,height:1080}),stop(){this.readyState='ended';}}}));
  f.client.options.screenCapture=async()=>[videos[captured++]];
  f.room.localParticipant.publishTrack=async track=>{f.pubs.set(track.source,{track});};
  f.client.command=(...args)=>{f.commands.push(args);return f.commands.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve();};
  const old=f.client.startScreenShare('1080p',false,144),failed=assert.rejects(old);
  await new Promise(setImmediate);
  const fresh=f.client.startScreenShare('1080p',false,144);await new Promise(setImmediate);
  finish();await Promise.all([failed,fresh]);
  assert.deepEqual(f.commands.map(c=>c[0]),['SCREEN_SHARE_START','SCREEN_SHARE_START']);
  assert.equal(videos[0].mediaStreamTrack.readyState,'ended');
  assert.equal(videos[1].mediaStreamTrack.readyState,'live');
  assert.equal(f.client.screenCaptureAbort.signal.aborted,false);
  assert.equal(f.client.activeShare.fps,144);assert.equal(f.pubs.get('screen').track,videos[1]);
});
test('duplicate stop requests coalesce and server notification does not wait for negotiation',async()=>{
  const f=fixture();let finish;
  const wait=new Promise(resolve=>{finish=resolve;});
  f.room.localParticipant.unpublishTrack=()=>wait;
  const a=f.client.stopScreenShare(),b=f.client.stopScreenShare();assert.equal(a,b);
  await new Promise(setImmediate);
  assert.equal(f.commands.length,1);assert.equal(f.captures.length,2);
  finish();await a;assert.equal(f.client.screenStopWork,undefined);
});
test('a lost stop notification is retried with the same request ID and never crosses participant sessions',async()=>{
  const f=fixture();let connected=false;const requests=[];
  f.client.command=async(op,data,id)=>{requests.push({op,id});if(!connected)throw Error('disconnected');};
  await assert.rejects(f.client.stopScreenShare());assert.equal(f.stops.length,2);
  connected=true;await f.client.flushScreenStop();
  assert.equal(requests.length,2);assert.equal(requests[0].id,requests[1].id);assert.equal(f.client.pendingScreenStop,undefined);
  f.client.pendingScreenStop={identity:'old-session',requestId:'old-stop'};
  await f.client.flushScreenStop();assert.equal(requests.length,2);assert.equal(f.client.pendingScreenStop,undefined);
});
test('a new broadcast cannot start while an old stop remains unacknowledged',async()=>{
  const f=fixture();f.client.pendingScreenStop={identity:'self',requestId:'pending'};
  f.client.command=async()=>{throw Error('still disconnected');};
  await assert.rejects(f.client.startScreenShare('1080p',false,144),/still disconnected/);
  assert.equal(f.client.screenCaptureAbort,undefined);
});
test('unpublished remote video closes watching and survives a stale server snapshot; new video restores availability',()=>{
  const f=fixture(),store=new f.context.Store();
  const participant={identity:'peer',trackPublications:new Map(),getTrackPublication:()=>undefined};
  f.room.remoteParticipants.set('peer',participant);f.client.watching.add('peer');
  store.set({sessionChannel:{id:'call'},participants:[{userId:'u',mediaIdentity:'peer',channelId:'call',screenSharing:true,streams:[{}]}],watching:['peer'],poppedOut:['peer']});
  f.client.onEvent(event=>store.event(event));f.context.bindRemoteScreenLifecycle(f.client,f.room);
  f.room.emit('unpublished',{source:'screen-audio'},participant);assert.equal(store.get().watching.length,1);
  f.room.emit('unpublished',{source:'screen',trackSid:'old'},participant);
  assert.equal(store.get().watching.length,0);assert.equal(store.get().poppedOut.length,0);assert.equal(f.client.watching.size,0);
  store.event({op:'VOICE_PARTICIPANTS_SYNC',channelId:'call',data:[{userId:'u',mediaIdentity:'peer',channelId:'call',screenSharing:true,streams:[{}]}]});
  assert.equal(store.get().participants[0].screenSharing,false);
  f.room.emit('published',{source:'screen',trackSid:'new'},participant);
  assert.equal(store.get().participants[0].screenSharing,true);
  assert.equal(store.get().watching.length,0,'A new broadcast must not reopen a viewer automatically');
});
test('old-room events and replaced publications cannot close a newer live stream',()=>{
  const f=fixture(),events=[];
  const participant={identity:'peer',getTrackPublication:()=>({source:'screen',trackSid:'new'})};
  f.room.remoteParticipants.set('peer',participant);f.client.onEvent(e=>events.push(e));
  f.context.bindRemoteScreenLifecycle(f.client,f.room);
  f.room.emit('unpublished',{source:'screen',trackSid:'old'},participant);assert.equal(events.length,0);
  f.client.room={};f.room.emit('published',{source:'screen'},participant);assert.equal(events.length,0);
  f.client.room=f.room;f.room.remoteParticipants.delete('peer');f.room.emit('disconnected',participant);
  assert.equal(events.length,1);assert.equal(events[0].op,'MEDIA_SCREEN_ENDED');
});
test('microphone/audio removal does not stop broadcasting and duplicate video end notifications do not race',async()=>{
  const f=fixture();
  vm.runInContext('var Manager = class {'+cut('  async configureRoom()','  async publishMicrophone(')+'};',f.context);
  const manager=new f.context.Manager(),store=new f.context.Store();store.set({sharing:true});
  manager.client=f.client;manager.store=store;manager.media={attach:async()=>{},refreshGate(){}};manager.devices=async()=>{};manager.error=assert.fail;
  await manager.configureRoom();f.commands.length=0;
  f.room.emit('local-unpublished',{source:'mic'});f.room.emit('local-unpublished',{source:'screen-audio'});
  assert.equal(f.commands.length,0);assert.equal(store.get().sharing,true);
  f.pubs.delete('screen');f.room.emit('local-unpublished',{source:'screen',trackSid:'screen-sid'});
  f.room.emit('local-unpublished',{source:'screen',trackSid:'screen-sid'});
  await new Promise(setImmediate);assert.equal(f.commands.length,1);assert.equal(store.get().sharing,false);
  manager.roomCleanup();assert.equal(f.room.listenerCount('local-unpublished'),0);
});
