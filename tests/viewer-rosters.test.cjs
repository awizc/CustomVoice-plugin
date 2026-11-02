const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const Track = {Source:{ScreenShare:'screen'}};
const eventNames = ['DataReceived','TrackSubscribed','TrackUnsubscribed','LocalTrackPublished','LocalTrackUnpublished','TrackPublished','TrackUnpublished','ParticipantConnected','ParticipantDisconnected','ParticipantPermissionsChanged','Reconnecting','Reconnected','Disconnected'];
const RoomEvent = Object.fromEntries(eventNames.map(name=>[name,name]));
const source = fs.readFileSync(path.join(__dirname,'../native/broadcast-viewers.js'),'utf8');
const liveTrack = () => ({mediaStreamTrack:{readyState:'live'}});
const treeText = node => typeof node==='string' ? node : Array.isArray(node) ? node.map(treeText).join(' ') : node&&typeof node==='object' ? (node.children??[]).map(treeText).join(' ') : '';

// Independent clients exchange the actual service's encoded messages through a
// deterministic transport. No Discord, browser, microphone, or server is opened.
function network() {
  let now=1000;
  const clients=new Map(),queue=[],packets=[];
  for (const id of ['host','alice','bob','otherHost','observer']) {
    const room=new EventEmitter(),listeners=new Set(),pubs=new Map();
    let state={connection:'Connected',sharing:false,watching:[],sessionChannel:{id:'call'},user:{id,username:id},profiles:{},participants:[]};
    const store={get:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set:patch=>{state={...state,...patch};for(const fn of listeners)fn();}};
    const local={identity:id,name:id,permissions:{canPublishData:true},getTrackPublication:()=>local.publication,publishData:(bytes,options)=>{
      const message=JSON.parse(new TextDecoder().decode(bytes));
      const packet={from:id,bytes,options,message};packets.push(packet);queue.push(packet);return Promise.resolve();
    }};
    if (id==='host'||id==='otherHost') { local.publication={trackSid:id+'-one',track:liveTrack()};state.sharing=true; }
    room.localParticipant=local;room.remoteParticipants=new Map();
    const context=vm.createContext({Track,RoomEvent,TextEncoder,TextDecoder,Date:{now:()=>now},setInterval:()=>1,clearInterval(){},customVoiceLog(){},watchVoiceState:(s,_keys,fn)=>s.subscribe(fn)});
    vm.runInContext(source,context);
    clients.set(id,{id,room,store,pubs,context,manager:{store,client:{mediaRoom:room}}});
  }
  for (const c of clients.values()) {
    c.store.set({participants:[...clients.keys()].map(id=>({userId:id,mediaIdentity:id}))});
    for (const peer of clients.values()) if (peer!==c) {
      const publication=peer.room.localParticipant.publication;
      if (publication) c.pubs.set(peer.id,{trackSid:publication.trackSid,isSubscribed:false});
      c.room.remoteParticipants.set(peer.id,{identity:peer.id,name:peer.id,permissions:peer.room.localParticipant.permissions,getTrackPublication:()=>c.pubs.get(peer.id)});
    }
    c.service=new c.context.BroadcastViewers(c.manager);c.manager.viewers=c.service;
  }
  function deliver(from,to,message) {
    const c=clients.get(to),peer=c?.room.remoteParticipants.get(from);
    if (!peer||peer.permissions.canPublishData===false) return;
    c.room.emit(RoomEvent.DataReceived,new TextEncoder().encode(JSON.stringify(message)),peer,0,c.service.topic);
  }
  function flush() {
    let count=0;
    while(queue.length) {
      assert.ok(++count<1000,'roster messages must not loop');
      const packet=queue.shift();
      for (const id of packet.options.destinationIdentities) deliver(packet.from,id,packet.message);
    }
  }
  function watch(id,target,enabled=true) {
    const c=clients.get(id),pub=c.pubs.get(target);
    c.store.set({watching:enabled?[...new Set([...c.store.get().watching,target])]:c.store.get().watching.filter(x=>x!==target)});
    pub.track=enabled?liveTrack():undefined;pub.isSubscribed=enabled;
    c.room.emit(enabled?RoomEvent.TrackSubscribed:RoomEvent.TrackUnsubscribed,pub.track,pub,c.room.remoteParticipants.get(target));
  }
  function ui(id,target) {
    const c=clients.get(id);
    const React={useSyncExternalStore:(_subscribe,get)=>get(),useMemo:fn=>fn(),createElement:(type,props,...children)=>({type,props,children})};
    Object.assign(c.context,{BdApi:{React},Compatibility:class{},Avatar:()=>null,identity:p=>({name:p.userId}),createVoiceSnapshot:s=>s.get});
    return treeText(c.context.BroadcastViewerList({manager:c.manager,identity:target}));
  }
  return {clients,packets,queue,watch,flush,deliver,ui,advance:ms=>now+=ms,ids:(id,target)=>[...clients.get(id).service.getBroadcast(target).ids],close:()=>{for(const c of clients.values())c.service.dispose();}};
}

test('broadcaster and two viewers share the same roster, including the viewing user; observers receive no roster',()=>{
  const n=network();try {
    n.watch('alice','host');n.flush();n.watch('bob','host');n.flush();
    for (const id of ['host','alice','bob']) assert.deepEqual(n.ids(id,'host'),['alice','bob']);
    assert.match(n.ui('alice','host'),/시청자 2명/);assert.match(n.ui('alice','host'),/alice\s+\(나\)/);assert.match(n.ui('alice','host'),/bob/);
    assert.equal(n.ui('observer','host'),'','no list is mounted by a preview or an unwatched stream');
    assert.ok(n.packets.filter(p=>p.message.type==='viewers').every(p=>p.options.destinationIdentities.every(id=>id==='alice'||id==='bob')));
    const c=n.clients.get('alice'),before=c.service.getRevision();
    n.clients.get('host').service.sync(true);n.flush();assert.equal(c.service.getRevision(),before,'unchanged roster heartbeats do not rerender');
  } finally {n.close();}
});

test('stop, rewatch, and channel departure update all remaining viewers',()=>{
  const n=network();try {
    n.watch('alice','host');n.watch('bob','host');n.flush();
    n.watch('alice','host',false);n.flush();assert.deepEqual(n.ids('host','host'),['bob']);assert.deepEqual(n.ids('bob','host'),['bob']);
    assert.equal(n.clients.get('alice').service.remoteLists.size,0);
    n.watch('alice','host');n.flush();assert.deepEqual(n.ids('alice','host'),['alice','bob']);
    n.clients.get('bob').service.dispose();
    for(const c of n.clients.values())if(c.id!=='bob') {const peer=c.room.remoteParticipants.get('bob');c.room.remoteParticipants.delete('bob');c.room.emit(RoomEvent.ParticipantDisconnected,peer);}
    n.flush();assert.deepEqual(n.ids('host','host'),['alice']);assert.deepEqual(n.ids('alice','host'),['alice']);
  } finally {n.close();}
});

test('simultaneous broadcasts keep their rosters isolated and reject forged or stale snapshots',()=>{
  const n=network();try {
    n.watch('alice','host');n.watch('bob','host');n.watch('bob','otherHost');n.flush();
    assert.deepEqual(n.ids('bob','host'),['alice','bob']);assert.deepEqual(n.ids('bob','otherHost'),['bob']);
    const good=n.packets.findLast(p=>p.from==='host'&&p.message.type==='viewers').message;
    n.deliver('otherHost','bob',good);n.deliver('alice','bob',{...good,viewers:['bob']});
    n.deliver('host','bob',{...good,revision:0,viewers:['bob']});
    n.deliver('host','bob',{...good,sid:'old-broadcast',viewers:['bob']});
    n.deliver('host','bob',{...good,viewers:['x'.repeat(16000),'bob']});
    assert.deepEqual(n.ids('bob','host'),['alice','bob']);assert.deepEqual(n.ids('bob','otherHost'),['bob']);
  } finally {n.close();}
});

test('new track SIDs and reconnects discard cached rosters until a fresh publisher response arrives',()=>{
  const n=network();try {
    n.watch('alice','host');n.flush();const old=n.packets.findLast(p=>p.message.type==='viewers').message;
    const host=n.clients.get('host'),alice=n.clients.get('alice');
    host.room.localParticipant.publication.trackSid='host-two';host.room.emit(RoomEvent.LocalTrackPublished);
    for(const c of n.clients.values())if(c.pubs.has('host')){c.pubs.get('host').trackSid='host-two';c.room.emit(RoomEvent.TrackPublished);}
    n.deliver('host','alice',old);assert.equal(alice.service.getBroadcast('host').availability,'pending');
    n.flush();assert.deepEqual(n.ids('alice','host'),['alice']);
    alice.store.set({connection:'Reconnecting'});alice.room.emit(RoomEvent.Reconnecting);
    assert.equal(alice.service.getBroadcast('host').availability,'pending');assert.equal(alice.service.remoteLists.size,0);
    alice.store.set({connection:'Connected'});alice.room.emit(RoomEvent.Reconnected);n.flush();
    assert.deepEqual(n.ids('alice','host'),['alice']);
  } finally {n.close();}
});

test('missing or expired publisher responses show unknown, not zero, and a heartbeat recovers the list',()=>{
  const n=network();try {
    const host=n.clients.get('host'),alice=n.clients.get('alice'),send=host.service.sendRoster;
    host.service.sendRoster=()=>{};n.watch('alice','host');n.flush();
    assert.match(n.ui('alice','host'),/시청자 확인 중/);assert.doesNotMatch(n.ui('alice','host'),/시청자 0명/);
    n.advance(16000);alice.service.sync(true);n.flush();
    assert.equal(alice.service.getBroadcast('host').availability,'unconfirmed');assert.match(n.ui('alice','host'),/1\.1\.11/);
    host.service.sendRoster=send;alice.service.sync(true);n.flush();assert.deepEqual(n.ids('alice','host'),['alice']);
    n.advance(36000);alice.service.sync(true);assert.equal(alice.service.getBroadcast('host').availability,'unconfirmed');
    assert.doesNotMatch(n.ui('alice','host'),/시청자 0명/);n.flush();assert.deepEqual(n.ids('alice','host'),['alice']);
  } finally {n.close();}
});

test('publisher data permission is required to relay a roster and a permission update restores delivery',()=>{
  const n=network();try {
    const host=n.clients.get('host'),alice=n.clients.get('alice');
    host.room.localParticipant.permissions.canPublishData=false;
    n.watch('alice','host');n.flush();
    assert.deepEqual(n.ids('host','host'),['alice'],'the publisher can receive presence even when it cannot transmit');
    assert.equal(alice.service.getBroadcast('host').availability,'unavailable');assert.doesNotMatch(n.ui('alice','host'),/시청자 0명/);
    host.room.localParticipant.permissions.canPublishData=true;
    for(const c of n.clients.values())c.room.emit(RoomEvent.ParticipantPermissionsChanged);
    n.flush();assert.deepEqual(n.ids('alice','host'),['alice']);assert.equal(alice.service.getBroadcast('host').availability,'available');
  } finally {n.close();}
});

test('legacy watch announcements are included in the roster sent to newer viewers',()=>{
  const n=network();try {
    n.watch('alice','host');n.flush();
    n.deliver('bob','host',{type:'watch',sid:'host-one',watching:true});n.flush();
    assert.deepEqual(n.ids('alice','host'),['alice','bob']);assert.match(n.ui('alice','host'),/시청자 2명/);
    n.deliver('bob','host',{type:'watch',sid:'host-one',watching:false});n.flush();assert.deepEqual(n.ids('alice','host'),['alice']);
  } finally {n.close();}
});
