const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const native = path.join(__dirname, '../native');

function rendererHarness({ delayedStart = false, writeFrame, nativePacing = false, clock, borderControl = false, setBorder } = {}) {
  let listener, resolveStart, stopped = 0, writes = 0, frameClosed = 0;
  const info = { session: 'session-one', width: 1920, height: 1080, fps: 144, adaptivePacing: nativePacing, hostAdaptivePacing: nativePacing, borderControl, hostBorderControl: borderControl };
  const paces = [];
  class Generator extends EventTarget {
    constructor() { super(); this.writable = { getWriter: () => ({ write: async frame => { writes++; await writeFrame?.(frame); }, abort: async () => {} }) }; }
    stop() {}
    getSettings() { return {}; }
  }
  const bridge = { protocol: 2, available: true,
    start: async () => delayedStart ? new Promise(resolve => { resolveStart = resolve; }) : info,
    activate: async () => emit('customvoice-native-frame-v2', { frame: { close: () => frameClosed++ } }),
    configure: async (_id, fps) => ({ fps, width: 1280, height: 720 }),
    pace: (_id, fps) => paces.push(fps),
    setBorder: (_id, visible) => setBorder ? setBorder(visible) : Promise.resolve({borderStatus:'applied',borderVisible:visible}),
    stop: async () => { stopped++; }
  };
  const window = { addEventListener: (_type, fn) => { listener = fn; }, removeEventListener: () => { listener = null; } };
  const emit = (type, extra) => listener?.({ source: window, origin: 'https://discord.com', data: { type, session: info.session, ...extra } });
  const context = vm.createContext({ module: { exports: {} }, window, location: { origin: 'https://discord.com', protocol: 'https:' }, CustomVoiceNative: bridge,
    Event, DOMException, MediaStreamTrackGenerator: Generator,
    setTimeout: clock?.setTimeout ?? setTimeout, clearTimeout: clock?.clearTimeout ?? clearTimeout,
    ...(clock ? { performance: { now: () => clock.time } } : {}),
    require: name => assert.fail(`BetterDiscord cannot provide this Node module: ${name}`)
  });
  vm.runInContext(fs.readFileSync(path.join(native, 'capture.js'), 'utf8'), context);
  const abort = new AbortController();
  return { context, api: context.module.exports, start: (showBorder = true) => context.module.exports.start('screen:0:0',144,'1080p',abort.signal,showBorder), emit, abort, paces,
    finishStart: () => resolveStart(info), get stopped() { return stopped; }, get writes() { return writes; }, get frameClosed() { return frameClosed; }
  };
}

test('renderer adapter starts and configures without Node APIs; failures end and clean up the track', async () => {
  const h = rendererHarness(), control = await h.start();
  assert.equal(h.writes, 1); assert.equal(h.frameClosed, 1);
  assert.equal(control.track.getSettings().frameRate, 144);
  h.emit('customvoice-native-status-v2', { event: 'stats', captured: 120, frames: 280, repeated: 160, dropped: 8, elapsedMs: 2000 });
  h.emit('customvoice-native-status-v2', { event: 'stats', captured: 240, frames: 560, repeated: 320, dropped: 16, elapsedMs: 4000 });
  assert.equal(control.diagnostics.sourceFps, 60);
  assert.equal(control.diagnostics.outputFps, 140);
  assert.equal(control.diagnostics.repeatedFps, 80);
  assert.equal(control.diagnostics.backpressureFps, 4);
  await control.configure('720p', 120);
  assert.equal(control.track.getSettings().frameRate, 120);
  let ended = 0; control.track.addEventListener('ended', () => ended++);
  h.emit('customvoice-native-status-v2', { event: 'error', message: 'GPU device removed' });
  assert.equal(ended, 1); assert.equal(h.stopped, 1);
  control.stop(); assert.equal(h.stopped, 1);
});

test('cancelling while native startup is pending also stops the late-created helper', async () => {
  const h = rendererHarness({ delayedStart: true });
  const pending = h.start(); h.abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  h.finishStart(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.stopped, 1); assert.equal(h.writes, 0);
});

test('game capture mode labels and live source state cross the renderer bridge', async () => {
  const h = rendererHarness(), control = await h.start();
  h.emit('customvoice-native-status-v2', { event: 'source-state', sourceAvailable: false, holdingFrame: true });
  for (const backend of ['GAME-HOOK-D3D11', 'GAME-HOOK-MEMORY']) {
    h.emit('customvoice-native-status-v2', { event: 'capture-mode', backend, sourceAvailable: true, holdingFrame: false });
    assert.match(control.backend, /게임 캡처/);
    assert.equal(control.metadata.sourceAvailable, true);
    assert.equal(control.metadata.holdingFrame, false);
  }
  assert.match(control.backend, /호환 모드/);
  control.stop();
});

test('border permission never blocks initial frames; denial and old hosts do not stop sharing', async () => {
  let finish;const h=rendererHarness({borderControl:true,setBorder:()=>new Promise(resolve=>{finish=resolve;})});
  const control=await h.start(false);
  assert.equal(h.writes,1,'The first frame must arrive before border permission resolves');
  h.emit('customvoice-native-frame-v2',{frame:{close(){}}});await new Promise(setImmediate);
  assert.equal(h.writes,2);
  finish({borderStatus:'denied',borderVisible:true,message:'permission denied'});await new Promise(setImmediate);
  assert.equal(h.stopped,0);control.stop();
  const legacy=rendererHarness(),old=await legacy.start();
  await assert.rejects(old.setBorder(false),/Discord/);assert.equal(legacy.stopped,0);old.stop();
});

test('live border toggle reflects confirmed state and rejects a result after capture ends', async () => {
  const h=rendererHarness({borderControl:true}),control=await h.start();
  await control.setBorder(false);assert.equal(control.metadata.borderVisible,false);
  await control.setBorder(true);assert.equal(control.metadata.borderVisible,true);control.stop();
  let finish;const delayed=rendererHarness({borderControl:true,setBorder:()=>new Promise(resolve=>{finish=resolve;})});
  const session=await delayed.start();const change=session.setBorder(false),failed=assert.rejects(change,{name:'AbortError'});
  session.stop();finish({borderStatus:'applied',borderVisible:false});await failed;
});

test('a busy writer retains only the newest changed frame and closes queued textures on stop', async () => {
  let finish; const written = [], closed = [];
  const h = rendererHarness({writeFrame: frame => { if (!frame.id) return; written.push(frame.id); return new Promise(resolve => { finish = resolve; }); }});
  const control = await h.start();
  const send = (id, revision) => h.emit('customvoice-native-frame-v2', {revision,frame:{id,close:()=>closed.push(id)}});
  send('first',1); send('repeat',1); send('stale',2); send('newest',3);
  assert.deepEqual(closed,['repeat','stale']);
  assert.deepEqual(written,['first']);
  finish(); await new Promise(setImmediate);
  assert.deepEqual(written,['first','newest']);
  send('queued',4); control.stop();
  assert.ok(closed.includes('queued'));
  finish(); await new Promise(setImmediate);
  assert.equal(closed.length,5); assert.equal(new Set(closed).size,5);
});

test('old hosts pace fresh and repeated frames evenly with one latest frame and clean timers on stop', async () => {
  let id = 0; const timers = new Map();
  const clock = { time: 0,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, due: clock.time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    advance: time => { clock.time = time; for (const [key, timer] of [...timers]) if (timer.due <= time) { timers.delete(key); timer.fn(); } }
  };
  const h = rendererHarness({ clock }), control = await h.start();
  const slow = { encodeFps: 30, captureFps: 144, processingMs: 25 };
  control.updateEncoderStats(slow); control.updateEncoderStats(slow);
  assert.equal(control.diagnostics.pacingFps, 33);
  const closed = [];
  const send = (id, revision) => h.emit('customvoice-native-frame-v2',{revision,frame:{close:()=>closed.push(id)}});
  send(1,1); send(2,2); send(3,3);
  assert.equal(h.writes,1); assert.deepEqual(closed,[1,2]); assert.equal(timers.size,1);
  clock.advance(31); await new Promise(setImmediate);
  assert.equal(h.writes,2);
  clock.advance(62); send(4,3); await new Promise(setImmediate);
  assert.equal(h.writes,3,'Repeated content must not be held for 200ms');
  send(5,4); control.stop();
  assert.equal(timers.size,0); assert.deepEqual(closed,[1,2,3,4,5]);
});

test('native pacing feedback changes effective cadence without changing the requested profile', async () => {
  const h = rendererHarness({ nativePacing: true }), control = await h.start();
  const slow = { encodeFps: 30, captureFps: 144, processingMs: 25 };
  control.updateEncoderStats(slow); control.updateEncoderStats(slow);
  assert.deepEqual(h.paces,[144,33]);
  assert.equal(control.track.getSettings().frameRate,144);
  assert.equal(control.diagnostics.nativePacing,true);
  await control.configure('720p',120);
  assert.equal(control.diagnostics.pacingFps,120);
  control.stop(); control.updateEncoderStats(slow); assert.equal(h.paces.length,2);
});

test('cadence ignores transient drops and high parallel hardware encode latency, then recovers after sustained pressure', () => {
  const controller = rendererHarness().api.createCadenceController(144);
  const healthy = { encodeFps:144,captureFps:144,processingMs:10,powerEfficientEncoder:true };
  const slow = { encodeFps:30,captureFps:144,processingMs:25 };
  controller.update(slow); controller.update(healthy);
  for (let i=0;i<6;i++) assert.equal(controller.update(healthy),144);
  controller.update(slow); assert.equal(controller.update(slow),33);
  // Healthy HW pipelines can encode in parallel: cost alone must not prevent recovery.
  for (let i=0;i<25;i++) controller.update({encodeFps:controller.fps,captureFps:controller.fps,processingMs:40,powerEfficientEncoder:true});
  assert.equal(controller.fps,144);
  const duplicate = { ...slow, sample:{timestamp:1} };
  controller.update(duplicate); controller.update(duplicate); assert.equal(controller.fps,144);
  controller.update({...slow,sample:{timestamp:2}}); assert.equal(controller.fps,33);
});

test('Alt-Tab source waits cannot collapse cadence, and return-to-game skips stale zero-FPS samples', () => {
  const cadence=rendererHarness().api.createCadenceController(165);
  const stalled={encodeFps:0,captureFps:0,limitation:'none'};
  // Before the fix, missing input was reported as dropped/backpressured output.
  for(let i=0;i<12;i++)assert.equal(cadence.update(stalled,{sourceAvailable:false,backpressureFps:165,outputFps:0}),165);
  cadence.recover();
  for(let i=0;i<2;i++)assert.equal(cadence.update(stalled,{sourceAvailable:true,backpressureFps:165}),165);
  assert.equal(cadence.update({encodeFps:165,captureFps:165,processingMs:2},{sourceAvailable:true}),165);
  // Real sustained encoder pressure must still throttle, then recover again.
  const overloaded={encodeFps:30,captureFps:165,processingMs:40};
  cadence.update(overloaded,{sourceAvailable:true});cadence.update(overloaded,{sourceAvailable:true});assert.ok(cadence.fps<165);
  cadence.recover();assert.equal(cadence.fps,165);
});

test('zero encoded frames with genuine backpressure back off gradually instead of jumping straight to 1 FPS',()=>{
  const cadence=rendererHarness().api.createCadenceController(165);
  const stats={encodeFps:0,captureFps:0},native={sourceAvailable:true,backpressureFps:165};
  cadence.update(stats,native);assert.equal(cadence.update(stats,native),82.5);
});

test('mode and source recovery immediately restore native pace and state also arrives with frames',async()=>{
  const h=rendererHarness({nativePacing:true}),control=await h.start();
  const slow={encodeFps:30,captureFps:144,processingMs:25};
  control.updateEncoderStats(slow);control.updateEncoderStats(slow);assert.equal(control.diagnostics.pacingFps,33);
  h.emit('customvoice-native-status-v2',{event:'capture-mode',backend:'WGC-D3D11',sourceAvailable:false});
  assert.equal(control.diagnostics.pacingFps,144);assert.equal(h.paces.at(-1),144);
  for(let i=0;i<6;i++)control.updateEncoderStats({encodeFps:0,captureFps:0});
  assert.equal(control.diagnostics.pacingFps,144);assert.equal(control.diagnostics.sourceAvailable,false);
  h.emit('customvoice-native-frame-v2',{sourceAvailable:true,frame:{close(){}}});
  assert.equal(control.diagnostics.sourceAvailable,true);assert.equal(h.paces.at(-1),144);
  control.updateEncoderStats(slow);control.updateEncoderStats(slow);assert.equal(control.diagnostics.pacingFps,144);
  control.updateEncoderStats(slow);control.updateEncoderStats(slow);assert.equal(control.diagnostics.pacingFps,33);
  h.emit('customvoice-native-status-v2',{event:'resized',width:1920,height:1080});
  assert.equal(control.diagnostics.pacingFps,144);
  await new Promise(setImmediate);control.stop();
});

test('held-frame diagnostics follow frames even when source availability does not change',async()=>{
  const h=rendererHarness({nativePacing:true}),control=await h.start();
  h.emit('customvoice-native-status-v2',{event:'source-state',sourceAvailable:false,holdingFrame:false});
  h.emit('customvoice-native-frame-v2',{sourceAvailable:false,holdingFrame:true,frame:{close(){}}});
  assert.equal(control.diagnostics.holdingFrame,true);assert.equal(control.diagnostics.sourceAvailable,false);
  h.emit('customvoice-native-frame-v2',{sourceAvailable:true,holdingFrame:false,frame:{close(){}}});
  assert.equal(control.diagnostics.holdingFrame,false);assert.equal(control.diagnostics.sourceAvailable,true);
  await new Promise(setImmediate);control.stop();
});

test('cadence handles a stalled encoder, low source cadence, and GPU backpressure without an encode-time sample', () => {
  const controller = rendererHarness().api.createCadenceController(144);
  for(let i=0;i<4;i++) controller.update({encodeFps:30,captureFps:30,processingMs:1});
  assert.equal(controller.fps,144,'A quiet source is not encoder overload');
  controller.update({encodeFps:30,captureFps:30},{backpressureFps:90});
  assert.equal(controller.update({encodeFps:30,captureFps:30},{backpressureFps:90}),33);
  for(let i=0;i<30;i++) controller.update({encodeFps:0,captureFps:10});
  assert.equal(controller.fps,1);
  assert.equal(controller.update({}),1);
});

test('sustained capture work overload backs off even when the hardware encoder is healthy, then recovers', () => {
  const controller = rendererHarness().api.createCadenceController(144);
  const stats = {encodeFps:85,captureFps:85,processingMs:1,powerEfficientEncoder:true};
  const busy = {outputFps:85,outputOverrunFps:85,outputWorkMs:11};
  assert.equal(controller.update(stats,{...busy,outputOverrunFps:1}),144,'One slow native frame is not sustained overload');
  assert.equal(controller.update(stats,busy),144);
  assert.ok(controller.update(stats,busy)<90);
  const reduced=controller.fps;
  for(let i=0;i<5;i++) controller.update({...stats,encodeFps:reduced,captureFps:reduced},{outputFps:reduced,outputOverrunFps:0,outputWorkMs:11});
  assert.equal(controller.fps,reduced,'Recovery requires native work headroom too');
  for(let i=0;i<25;i++) controller.update({...stats,encodeFps:controller.fps,captureFps:controller.fps},{outputFps:controller.fps,outputOverrunFps:0,outputWorkMs:3});
  assert.equal(controller.fps,144);
});

test('recent handoff statistics expire startup gaps and distinguish an outstanding writer from a delivered frame', async () => {
  const clock={time:0};let finish;
  const h=rendererHarness({clock,nativePacing:true,writeFrame:frame=>frame.slow?new Promise(resolve=>{finish=resolve;}):undefined});
  const control=await h.start();
  clock.time=400;h.emit('customvoice-native-frame-v2',{revision:1,frame:{close(){}}});await new Promise(setImmediate);
  assert.equal(control.diagnostics.handoffMaxGapMs,400);assert.equal(control.diagnostics.handoffLateCount,1);
  clock.time=410;h.emit('customvoice-native-frame-v2',{revision:2,frame:{slow:true,close(){}}});
  clock.time=810;
  assert.equal(control.diagnostics.writerPendingMs,400);assert.equal(control.diagnostics.handoffAgeMs,410);
  assert.equal(control.diagnostics.handoffSamples,1,'Starting a write is not a completed handoff');
  finish();await new Promise(setImmediate);
  assert.equal(control.diagnostics.handoffMaxGapMs,410);assert.equal(control.diagnostics.writerPendingMs,0);
  clock.time=11000;
  assert.equal(control.diagnostics.handoffMaxGapMs,undefined);assert.equal(control.diagnostics.handoffLateCount,0);
  assert.equal(control.diagnostics.handoffAgeMs,10190,'A continuing stall stays visible even when previous gaps expire');
  control.stop();assert.equal(control.diagnostics.handoffAgeMs,undefined);
  const window=h.context.createHandoffWindow();window.record(100,100,144);window.record(10100,7,144);
  assert.equal(window.snapshot(10100).handoffMaxGapMs,7);
});

test('native work counters are averaged per attempt and stale telemetry cannot reduce cadence', async () => {
  const clock={time:0},h=rendererHarness({clock,nativePacing:true}),control=await h.start();
  h.emit('customvoice-native-status-v2',{event:'stats',frames:180,outputAttempts:180,outputOverruns:180,outputWorkUs:1980000,elapsedMs:2000});
  h.emit('customvoice-native-status-v2',{event:'stats',frames:360,outputAttempts:360,outputOverruns:360,outputWorkUs:3960000,elapsedMs:4000});
  assert.equal(control.diagnostics.outputWorkMs,11);assert.equal(control.diagnostics.outputOverrunFps,90);
  clock.time=7000;
  const healthy={encodeFps:90,captureFps:90,processingMs:1,powerEfficientEncoder:true};
  control.updateEncoderStats(healthy);control.updateEncoderStats(healthy);
  assert.equal(control.diagnostics.pacingFps,144);assert.equal(control.diagnostics.nativeSampleAgeMs,7000);
  control.stop();
});

test('shipped plugin starts even when BetterDiscord rejects every external module load', async () => {
  const bundle = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'), 'utf8');
  const start = bundle.indexOf('// <CustomVoiceNativeRenderer>'), end = bundle.indexOf('\nfunction unsupported(', start);
  assert.ok(start >= 0 && end > start);
  const h = rendererHarness(), requests = [];
  h.context.nativeScreenCaptures = new WeakMap();
  h.context.require = name => {
    requests.push(name);
    if (name === 'process') return { platform: 'win32' };
    throw new SyntaxError('The options argument must be of type object. Received type string');
  };
  h.context.console = { warn: (...args) => assert.fail(JSON.stringify(args)) };
  vm.runInContext(bundle.slice(start, end), h.context);
  const result = await h.context.tryNativeDesktopCapture('screen:0:0',{ resolution: { frameRate: 144, height: 1080 } },new AbortController().signal);
  assert.equal(result.track.getSettings().frameRate, 144);
  assert.equal(h.writes, 1); assert.equal(h.context.nativeScreenCaptures.get(result.track), result);
  assert.deepEqual(requests, ['process']);
  result.stop(); assert.equal(h.stopped, 1);
});

test('isolated preload retains GPU slots until Chromium releases all transferred frame references', async () => {
  let api, onFrame, gpuReleased, releases = 0; const posted = [];
  const frame = { close() {} };
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { on: (name, fn) => { if (name.endsWith(':frame')) onFrame = fn; }, invoke: async () => ({ session: 'one' }), send: () => releases++ },
    sharedTexture: { subtle: { importSharedTexture: () => ({ getVideoFrame: () => frame, release: fn => { gpuReleased = fn; } }) } }
  };
  const context = vm.createContext({ module: { exports: {} }, Buffer, require: name => { assert.equal(name, 'electron'); return electron; },
    location: { href: 'https://discord.com/channels/@me', origin: 'https://discord.com', protocol: 'https:' }, window: { postMessage: (...args) => posted.push(args) }
  });
  vm.runInContext(fs.readFileSync(path.join(native,'host-preload.cjs'),'utf8'), context); context.module.exports.install();
  await api.start('screen:0:0',144,'1080p');
  onFrame({}, { session:'one',slot:0,sequence:1,handle:'123',width:1920,height:1080,format:'nv12',timestamp:1 });
  assert.equal(releases,0); assert.equal(posted[0][0].frame,frame); assert.equal(posted[0][2][0],frame);
  assert.equal(posted[0][0].handle,undefined);
  gpuReleased(); assert.equal(releases,1);
});

for (const nativeCaptureModule of [{}, { stopAll() { throw new Error('Native cleanup failed'); } }]) {
  test('plugin always closes its voice session after native module loading or cleanup fails', async () => {
    const bundle = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'), 'utf8');
    const context = vm.createContext({ nativeCaptureModule, css: '', customVoiceFeatureCss: '', customVoiceDiscordCss: '', customVoiceLogger: undefined, customVoiceLog() {}, module: { exports: {} }, console: { warn() {} },
      disposeSettingsDialogs() {}, BdApi: { DOM: { removeStyle() {} }, Patcher: { unpatchAll() {} } }
    });
    vm.runInContext(bundle.slice(bundle.lastIndexOf('// src/index.ts')), context);
    const plugin = new context.CustomVoice(); let stopped = false;
    plugin.manager = { stop: async () => { stopped = true; } };
    await plugin.stop(); assert.equal(stopped, true); assert.equal(plugin.manager, undefined);
  });
}
