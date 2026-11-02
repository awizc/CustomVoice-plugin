const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const Track = {Source:{ScreenShare:'screen',ScreenShareAudio:'screen-audio',Microphone:'mic'},Kind:{Audio:'audio'}};
const RoomEvent = Object.fromEntries(['DataReceived','TrackSubscribed','TrackUnsubscribed','LocalTrackPublished','LocalTrackUnpublished','TrackPublished','TrackUnpublished','ParticipantConnected','ParticipantDisconnected','ParticipantPermissionsChanged','Reconnecting','Reconnected','Disconnected'].map(key=>[key,key]));
const read = name => fs.readFileSync(path.join(__dirname,'../native',name),'utf8');
function store(state) {
  const listeners = new Set();
  return {get:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set:patch=>{state={...state,...patch};for(const fn of listeners)fn();}};
}
function viewerFixture() {
  let now = 1000;
  const sent = [], logs = [], timers = new Set();
  const context = vm.createContext({Track,RoomEvent,TextEncoder,TextDecoder,Date:{now:()=>now},setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn),watchVoiceState:(s,keys,fn)=>s.subscribe(fn),customVoiceLog:(...args)=>logs.push(args)});
  vm.runInContext(read('broadcast-viewers.js'),context);
  const room = new EventEmitter(), pubs = new Map();
  const peer = {identity:'peer',name:'시청자',getTrackPublication:source=>pubs.get(source)};
  const local = {trackSid:'local-one',track:{mediaStreamTrack:{readyState:'live'}}};
  room.remoteParticipants=new Map([['peer',peer]]);
  room.localParticipant={identity:'self',getTrackPublication:()=>local,publishData:(data,options)=>{sent.push({data:JSON.parse(new TextDecoder().decode(data)),options});return Promise.resolve();}};
  const state=store({connection:'Connected',sessionChannel:{id:'call'},sharing:true,watching:[]});
  const manager={store:state,client:{mediaRoom:room}}, service=new context.BroadcastViewers(manager);
  const receive=(message,participant=peer,origin=room)=>origin.emit(RoomEvent.DataReceived,new TextEncoder().encode(JSON.stringify(message)),participant,0,service.topic);
  return {service,state,room,peer,pubs,local,sent,logs,timers,manager,receive,context,advance:ms=>now+=ms};
}
test('viewers require the current broadcast SID and a room-authenticated sender; stop and expiry remove them',()=>{
  const f=viewerFixture();let changes=0;f.service.subscribe(()=>changes++);
  f.receive({type:'watch',sid:'old',watching:true});
  f.receive({type:'watch',sid:'local-one',watching:true},{identity:'spoof'});
  f.receive({type:'watch',sid:'local-one',watching:'yes'});
  assert.equal(f.service.get().length,0);
  f.receive({type:'watch',sid:'local-one',watching:true});assert.deepEqual([...f.service.get()],['peer']);
  f.receive({type:'watch',sid:'local-one',watching:true});assert.equal(changes,1,'heartbeat does not rerender unchanged names');
  f.receive({type:'watch',sid:'local-one',watching:false});assert.equal(f.service.get().length,0);
  f.receive({type:'watch',sid:'local-one',watching:true});f.advance(36000);f.service.sync(true);assert.equal(f.service.get().length,0);
  f.service.dispose();assert.equal(f.timers.size,0);assert.equal(f.room.listenerCount(RoomEvent.DataReceived),0);
});
test('opening a preview does not announce viewing; only subscribed video is counted, including rewatch',()=>{
  const f=viewerFixture();f.state.set({watching:['peer']});assert.equal(f.sent.length,0);
  const publication={trackSid:'remote-one',isSubscribed:false};f.pubs.set('screen',publication);f.service.sync();assert.equal(f.sent.length,0);
  publication.isSubscribed=true;publication.track={mediaStreamTrack:{readyState:'live'}};
  f.room.emit(RoomEvent.TrackSubscribed);assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.watching,true);assert.deepEqual([...f.sent[0].options.destinationIdentities],['peer']);
  f.state.set({watching:[]});assert.equal(f.sent.at(-1).data.watching,false);
  f.state.set({watching:['peer']});assert.equal(f.sent.at(-1).data.watching,true);
  publication.track=undefined;f.room.emit(RoomEvent.TrackUnsubscribed);assert.equal(f.sent.at(-1).data.watching,false);
  f.service.dispose();
});
test('replacement broadcasts, disconnects and stale-room events cannot keep old viewers',()=>{
  const f=viewerFixture();f.receive({type:'watch',sid:'local-one',watching:true});
  f.local.trackSid='local-two';f.service.sync();assert.equal(f.service.get().length,0);
  f.receive({type:'watch',sid:'local-one',watching:true});assert.equal(f.service.get().length,0);
  f.receive({type:'watch',sid:'local-two',watching:true});f.room.emit(RoomEvent.ParticipantDisconnected,f.peer);assert.equal(f.service.get().length,0);
  f.state.set({connection:'Disconnected'});f.receive({type:'watch',sid:'local-two',watching:true});assert.equal(f.service.get().length,0);
  f.service.dispose();
});

test('server-disabled data grants are reported as unavailable and recover after a permission update',()=>{
  const f=viewerFixture();let changes=0;f.service.subscribe(()=>changes++);
  f.room.localParticipant.permissions={canPublishData:false};f.peer.permissions={canPublishData:false};
  f.pubs.set('screen',{trackSid:'remote-one',isSubscribed:true,track:{mediaStreamTrack:{readyState:'live'}}});
  f.state.set({watching:['peer']});f.room.emit(RoomEvent.ParticipantPermissionsChanged);
  assert.equal(f.service.availability,'unavailable');assert.equal(f.sent.length,0,'do not send packets that the server will silently discard');
  assert.ok(changes>=1,'permission-only changes notify the list even when the count is zero');
  assert.ok(f.logs.some(([level,,details])=>level==='warn'&&details.canPublishData===false&&details.blockedPeers===1));
  f.room.localParticipant.permissions.canPublishData=true;f.peer.permissions.canPublishData=true;
  f.room.emit(RoomEvent.ParticipantPermissionsChanged);
  assert.equal(f.service.availability,'available');assert.equal(f.sent.at(-1).data.watching,true,'the current watch is sent immediately after permissions recover');
  f.receive({type:'watch',sid:'local-one',watching:true});assert.deepEqual([...f.service.get()],['peer']);
  f.peer.permissions.canPublishData=false;f.room.emit(RoomEvent.ParticipantPermissionsChanged);
  assert.equal(f.service.availability,'unavailable');assert.equal(f.service.get().length,0,'revoked permissions remove stale presence');
  f.service.dispose();
});

test('a broadcaster without data-send permission can still count viewers whose permission is allowed',()=>{
  const f=viewerFixture();f.room.localParticipant.permissions={canPublishData:false};f.peer.permissions={canPublishData:true};
  const blocked={identity:'blocked',permissions:{canPublishData:false}};f.room.remoteParticipants.set(blocked.identity,blocked);
  f.room.emit(RoomEvent.ParticipantConnected,blocked);assert.equal(f.service.availability,'partial');
  f.receive({type:'watch',sid:'local-one',watching:true});assert.deepEqual([...f.service.get()],['peer']);
  f.receive({type:'watch',sid:'local-one',watching:true},blocked);assert.deepEqual([...f.service.get()],['peer']);
  f.room.remoteParticipants.delete(blocked.identity);f.room.emit(RoomEvent.ParticipantDisconnected,blocked);
  assert.equal(f.service.availability,'available');assert.deepEqual([...f.service.get()],['peer']);f.service.dispose();
});

test('blocked viewer UI explains the server restriction instead of claiming zero viewers',()=>{
  const f=viewerFixture();f.peer.permissions={canPublishData:false};f.service.sync();f.state.set({participants:[],profiles:{}});f.manager.viewers=f.service;
  const React={useSyncExternalStore:(_subscribe,get)=>get(),useMemo:fn=>fn(),createElement:(type,props,...children)=>({type,props,children})};
  Object.assign(f.context,{BdApi:{React},Compatibility:class{},createVoiceSnapshot:s=>s.get});
  const tree=f.context.BroadcastViewerList({manager:f.manager});
  const text=node=>typeof node==='string'?node:node&&typeof node==='object'?(node.children??[]).map(text).join(' '):'';
  assert.match(text(tree),/시청자 확인 불가/);assert.match(text(tree),/서버 설정으로 시청 알림이 차단/);
  assert.doesNotMatch(text(tree),/시청자 0명|확인된 시청자가 없습니다/);f.service.dispose();
});
test('Discord sound names replace synthetic tones and suppress duplicate deafen/mute and reconnect sounds',()=>{
  const played=[],stopped=[],timers=new Set();let now=0;
  const state=store({connection:'Disconnected',participants:[],muted:false,deafened:false,sharing:false,settings:{soundEffects:true}});
  const engine={createSound:name=>({play(){played.push(name);},stop(){stopped.push(name);}})};
  const context=vm.createContext({performance:{now:()=>now},watchVoiceState:(s,keys,fn)=>s.subscribe(fn),setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn),customVoiceLog(){},BdApi:{Webpack:{getByKeys:()=>engine}}});
  vm.runInContext(read('voice-extras.js'),context);
  const sounds=new context.VoiceSounds({store:state});
  const change=patch=>{now+=1000;state.set(patch);};
  change({connection:'Connected',sessionChannel:{id:'call'}});
  change({deafened:true,muted:true});
  change({deafened:false,muted:false});
  change({muted:true});change({muted:false});
  change({sharing:true});change({sharing:false});
  const count=played.length;change({connection:'Reconnecting'});change({connection:'Connected'});assert.equal(played.length,count);
  change({connection:'Disconnecting'});
  assert.deepEqual(played,['user_join','deafen','undeafen','mute','unmute','stream_started','stream_ended','user_leave']);
  change({settings:{soundEffects:false}});sounds.play('join');assert.equal(played.length,8);
  sounds.dispose();assert.equal(stopped.length,8);assert.equal(timers.size,0);
});
