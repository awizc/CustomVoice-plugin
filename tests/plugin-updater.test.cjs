'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const bundle=fs.readFileSync(path.join(__dirname,'../CustomVoice.plugin.js'),'utf8');
const helpers=bundle.slice(bundle.indexOf('var UPDATE_REPO ='),bundle.indexOf('var PluginUpdater = class {'));
const updater=fs.readFileSync(path.join(__dirname,'../native/plugin-updater.js'),'utf8');
const source=(version='1.1.17',body='module.exports = class {};')=>`/**\n * @name CustomVoice\n * @version ${version}\n */\n${body}`;
function harness({version='1.1.12',active=false,fetch,bridge,files,require:load=require}={}){
  const timers=new Map(),calls=[],toasts=[],writes=[],logs=[];let id=0,text=source(version);
  const api={Net:{fetch:async(url,options)=>{calls.push({url,options});return fetch?fetch(url,options):new Response(source(),{headers:{etag:'"v17"'}});}},UI:{showToast:(message)=>toasts.push(message)}};
  const context=vm.createContext({require:load,AbortController,TextDecoder,Date,Response,CustomVoiceNative:bridge,customVoiceLog:(...args)=>logs.push(args),setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimeout:(key)=>timers.delete(key)});
  vm.runInContext(helpers+updater,context);
  const disk=files??{read:()=>text,replace:(next,previous)=>{assert.equal(previous,text);text=next;writes.push(next);}};
  const instance=new context.PluginUpdater(api,()=>active,disk);instance.start();
  return {context,instance,api,timers,calls,toasts,writes,logs,setActive:v=>{active=v;},text:()=>text};
}
test('1.1.12 updates directly from public GitHub without any native bridge or credentials',async()=>{
  const h=harness();await h.instance.check();
  assert.equal(h.writes.length,1);assert.match(h.text(),/@version 1\.1\.17/);
  assert.equal(h.calls[0].url,'https://raw.githubusercontent.com/awizc/CustomVoice-plugin/main/CustomVoice.plugin.js');
  assert.equal(h.calls[0].options.credentials,'omit');assert.equal(h.calls[0].options.headers.Authorization,undefined);
  assert.equal(h.calls[0].options.redirect,'error');assert.equal(h.instance.updated,true);h.instance.stop();
});
test('downloads while in a call, then applies within 30 seconds without another request',async()=>{
  const h=harness({active:true});await h.instance.check();
  assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);assert.equal(h.timers.get(h.instance.timer).delay,30000);
  await h.instance.check();assert.equal(h.calls.length,1);assert.equal(h.toasts.length,1);
  h.setActive(false);await h.instance.check();assert.equal(h.writes.length,1);assert.equal(h.calls.length,1);h.instance.stop();
});
test('expiring an active-call candidate does not poison its ETag or lose the update',async()=>{
  const h=harness({active:true});await h.instance.check();h.instance.candidate.expires=0;h.setActive(false);await h.instance.check();
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].options.headers['If-None-Match'],undefined);assert.equal(h.writes.length,1);h.instance.stop();
});
test('idle connection errors do not block updates but a real media connection does',()=>{
  const h=harness(),active=h.context.updateCallActive;
  assert.equal(active({connection:'Error'},null),false);assert.equal(active(undefined,undefined),false);
  for(const connection of ['Connecting','Connected','Reconnecting','Disconnecting'])assert.equal(active({connection}),true);
  assert.equal(active({connection:'Error'},{state:'connected'}),true);assert.equal(active({sharing:true}),true);
  assert.equal(active({connection:'Error'},{state:'disconnected'}),false);h.instance.stop();
});
test('latest and newer local versions are kept; ETag 304 does not rewrite files',async()=>{
  let count=0;const h=harness({version:'1.1.18',fetch:()=>++count===1?new Response(source(),{headers:{etag:'"same"'}}):new Response(null,{status:304})});
  await h.instance.check();await h.instance.check(true);assert.equal(h.writes.length,0);
  assert.equal(h.calls[1].options.headers['If-None-Match'],'"same"');assert.match(h.toasts.at(-1),/1.1.18/);h.instance.stop();
});
for(const [name,payload] of [['HTML','<html>Not found</html>'],['wrong plugin',source().replace('CustomVoice','Other')],['syntax error',source('1.1.17','module.exports = ;')]])
  test(`rejects ${name} and retries without touching the installed plugin`,async()=>{
    const h=harness({fetch:()=>new Response(payload)});await h.instance.check(true);
    assert.equal(h.writes.length,0);assert.equal(h.timers.get(h.instance.timer).delay,60000);assert.equal(h.logs.length,1);h.instance.stop();
  });
test('checks syntax without executing downloaded code',async()=>{
  const h=harness({fetch:()=>new Response(source('1.1.17','throw Error("must not execute"); module.exports = class {};'))});await h.instance.check();assert.equal(h.writes.length,1);h.instance.stop();
});
test('limits advertised and streamed downloads to 8 MiB',async()=>{
  for(const response of [new Response('small',{headers:{'content-length':9*1024*1024}}),new Response('x'.repeat(8*1024*1024+1))]){
    const h=harness({fetch:()=>response});await h.instance.check();assert.equal(h.writes.length,0);assert.equal(h.instance.failures,1);h.instance.stop();
  }
});
test('network failures back off and successful retry recovers automatically',async()=>{
  let fail=true;const h=harness({fetch:()=>{if(fail)throw Error('offline');return new Response(source());}});
  await h.instance.check();assert.equal(h.timers.get(h.instance.timer).delay,60000);
  await h.instance.check();assert.equal(h.timers.get(h.instance.timer).delay,120000);
  fail=false;await h.instance.check();assert.equal(h.writes.length,1);h.instance.stop();
});
test('stop aborts an in-flight request and ignores its eventual result',async()=>{
  let finish;const h=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});const checking=h.instance.check();
  await Promise.resolve();h.instance.stop();assert.equal(h.calls[0].options.signal.aborted,true);
  finish(new Response(source()));await checking;assert.equal(h.writes.length,0);assert.equal(h.timers.size,0);
});
test('concurrent update checks share one in-flight operation',async()=>{
  let finish;const h=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});const checking=h.instance.check();
  await h.instance.check(true);assert.equal(h.calls.length,1);finish(new Response(source()));await checking;h.instance.stop();
});
test('native updates download automatically and never terminate Discord',async()=>{
  let checks=0,prepares=0;const bridge={checkNativeUpdate:async()=>{checks++;return {available:true};},prepareNativeUpdate:async()=>{prepares++;return {state:'waiting',version:'1.1.13'};}};
  const h=harness({bridge});const n=h.instance.nativeUpdater;await n.check();
  assert.equal(checks,1);assert.equal(prepares,1);assert.match(h.toasts[0],/Discord/);assert.equal(h.timers.get(n.timer).delay,900000);h.instance.stop();
});
for(const state of ['waiting','downloading','applying'])test(`native ${state} operation is not prepared twice`,async()=>{
  const h=harness({bridge:{checkNativeUpdate:async()=>({available:true,pending:{state,version:'1.1.13'}}),prepareNativeUpdate:async()=>assert.fail('duplicate')}});
  await h.instance.nativeUpdater.check();assert.equal(h.logs.length,0);h.instance.stop();
});
test('native updater ignores stale checks after stop and works without a bridge',async()=>{
  const missing=harness();await missing.instance.nativeUpdater.check();assert.equal(missing.logs.length,0);missing.instance.stop();
  let finish;const h=harness({bridge:{checkNativeUpdate:()=>new Promise(resolve=>{finish=resolve;}),prepareNativeUpdate:()=>assert.fail('stopped')}});
  const operation=h.instance.nativeUpdater.check();h.instance.stop();finish({available:true});await operation;assert.equal(h.timers.size,0);
});
test('older native launcher pipe stalls still report the ready installation and ignore a late timeout',async()=>{
  const h=harness();let fail;
  const result=h.context.prepareNativeUpdateWithStatus({prepareNativeUpdate:()=>new Promise((_,reject)=>{fail=reject;}),nativeUpdateStatus:async()=>({state:'waiting',version:'1.1.14'})},'1.1.14');
  await Promise.resolve();const timer=[...h.timers.values()].find(value=>value.delay===1000);await timer.fn();
  assert.equal((await result).version,'1.1.14');fail(Error('old launcher timeout'));await Promise.resolve();h.instance.stop();
});
test('native preparation status polling stops after its owner is disposed',async()=>{
  const h=harness();let active=true;
  const result=h.context.prepareNativeUpdateWithStatus({prepareNativeUpdate:()=>new Promise(()=>{})},'1.1.14',()=>active);
  active=false;await [...h.timers.values()].find(value=>value.delay===1000).fn();assert.equal(await result,undefined);h.instance.stop();
});
test('disk replacement backs up, rejects concurrent changes, and deletes only its retired credential',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cv-updater-'));const plugins=path.join(root,'plugins'),data=path.join(root,'data','CustomVoice');fs.mkdirSync(plugins);fs.mkdirSync(data,{recursive:true});
  const file=path.join(plugins,'CustomVoice.plugin.js'),legacy=path.join(data,'github-token.bin'),unrelated=path.join(data,'settings.json');fs.writeFileSync(file,source('1.1.12'));fs.writeFileSync(legacy,'retired');fs.writeFileSync(unrelated,'keep');
  const h=harness();h.api.Plugins={folder:plugins};const disk=h.instance.diskFiles();
  try{
    disk.cleanupLegacyToken();assert.equal(fs.existsSync(legacy),false);assert.equal(fs.readFileSync(unrelated,'utf8'),'keep');
    assert.throws(()=>disk.replace(source(),'stale'));assert.equal(fs.readFileSync(file,'utf8'),source('1.1.12'));
    disk.replace(source(),source('1.1.12'));assert.equal(fs.readFileSync(file,'utf8'),source());
    const backups=path.join(root,'data','CustomVoice-install-backups');assert.equal(fs.readFileSync(path.join(backups,fs.readdirSync(backups)[0],'CustomVoice.plugin.js'),'utf8'),source('1.1.12'));
  }finally{h.instance.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('failed disk write restores the previous plugin',()=>{
  let text=source('1.1.12'),attempts=0;
  const fake={readFileSync:()=>text,mkdirSync:()=>{},writeFileSync:(file,value)=>{if(path.basename(path.dirname(file)).startsWith('auto-'))return;if(++attempts===1){text='partial';throw Error('disk write');}text=value;}};
  const h=harness({require:name=>name==='fs'?fake:require(name)});h.api.Plugins={folder:'C:/test/plugins'};
  assert.throws(()=>h.instance.diskFiles().replace(source(),text),/disk write/);assert.equal(text,source('1.1.12'));h.instance.stop();
});

test('native waiting notification reports the actual locked-file reason',async()=>{
  const message='graphics-hook64.dll 파일을 사용 중입니다. 해당 게임을 종료하면 계속합니다.';
  const h=harness({bridge:{checkNativeUpdate:async()=>({available:true,pending:{state:'waiting',version:'1.1.16',message}}),prepareNativeUpdate:()=>assert.fail('duplicate')}});
  await h.instance.nativeUpdater.check();await h.instance.nativeUpdater.check();
  assert.equal(h.toasts.length,1);assert.ok(h.toasts[0].includes(message));h.instance.stop();
});

function panelHarness(info,loaded='1.1.15'){
  let result=info,prepares=0;
  const bridge={version:loaded,checkNativeUpdate:async()=>result,prepareNativeUpdate:async()=>{prepares++;return {state:'waiting',version:result.latestVersion,message:'테스트 적용 대기'};}};
  const h=harness({bridge});
  h.context.document={createElement:()=>({children:[],listeners:{},setAttribute(){},append(...nodes){this.children.push(...nodes);},addEventListener(name,fn){this.listeners[name]=fn;}})};
  const panel=h.context.createNativeUpdatePanel();
  const [,,version,status,check,install]=panel.element.children;
  return {...h,panel,version,status,check,install,prepares:()=>prepares,setResult:value=>{result=value;},close(){panel.dispose();h.instance.stop();}};
}

test('native panel distinguishes loaded and verified disk versions after update',async()=>{
  const h=panelHarness({installedVersion:'1.1.17',latestVersion:'1.1.17',available:false,installationValid:true,pending:{state:'installed',version:'1.1.17'}});
  await new Promise(setImmediate);
  assert.match(h.version.textContent,/실행 중: 1\.1\.15/);assert.match(h.version.textContent,/설치된 native: 1\.1\.17/);
  assert.match(h.version.textContent,/완전 재시작 필요/);assert.match(h.status.textContent,/완전히 종료/);assert.equal(h.install.disabled,true);h.close();
});

test('native panel offers same-version repair and respects a real waiting reason',async()=>{
  const h=panelHarness({installedVersion:'1.1.17',latestVersion:'1.1.17',available:true,repairRequired:true,installationValid:false,pending:{state:'failed',version:'1.1.17',message:'설치 파일 손상'}});
  await new Promise(setImmediate);
  assert.match(h.status.textContent,/설치 파일 손상/);assert.equal(h.install.textContent,'구성요소 복구');assert.equal(h.install.disabled,false);
  await h.install.listeners.click();assert.equal(h.prepares(),1);assert.match(h.status.textContent,/테스트 적용 대기/);assert.equal(h.install.disabled,true);h.close();
});

test('native panel does not promote disk version from an old completion status',async()=>{
  const h=panelHarness({installedVersion:'1.1.15',latestVersion:'1.1.17',available:true,pending:{state:'installed',version:'1.1.17'}});
  await new Promise(setImmediate);
  assert.match(h.version.textContent,/설치된 native: 1\.1\.15/);assert.equal(h.install.disabled,false);h.close();
});

test('published plugin UI version and native requirement match release metadata',()=>{
  const plugin=bundle.match(/@version\s+(\d+\.\d+\.\d+)/)[1],native=bundle.match(/@nativeVersion\s+(\d+\.\d+\.\d+)/)[1];
  assert.equal(bundle.match(/^var version3 = "([^"]+)";/m)[1],plugin);
  assert.equal(updater.match(/const required='([^']+)'/)[1],native);
  assert.equal(bundle.match(/const required='([^']+)'/)[1],native);
  assert.ok(bundle.includes('pluginVersion: version3, nativeVersion: globalThis.CustomVoiceNative?.version'));
  for(const [file,pattern] of [['host-main.cjs',/hostVersion: '([^']+)'/],['host-preload.cjs',/protocol: 2, version: '([^']+)'/],['NativeUpdate.cs',/CurrentVersion = "([^"]+)"/]])assert.equal(fs.readFileSync(path.join(__dirname,'../native',file),'utf8').match(pattern)[1],native);
});
