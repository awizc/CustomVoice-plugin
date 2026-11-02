const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}
function load(code, globals = {}) {
  const context = vm.createContext({ setTimeout, clearTimeout, nativeScreenCaptures: new WeakMap(), ...globals });
  vm.runInContext(code, context);
  return context;
}
const selectionCode = section('function createVoiceSnapshot(', 'var Store =');
const codecCode = section('async function selectScreenCodec(', '// node_modules/zod/');
const playbackCode = section('function bindLocalScreenPreview(', 'var Screen =');
const qualityCode = section('// src/services/screen-quality.ts', '// src/discord/screen-capture.ts');

test('border display preference persists as a boolean and defaults to visible', () => {
  const api=load(qualityCode+section('function loadSettings(', '// src/services/device-errors.ts'), {
    defaults:{shareFps:30,shareQuality:'720p',shareBorder:true,backendUrl:'https://example.test',websocketUrl:'',inputMode:'automatic',sensitivity:0.5},isLegacyBackend:()=>false
  });
  assert.equal(api.loadSettings({}).shareBorder,true);
  assert.equal(api.loadSettings({shareBorder:false}).shareBorder,false);
  assert.equal(api.loadSettings({shareBorder:'false'}).shareBorder,true);
});

test('border toggles save only confirmed settings and cannot update a replaced broadcast', async () => {
  const controls=new WeakMap(),api=load('var Manager=class {'+section('  async changeShareBorder(', '  changeShareQuality(')+'};', {nativeScreenCaptures:controls,Track:{Source:{ScreenShare:'screen'}},DOMException});
  const manager=new api.Manager();let state={sharing:true,settings:{shareBorder:true,shareFps:144}},saved;
  manager.store={get:()=>state,set:update=>{state={...state,...update};}};manager.save=settings=>{saved=settings;};
  const track={mediaStreamTrack:{readyState:'live'}};let current=track;
  const room={localParticipant:{getTrackPublication:()=>({track:current})}};manager.client={mediaRoom:room};
  const control={setBorder:async()=>({borderStatus:'applied'})};controls.set(track.mediaStreamTrack,control);
  await manager.changeShareBorder(false);assert.equal(saved.shareBorder,false);assert.equal(saved.shareFps,144);
  control.setBorder=async()=>{throw Error('permission denied');};
  await assert.rejects(manager.changeShareBorder(true),/permission denied/);assert.equal(state.settings.shareBorder,false);
  let finish;control.setBorder=()=>new Promise(resolve=>{finish=resolve;});
  const work=manager.changeShareBorder(true),failed=assert.rejects(work,{name:'AbortError'});
  current={mediaStreamTrack:{readyState:'live'}};finish({borderStatus:'applied'});await failed;
  assert.equal(state.settings.shareBorder,false);
  const result=await manager.changeShareBorder(true);assert.equal(result.restartRequired,true);assert.equal(state.settings.shareBorder,true);
});

test('high FPS profiles have finite budgets, preserve old profiles and survive settings reload', () => {
  const api = load(qualityCode + section('function loadSettings(', '// src/services/device-errors.ts'), {
    defaults: { shareFps: 30, shareQuality: '720p', backendUrl: 'https://example.test', websocketUrl: '', inputMode: 'automatic', sensitivity: 0.5 },
    isLegacyBackend: () => false
  });
  for (const fps of [15, 30, 60, 90, 120, 144, 165]) {
    assert.equal(api.loadSettings({ shareFps: fps }).shareFps, fps);
    for (const quality of ['720p', '1080p', '1440p', 'source']) {
      const p = api.screenProfile(quality, fps, { width: 3840, height: 2160 });
      assert.ok(Number.isFinite(p.bitrate) && p.bitrate > 0);
      assert.equal(p.publish.screenShareEncoding.maxFramerate, fps);
      assert.equal(p.publish.degradationPreference, fps >= 60 ? 'maintain-framerate' : 'maintain-resolution');
      assert.equal(p.publish.simulcast, false);
    }
  }
  assert.equal(api.screenProfile('1080p', 60).bitrate, 10e6);
  assert.equal(api.screenProfile('1080p', 165).bitrate, 27.5e6);
  assert.equal(api.loadSettings({ shareFps: 999 }).shareFps, 30);
  assert.throws(() => api.screenProfile('720p', NaN));
});

test('native capture ceilings do not fail high FPS sharing or lower the chosen resolution', async () => {
  let settings = { width: 3840, height: 2160, frameRate: 120 }, constraints = {}, calls = 0;
  const capture = {
    getSettings: () => settings, getConstraints: () => constraints,
    getCapabilities: () => ({ resizeMode: ['none', 'crop-and-scale'] }),
    applyConstraints: async c => {
      calls++;
      assert.equal(c.frameRate.exact, undefined, 'A lower native ceiling must remain valid');
      constraints = c;
      settings = { width: c.width.exact, height: c.height.exact, frameRate: Math.min(c.frameRate.ideal, 120) };
    }
  };
  const api = load(qualityCode);
  const profile = await api.fixScreenCapture(capture, '1080p', 165);
  assert.equal(profile.fps, 165);
  assert.equal(profile.captureFps, 120);
  assert.equal(settings.width, 1920);
  assert.equal(settings.height, 1080);
  await api.fixScreenCapture(capture, '1080p', 165);
  assert.equal(calls, 1, 'The adapter and publisher must not configure the same track twice');
  await api.fixScreenCapture(capture, 'source', 144);
  assert.equal(settings.width, 3840, 'Changing back to source must recover original dimensions');
  assert.equal(settings.height, 2160);
  assert.equal(constraints.resizeMode.ideal, 'none');
  assert.equal(capture.contentHint, 'motion');
});

test('sender profile stays in sync with the SDK and releases its lock on failure', async () => {
  let locked = false, writes = 0, fail = false;
  let params = { degradationPreference: 'balanced', encodings: [{ active: true, maxFramerate: 30 }] };
  const track = {
    senderLock: { lock: async () => { assert.equal(locked, false); locked = true; return () => { locked = false; }; } },
    sender: { getParameters: () => structuredClone(params), setParameters: async p => {
      assert.equal(locked, true);
      if (fail) throw new Error('Encoder unavailable');
      writes++; params = structuredClone(p);
    } },
    encodings: [{ maxFramerate: 30 }], publishOptions: { videoCodec: 'h264' }
  };
  const api = load(qualityCode);
  const profile = api.screenProfile('1080p', 144);
  await api.configureScreenSender(track, profile);
  assert.equal(locked, false);
  assert.equal(params.encodings[0].maxFramerate, 144);
  assert.equal(params.degradationPreference, 'maintain-framerate');
  assert.equal(track.degradationPreference, 'maintain-framerate');
  assert.equal(params.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(track.encodings[0].maxFramerate, 144);
  assert.equal(track.publishOptions.screenShareEncoding.maxFramerate, 144);
  assert.equal(track.publishOptions.videoCodec, 'h264');
  await api.configureScreenSender(track, profile);
  assert.equal(writes, 1);
  fail = true;
  await assert.rejects(api.configureScreenSender(track, api.screenProfile('1080p', 165)));
  assert.equal(locked, false);
  assert.equal(track.encodings[0].maxFramerate, 144);
});

test('sender settings cannot leak across a replacement while waiting for the SDK lock',async()=>{
  let release,unlocked=false,writes=0;
  const capture={readyState:'live'},sender={getParameters:()=>({encodings:[{}]}),setParameters:async()=>{writes++;}};
  const track={sender,mediaStreamTrack:capture,senderLock:{lock:()=>new Promise(resolve=>{release=()=>resolve(()=>{unlocked=true;});})}};
  const api=load(qualityCode,{DOMException});
  const pending=api.configureScreenSender(track,api.screenProfile('1080p',165));
  const rejected=assert.rejects(pending,{name:'AbortError'});
  track.sender={...sender};release();await rejected;
  assert.equal(unlocked,true);assert.equal(writes,0);assert.equal(track.publishOptions,undefined);
});

test('a changed sender during setParameters cannot commit old profile metadata',async()=>{
  let finish,unlocked=false;
  const params={encodings:[{}]},sender={getParameters:()=>params,setParameters:p=>new Promise(resolve=>{finish=resolve;})};
  const track={sender,mediaStreamTrack:{readyState:'live'},senderLock:{lock:async()=>()=>{unlocked=true;}},publishOptions:{videoCodec:'h264'}};
  const api=load(qualityCode,{DOMException});
  const pending=api.configureScreenSender(track,api.screenProfile('1080p',165));
  const rejected=assert.rejects(pending,{name:'AbortError'});await new Promise(setImmediate);
  track.sender={...sender};finish();await rejected;
  assert.equal(unlocked,true);assert.equal(track.publishOptions.degradationPreference,undefined);
});

test('failed quality changes restore policy only while the original sender still owns the track',async()=>{
  for(const replace of [false,true]){
    let rollback=0,unlocked=0;
    const oldParams={degradationPreference:'maintain-resolution',encodings:[{maxFramerate:30,maxBitrate:4000000,scaleResolutionDownBy:1}]};
    const capture={readyState:'live',getConstraints:()=>({frameRate:30}),applyConstraints:async()=>{rollback++;}};
    const sender={getParameters:()=>structuredClone(oldParams),setParameters:async()=>{rollback++;}};
    const track={kind:'video',mediaStreamTrack:capture,sender,degradationPreference:'maintain-resolution',publishOptions:{old:true},encodings:structuredClone(oldParams.encodings),senderLock:{lock:async()=>()=>{unlocked++;}}};
    const api=load('var Client = class {'+section('  async updateScreenShare(quality, fps) {','  async releaseMedia() {')+'};',{
      DOMException,Track:{Source:{ScreenShare:'screen'},Kind:{Video:'video'}},
      fixScreenCapture:async()=>({fps:165}),
      configureScreenSender:async()=>{track.degradationPreference='maintain-framerate';track.publishOptions={new:true};if(replace)track.sender={...sender};throw Error('configuration failed');}
    });
    const client=new api.Client();client.room={localParticipant:{getTrackPublication:()=>({track})}};
    await assert.rejects(client.updateScreenShare('1080p',165),/configuration failed/);
    assert.equal(rollback,replace?0:2);
    assert.equal(unlocked,replace?0:1);
    assert.equal(track.degradationPreference,replace?'maintain-framerate':'maintain-resolution');
    assert.equal(track.publishOptions.old,replace?undefined:true);
  }
});

test('screen snapshots and layout listeners ignore unrelated voice activity', () => {
  let state = { speakers: [], mediaRevision: 0, sharing: true };
  const listeners = new Set();
  const store = { get: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const api = load(selectionCode);
  const snapshot = api.createVoiceSnapshot(store, ['mediaRevision', 'sharing']);
  const original = snapshot();
  let changes = 0;
  const off = api.watchVoiceState(store, ['sharing'], () => changes++);
  state = { ...state, speakers: ['another participant'] };
  listeners.forEach(fn => fn());
  assert.equal(snapshot(), original);
  assert.equal(changes, 0);
  state = { ...state, mediaRevision: 1 };
  assert.notEqual(snapshot(), original);
  state = { ...state, sharing: false };
  listeners.forEach(fn => fn());
  assert.equal(changes, 1);
  off();
  assert.equal(listeners.size, 0);
});

test('codec ranking prefers smooth software over an overloaded hardware path', async () => {
  const api = load(codecCode, {
    RTCRtpSender: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/VP8' }] }) },
    navigator: { mediaCapabilities: { encodingInfo: async ({ video }) => ({
      supported: true, smooth: video.contentType === 'video/vp8', powerEfficient: video.contentType === 'video/h264'
    }) } }
  });
  assert.equal(await api.selectScreenCodec(1920, 1080, 60, 10e6), 'vp8');
  api.navigator.mediaCapabilities.encodingInfo = async ({ video }) => ({ supported: true, smooth: true, powerEfficient: video.contentType === 'video/h264' });
  assert.equal(await api.selectScreenCodec(1920, 1080, 60, 10e6), 'h264');
  api.navigator.mediaCapabilities.encodingInfo = async ({ video }) => ({ supported: video.contentType === 'video/vp8', smooth: true, powerEfficient: true });
  assert.equal(await api.selectScreenCodec(1920, 1080, 60, 10e6), 'vp8');
});

test('codec capability probes run concurrently and tolerate unavailable APIs', async () => {
  const pending = [];
  const api = load(codecCode, { navigator: { mediaCapabilities: { encodingInfo: () => new Promise(resolve => pending.push(resolve)) } } });
  const result = api.selectScreenCodec(1920, 1080, 60, 10e6);
  assert.equal(pending.length, 2);
  pending.forEach(resolve => resolve({ supported: true, smooth: true, powerEfficient: false }));
  assert.equal(await result, 'h264');
  api.navigator.mediaCapabilities = undefined;
  assert.equal(await api.selectScreenCodec(1920, 1080, 60, 10e6), 'h264');
});

test('hardware H264 profiles are preferred before SDP negotiation without removing compatible fallbacks or repair', async () => {
  const caps = [
    {mimeType:'video/H264',sdpFmtpLine:'packetization-mode=1;profile-level-id=42e01f'},
    {mimeType:'video/H264',sdpFmtpLine:'packetization-mode=1;profile-level-id=42001f'},
    {mimeType:'video/VP8'}, {mimeType:'video/rtx'}, {mimeType:'video/red'}
  ];
  const api = load(codecCode, {customVoiceLog(){},RTCRtpSender:{getCapabilities:()=>({codecs:caps})},navigator:{mediaCapabilities:{encodingInfo:async({video})=>({supported:true,smooth:true,powerEfficient:video.contentType.includes('42001f')})}}});
  const track = {}, chosen = await api.selectScreenCodec(1920,1080,144,24e6,track,[{mime:'video/H264'}]);
  assert.equal(chosen,'h264');
  let preferences;
  api.applyScreenCodecPreferences({setCodecPreferences:value=>preferences=value},track,chosen);
  assert.equal(preferences[0],caps[1]); assert.equal(preferences[1],caps[0]);
  assert.ok(preferences.includes(caps[3])); assert.ok(preferences.includes(caps[4]));
  assert.ok(!preferences.includes(caps[2]));
  assert.equal(await api.selectScreenCodec(1920,1080,144,24e6,{},[{mime:'video/VP8'}]),'vp8');
});

test('reported transmission FPS uses sent frames while encoder cost uses encoded frames', () => {
  const api=load(playbackCode);
  const report=new Map([['out',{id:'out',type:'outbound-rtp',kind:'video',framesEncoded:220,framesSent:180,totalEncodeTime:1.2,timestamp:2000}]]);
  const stats=api.readScreenStats(report,{id:'out',frames:100,sentFrames:100,time:0.6,timestamp:1000},true);
  assert.equal(stats.fps,80); assert.equal(stats.encodeFps,120); assert.equal(stats.processingMs,5);
});

test('FPS window uses one background monitor and releases windows, timers and subscriptions after sharing', () => {
  let state={sharing:true,sessionChannel:{id:'call'},settings:{shareFps:144}}, changed, off=0, monitors=0, stopped=0;
  const windows=[], timers=new Set(), nativeCalls=[];
  const track={}, manager={store:{get:()=>state},client:{mediaRoom:{localParticipant:{getTrackPublication:()=>({track})}}}};
  const api=load(section('// src/components/screen-hud.ts','// src/components/share-quality.tsx'),{
    Track:{Source:{ScreenShare:'screen'}},URL,location:{href:'https://discord.com/channels/@me'},
    watchVoiceState:(_store,_keys,cb)=>{changed=cb;return()=>off++;},
    watchScreenStats:(_track,_local,doc,_cb,interval)=>{assert.equal(doc.hidden,false);assert.equal(interval,1000);monitors++;return()=>stopped++;},
    window:{screen:{},open:(_url,key,features)=>{assert.ok(key.startsWith('DISCORD_'));assert.match(features,/alwaysOnTop=yes/);const child={closed:false,location:{pathname:'/popout'},document:{readyState:'loading'},removeEventListener(){},close(){this.closed=true;}};windows.push(child);return child;}},
    DiscordNative:{window:{setAlwaysOnTop:(...args)=>nativeCalls.push(args),setWindowContentProtection(){},showInactive(){}}},
    BdApi:{Data:{load(){},save(){}},UI:{showToast(){assert.fail('Opening the display must succeed');}}},customVoiceLog(){},
    setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn)
  });
  const hud=new api.ScreenHUD(manager);
  assert.equal(monitors,1); assert.equal(windows.length,1); assert.equal(nativeCalls.length,1);
  hud.close(); assert.equal(stopped,0,'Closing the HUD must not stop encoding feedback');
  hud.open(); assert.equal(monitors,1); assert.equal(windows.length,2);
  state={...state,sharing:false}; changed();
  assert.equal(stopped,1); assert.equal(timers.size,0); assert.ok(windows.every(w=>w.closed));
  hud.dispose(); assert.equal(off,1);
});

test('hidden local preview detaches and resumes without changing the published track', () => {
  let observerCallback, disconnected = false;
  const events = new Map();
  const doc = {
    hidden: true,
    defaultView: { IntersectionObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    } },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name)
  };
  let attached = 0, detached = 0, played = 0;
  const element = { ownerDocument: doc, pause() {}, srcObject: null };
  const media = { enabled: true, readyState: 'live', stop() { assert.fail('Published capture must stay live'); } };
  const track = { mediaStreamTrack: media, attach() { attached++; element.srcObject = media; }, detach() { detached++; }, stop() { assert.fail('Must not stop sending'); } };
  const api = load(playbackCode);
  const cleanup = api.bindLocalScreenPreview(track, element, () => played++);
  assert.equal(attached, 0);
  doc.hidden = false;
  events.get('visibilitychange')();
  assert.equal(attached, 1);
  observerCallback([{ target: element, isIntersecting: false }]);
  assert.equal(detached, 1);
  assert.equal(element.srcObject, null);
  observerCallback([{ target: element, isIntersecting: true }]);
  assert.equal(attached, 2);
  assert.equal(played, 2);
  cleanup();
  observerCallback([{ target: element, isIntersecting: true }]);
  assert.equal(attached, 2);
  assert.equal(detached, 2);
  assert.equal(media.enabled, true);
  assert.equal(media.readyState, 'live');
  assert.equal(disconnected, true);
  assert.equal(events.size, 0);
});

test('FPS and processing time come from counter deltas, including resets and idle video', () => {
  const api = load(playbackCode);
  const report = (frames, time, timestamp) => new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', framesEncoded: frames, totalEncodeTime: time, timestamp, codecId: 'codec', qualityLimitationReason: 'cpu' }],
    ['codec', { mimeType: 'video/H264' }]
  ]);
  const first = api.readScreenStats(report(100, 0.5, 1000), undefined, true);
  assert.equal(first.fps, undefined, 'No configured FPS should masquerade as measured FPS');
  assert.equal(first.intervalMs, undefined);
  const second = api.readScreenStats(report(180, 0.9, 3000), first.sample, true);
  assert.equal(second.fps, 40);
  assert.equal(second.intervalMs, 2000, 'Cadence rounding uses the actual counter interval');
  assert.ok(Math.abs(second.processingMs - 5) < 0.001);
  assert.equal(second.codec, 'H264');
  assert.equal(second.limitation, 'cpu');
  assert.equal(api.readScreenStats(report(180, 0.9, 5000), second.sample, true).fps, 0);
  assert.equal(api.readScreenStats(report(1, 0.01, 6000), second.sample, true).fps, undefined);
  assert.equal(api.readScreenStats(report(1, 0.01, 6000), second.sample, true).intervalMs, undefined);
  const received = new Map([['remote', { id: 'remote', type: 'inbound-rtp', kind: 'video', framesDecoded: 60, totalDecodeTime: 0.12, timestamp: 2000 }]]);
  assert.equal(api.readScreenStats(received, { id: 'remote', frames: 0, time: 0, timestamp: 1000 }, false).fps, 60);
  const captureReport = report(420, 2, 5000);
  captureReport.get('video').mediaSourceId = 'source';
  captureReport.set('source', { id: 'source', type: 'media-source', frames: 600, timestamp: 5000 });
  const measured = api.readScreenStats(captureReport, { ...second.sample, source: { id: 'source', frames: 300, timestamp: 3000 } }, true);
  assert.equal(measured.captureFps, 150);
  assert.equal(measured.fps, 120);
});

test('network and encoder telemetry use deltas and reject reset counters',()=>{
  const api=load(playbackCode);
  const report=(timestamp,frames,bytes,packets,sendDelay,cpu,bandwidth)=>new Map([['out',{id:'out',type:'outbound-rtp',kind:'video',timestamp,framesEncoded:frames,framesSent:frames,bytesSent:bytes,packetsSent:packets,totalPacketSendDelay:sendDelay,qualityLimitationDurations:{cpu,bandwidth},frameWidth:1920,frameHeight:1080,targetBitrate:18000000,qualityLimitationResolutionChanges:2}]]);
  const first=api.readScreenStats(report(1000,100,1000000,100,5,10,1),undefined,true);
  const next=api.readScreenStats(report(3000,300,3000000,200,15,11,1.6),first.sample,true);
  assert.equal(next.sendBitrate,8000000);assert.equal(next.packetSendDelayMs,100);
  assert.equal(next.cpuFraction,.5);assert.ok(Math.abs(next.bandwidthFraction-.3)<1e-6);
  assert.equal(next.networkLimited,true);assert.equal(next.width,1920);assert.equal(next.height,1080);
  assert.equal(next.resolutionChanges,2);
  const reset=api.readScreenStats(report(4000,301,0,0,0,0,0),next.sample,true);
  assert.equal(reset.sendBitrate,undefined);assert.equal(reset.packetSendDelayMs,undefined);assert.equal(reset.cpuFraction,undefined);assert.equal(reset.networkLimited,false);
});

test('a stats response from a replaced sender cannot adjust the new broadcast',async()=>{
  let finish,next;
  const api=load(playbackCode,{setTimeout:fn=>{next=fn;return 1;},clearTimeout(){}});
  const track={sender:{getStats:()=>new Promise(resolve=>{finish=resolve;})}};
  let updates=0;const off=api.watchScreenStats(track,true,{hidden:false},()=>updates++);
  track.sender={getStats:async()=>new Map()};finish(new Map());await new Promise(setImmediate);
  assert.equal(updates,0);assert.equal(typeof next,'function');off();
});

test('stats polling never overlaps and a pending result is ignored after cleanup', async () => {
  let resolve, calls = 0;
  const scheduled = new Map();
  const api = load(playbackCode, {
    setTimeout: fn => { const id = scheduled.size + 1; scheduled.set(id, fn); return id; },
    clearTimeout: id => scheduled.delete(id)
  });
  const track = { sender: { getStats: () => { calls++; return new Promise(done => { resolve = done; }); } } };
  let updates = 0;
  const cleanup = api.watchScreenStats(track, true, { hidden: false }, () => updates++);
  assert.equal(calls, 1);
  assert.equal(scheduled.size, 0);
  cleanup();
  resolve(new Map());
  await new Promise(setImmediate);
  assert.equal(updates, 0);
  assert.equal(scheduled.size, 0);
});

test('hidden documents skip stats collection until visible', async () => {
  let next, calls = 0;
  const api = load(playbackCode, { setTimeout: fn => { next = fn; return 1; }, clearTimeout() {} });
  const doc = { hidden: true };
  const cleanup = api.watchScreenStats({ sender: { getStats: async () => { calls++; return new Map(); } } }, true, doc, () => {});
  assert.equal(calls, 0);
  doc.hidden = false;
  await next();
  assert.equal(calls, 1);
  cleanup();
});

test('main view and popout share one stats poll and stop it after the last viewer leaves', async () => {
  const scheduled = new Map();
  let calls = 0, first = 0, second = 0;
  const api = load(playbackCode, {
    setTimeout: fn => { scheduled.set(1, fn); return 1; }, clearTimeout: id => scheduled.delete(id)
  });
  const track = { sender: { getStats: async () => { calls++; return new Map(); } } };
  const doc = { hidden: false };
  const off1 = api.watchScreenStats(track, true, doc, () => first++);
  const off2 = api.watchScreenStats(track, true, doc, () => second++);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(first, 1);
  assert.equal(second, 1);
  off1();
  await scheduled.get(1)();
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(calls, 2);
  off2();
  assert.equal(scheduled.size, 0);
});

test('DOM placement checks render once per mount and remount on parent changes', () => {
  let renders = 0, unmounts = 0;
  const parent = () => ({ append(host) { host.isConnected = true; }, matches: () => false });
  let target = parent();
  const api = load(section('var MountAdapter =', 'var DiscordIntegration ='), {
    document: { createElement: () => ({ dataset: {}, isConnected: false, remove() { this.isConnected = false; } }) }
  });
  const adapter = new api.MountAdapter({ api: { ReactDOM: { createRoot: () => ({ render() { renders++; }, unmount() { unmounts++; } }) } } }, 'test', () => target, () => ({}));
  adapter.sync();
  adapter.sync();
  assert.equal(renders, 1);
  target = parent();
  adapter.sync();
  assert.equal(renders, 2);
  assert.equal(unmounts, 1);
  adapter.sync(false);
  assert.equal(unmounts, 2);
});

test('receiver freeze and jitter counters use deltas and reset with the track',()=>{
 const api=load(playbackCode);
 const report=(id,timestamp,framesDecoded,freezeCount,totalFreezesDuration,jitterBufferDelay,jitterBufferEmittedCount)=>new Map([[id,{id,type:'inbound-rtp',kind:'video',timestamp,framesDecoded,freezeCount,totalFreezesDuration,jitterBufferDelay,jitterBufferEmittedCount}]]);
 const first=api.readScreenStats(report('a',1000,60,1,.5,2,60),undefined,false);
 const next=api.readScreenStats(report('a',3000,180,3,1.5,8,180),first.sample,false);
 assert.equal(next.freezes,2);assert.equal(next.freezeDuration,1);assert.equal(next.jitterBufferMs,50);
 const reset=api.readScreenStats(report('b',4000,0,0,0,0,0),next.sample,false);
 assert.equal(reset.freezes,undefined);assert.equal(reset.jitterBufferMs,undefined);
});
