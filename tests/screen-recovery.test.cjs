const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(recover) {
  let time=0;const calls=[];
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../native/screen-recovery.js'),'utf8'),context);
  const monitor=context.createRemoteScreenRecovery(details=>{calls.push(details);return recover?.(details);},()=>time);
  return {monitor,calls,observe(t,frames,bytes,options){time=t;monitor.observe({sample:{id:'inbound',timestamp:t,frames,bytes}},options);}};
}
const flush=()=>new Promise(setImmediate);
test('receiver detects bytes arriving without decoded frames and coalesces a pending recovery',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  for(let i=0;i<=8;i+=2)f.observe(i*1000,10,1000+i*100);
  await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].reason,'decode-stalled');
  assert.equal(f.calls[0].bytesWhileStalled,800);
  f.observe(25000,10,5000);await flush();assert.equal(f.calls.length,1);
  finish();await flush();
  f.observe(26000,20,6000);f.observe(28000,30,7000);await flush();assert.equal(f.calls.length,1);
});
test('static video without packets, hidden playback and intentional pauses are not treated as decoder failures',async()=>{
  const f=fixture();for(let i=0;i<=20;i+=2)f.observe(i*1000,10,1000);
  await flush();assert.equal(f.calls.length,0);
  for(let i=22;i<=40;i+=2)f.observe(i*1000,10,1000+i*100,{active:false});
  f.observe(41000,10,6000,{active:true});await flush();assert.equal(f.calls.length,0);
});
test('decoded progress with frozen presented frames requests a playback reattachment',async()=>{
  const f=fixture();for(let i=0;i<=8;i+=2)f.observe(i*1000,10+i,1000+i*100,{renderedFrames:5});
  await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].reason,'playback-stalled');
  f.observe(10000,30,5000,{renderedFrames:6});f.observe(12000,40,7000,{renderedFrames:7});
  await flush();assert.equal(f.calls.length,1);
});
test('an initially undecodable stream can recover, but disposing cancels a queued recovery',async()=>{
  const f=fixture();f.observe(0,0,0);f.observe(8000,0,0);await flush();assert.equal(f.calls.length,1);
  const disposed=fixture();disposed.observe(0,0,0);disposed.observe(8000,0,1000);disposed.monitor.dispose();
  await flush();assert.equal(disposed.calls.length,0);
});
test('a stalled muted receiver can recover without mistaking resumed frames for a stall',async()=>{
  const f=fixture();f.observe(0,10,1000);f.observe(8000,10,1000,{muted:true});await flush();assert.equal(f.calls.length,1);
  for(let i=10;i<=30;i+=2)f.observe(i*1000,10+i,1000+i*100,{muted:false});
  await flush();assert.equal(f.calls.length,1);
});
