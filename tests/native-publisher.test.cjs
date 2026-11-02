const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createNativeScreenService}=require('../server/native-screen-service.cjs');
function server(){
 let time=1000;const removed=[],metadata=[],grants=[];
 const service=createNativeScreenService({now:()=>time,resolveVoiceSession:async context=>context,issueToken:async value=>{grants.push(value);return 'private-token';},writeBindings:async(room,value)=>metadata.push(value),removeParticipant:async(room,id)=>removed.push(id)});
 const owner={room:'room',identity:'alice',url:'wss://media.test',canScreenShare:true};
 return {service,owner,removed,metadata,grants,advance:ms=>time+=ms};
}
test('server issues separate screen-only identities and revokes previous sessions',async()=>{
 const h=server(),first=await h.service.create(h.owner),second=await h.service.create(h.owner);
 assert.notEqual(first.identity,h.owner.identity);assert.notEqual(first.identity,second.identity);
 assert.deepEqual(h.grants[0].grant.canPublishSources,['screen_share']);assert.equal(h.grants[0].grant.canSubscribe,false);
 assert.equal(h.service.authorizePublisher('room',first.identity),false);assert.equal(h.service.authorizePublisher('room',second.identity),true);
 assert.deepEqual(h.removed,[first.identity]);assert.equal(h.metadata.at(-1).bindings.length,1);
});
test('server rejects other owners and expires orphan publishers even without a stop request',async()=>{
 const h=server(),value=await h.service.create(h.owner);
 await assert.rejects(h.service.stop({...h.owner,identity:'bob'},value.session),e=>e.status===403);
 h.advance(60000);await h.service.renew(h.owner,value.session);h.advance(60000);await h.service.sweep();assert.equal(h.removed.length,0);
 h.advance(30001);await h.service.sweep();assert.deepEqual(h.removed,[value.identity]);assert.equal(h.metadata.at(-1).bindings.length,0);
 await assert.rejects(h.service.renew(h.owner,value.session),e=>e.status===404);
 await assert.rejects(h.service.create({...h.owner,canScreenShare:false}),e=>e.status===403);
});
test('concurrent requests cannot create duplicate publisher bindings and voice leave revokes them',async()=>{
 const h=server();const results=await Promise.all([h.service.create(h.owner),h.service.create(h.owner)]);
 assert.equal(h.metadata.at(-1).bindings.length,1);assert.equal(h.removed.length,1);
 await h.service.revokeOwner('room','alice');assert.equal(h.removed.length,2);
 for(const result of results)assert.equal(h.service.authorizePublisher('room',result.identity),false);
});
test('native room binding resolves video to the publisher and keeps audio/viewer identity on owner',()=>{
 const room=new EventEmitter();room.metadata='';room.remoteParticipants=new Map();
 const events={RoomMetadataChanged:'metadata',ParticipantConnected:'connected',ParticipantDisconnected:'disconnected',TrackPublished:'published',TrackUnpublished:'unpublished'};
 function participant(identity,publications={}){return {identity,getTrackPublication(source){return publications[source];}};}
 room.localParticipant=participant('self');const audio={source:'audio'},video={source:'screen',setSubscribed(value){this.subscribed=value;}};
 const owner=participant('alice',{audio}),publisher=participant('cv-screen:id',{screen:video});
 room.remoteParticipants.set('alice',owner);room.remoteParticipants.set(publisher.identity,publisher);
 const client={room,watching:new Set(['alice']),emit(){}};
 const api=vm.createContext({setTimeout:()=>0,Track:{Source:{ScreenShare:'screen',ScreenShareAudio:'audio'}},RoomEvent:events});
 vm.runInContext(fs.readFileSync(require.resolve('../native/native-broadcast.js'),'utf8'),api);
 const cleanup=api.installNativeScreenBindings(client,room);
 publisher.metadata=JSON.stringify({owner:'alice'});assert.equal(owner.getTrackPublication('screen'),undefined);
 room.metadata=JSON.stringify({customVoiceNativeScreen:{version:1,bindings:[{owner:'alice',publisher:publisher.identity,session:'id'}]}});room.emit('metadata');
 assert.equal(owner.getTrackPublication('screen'),video);assert.equal(owner.getTrackPublication('audio'),audio);assert.equal(video.subscribed,true);
 assert.equal(room.customVoiceScreenOwner(publisher.identity),'alice');
 room.metadata='{}';room.emit('metadata');assert.equal(owner.getTrackPublication('screen'),undefined);
 cleanup();assert.equal(room.customVoiceScreenOwner,undefined);
});
test('runtime encoder history is scoped by adapter/driver and ignores network/conversion pressure',()=>{
 const selections=new WeakMap(),track={},saved=[];
 const api=vm.createContext({Date,screenCodecSelections:selections,navigator:{userAgent:'test'},BdApi:{Data:{load:()=>[],save:(...args)=>saved.push(args)}}});
 vm.runInContext(fs.readFileSync(require.resolve('../native/encoder-history.js'),'utf8'),api);
 const selection={device:'gpu:driver1',width:1920,height:1080,fps:165};selections.set(track,selection);
 const sample={sample:{},intervalMs:2000,captureFps:165,encodeFps:165,codec:'h264',codecParameters:'profile-level-id=42e033',width:1920,height:1080};
 const native={sourceAvailable:true,cadenceState:'target'};
 for(let i=0;i<20;i++)api.screenEncoderHistory.observe(track,{...sample,networkLimited:true},native);
 assert.equal(saved.length,0);
 for(let i=0;i<15;i++)api.screenEncoderHistory.observe(track,sample,native);
 assert.equal(saved.length,1);
 const key=api.screenEncoderHistory.key('gpu:driver1',1920,1080,165,'h264',sample.codecParameters);
 assert.equal(api.screenEncoderHistory.score(key),2);
 assert.equal(api.screenEncoderHistory.score(api.screenEncoderHistory.key('gpu:driver2',1920,1080,165,'h264',sample.codecParameters)),0);
});

function nativeHarness(){
 const track=new EventTarget();track.readyState='live';track.getSettings=()=>({width:1920,height:1080});track.stop=()=>track.readyState='ended';
 const video={mediaStreamTrack:track},requests=[],actions=[],captures=new WeakMap();
 const capture={metadata:{},startPublisher:async()=>{actions.push('native-start');return {sid:'native-sid'};},stopPublisher:async()=>actions.push('native-stop')};captures.set(track,capture);
 const room={localParticipant:{identity:'alice',publishTrack:async()=>{actions.push('browser-publish');video.sender={};},unpublishTrack:async()=>actions.push('browser-unpublish')}};
 const credentials={session:'01234567-1234-1234-1234-0123456789ab',identity:'cv-screen:uuid',owner:'alice',token:'private',url:'wss://media.test'};
 const client={room,nativeScreenCapability:'nvenc-v1',request:async(path,method)=>{requests.push({path,method});return method==='POST'?credentials:{};},stopScreenShare:async()=>actions.push('screen-stop')};
 const api=vm.createContext({RoomEvent:{LocalTrackUnpublished:'local-ended'},nativeScreenCaptures:captures,CustomVoiceNative:{startPublisher(){}},Track:{Source:{ScreenShare:'screen'}},DOMException,setInterval:()=>1,clearInterval(){},configureScreenSender:async()=>actions.push('browser-configure'),customVoiceLog(){}});
 vm.runInContext(fs.readFileSync(require.resolve('../native/native-broadcast.js'),'utf8'),api);
 return {api,video,track,capture,room,client,credentials,requests,actions,profile:{bitrate:10000000,publish:{videoCodec:'h264'}}};
}
test('native publishing is gated by server capability and never reuses the voice identity',async()=>{
 const h=nativeHarness();h.client.nativeScreenCapability=undefined;
 assert.equal(await h.api.tryNativeScreenPublisher(h.client,h.room,h.video,h.profile,{aborted:false}),false);assert.equal(h.requests.length,0);
 h.client.nativeScreenCapability='nvenc-v1';h.credentials.identity='alice';
 assert.equal(await h.api.tryNativeScreenPublisher(h.client,h.room,h.video,h.profile,{aborted:false}),false);assert.ok(!h.actions.includes('native-start'));assert.equal(h.requests.at(-1).method,'DELETE');
});
test('native publication preserves the voice room and prepares browser fallback before removing the native binding',async()=>{
 const h=nativeHarness();assert.equal(await h.api.tryNativeScreenPublisher(h.client,h.room,h.video,h.profile,{aborted:false}),true);
 assert.equal(h.room.customVoiceNativePreview.trackSid,'native-sid');assert.equal(h.client.room,h.room);
 h.track.dispatchEvent(new Event('customvoicepublishererror'));await new Promise(setImmediate);
 assert.deepEqual(h.actions,['native-start','browser-publish','browser-configure','native-stop']);assert.equal(h.room.customVoiceNativePreview,undefined);assert.equal(h.client.nativeBroadcast,undefined);assert.equal(h.client.room,h.room);
});
test('cancellation while starting native publishing cleans its server lease without browser publication',async()=>{
 const h=nativeHarness(),signal={aborted:false};h.capture.startPublisher=async()=>{signal.aborted=true;return {sid:'native'};};
 await assert.rejects(h.api.tryNativeScreenPublisher(h.client,h.room,h.video,h.profile,signal),{name:'AbortError'});
 assert.equal(h.room.customVoiceNativePreview,undefined);assert.equal(h.requests.at(-1).method,'DELETE');assert.ok(!h.actions.includes('browser-publish'));
});

test('ending a native capture also clears local broadcast lifecycle without disconnecting voice',async()=>{
 const h=nativeHarness(),events=[];h.room.emit=(...event)=>events.push(event);
 await h.api.tryNativeScreenPublisher(h.client,h.room,h.video,h.profile,{aborted:false});
 h.track.dispatchEvent(new Event('ended'));await new Promise(setImmediate);
 assert.equal(events[0][0],'local-ended');assert.equal(events[0][1].trackSid,'native-sid');assert.ok(h.actions.includes('screen-stop'));assert.equal(h.client.room,h.room);
 await h.client.nativeBroadcast.stop();
});
