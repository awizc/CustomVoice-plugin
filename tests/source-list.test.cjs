const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');

function sourceApi(listWindowSources) {
  const context = vm.createContext({module:{exports:{}}, DOMException,
    CustomVoiceNative: listWindowSources ? {listWindowSources} : undefined});
  vm.runInContext(fs.readFileSync(path.join(root, 'native/capture.js'), 'utf8'), context);
  return (getDesktopCaptureSources, signal = new AbortController().signal) =>
    context.module.exports.listSources({getDesktopCaptureSources}, signal);
}
test('supplements an omitted minimized game and deduplicates by HWND while preserving Discord thumbnails', async () => {
  const thumbnail = {image:true};
  const list = sourceApi(async()=>[
    {id:'window:42:0',name:'osu!',minimized:true}, {id:'window:43:0',name:'Editor',minimized:false}
  ]);
  const result = await list(async()=>[
    {id:'screen:0:0',name:'Monitor'}, {id:'window:43:1',name:'Editor title',thumbnail}
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[1].thumbnail, thumbnail); assert.equal(result[1].id, 'window:43:1');
  assert.equal(result[2].id, 'window:42:0'); assert.equal(result[2].minimized, true);
  assert.equal(result[2].nativeOnly, true);
});
test('invalid native identifiers cannot add monitors or replace valid sources', async () => {
  const list = sourceApi(async()=>[
    {id:'screen:42:0',name:'Wrong type'}, {id:'window:0:0',name:'Invalid handle'},
    {id:'window:NaN:0',name:'Bad'}, {id:'window:42:0',name:''}, null
  ]);
  const result = await list(async()=>[{id:'window:8:0',name:'Existing'}]);
  assert.equal(result.length,1); assert.equal(result[0].id,'window:8:0');
});
test('native list failure and old hosts retain the Discord picker', async () => {
  for (const native of [undefined, async()=>{throw Error('Native unavailable');}]) {
    const result = await sourceApi(native)(async()=>[{id:'screen:0:0',name:'Monitor'}]);
    assert.equal(result.length,1);
  }
});
test('native windows remain selectable if Discord enumeration fails, but total failure is reported', async () => {
  const failure = async()=>{throw Error('Discord failed');};
  const result = await sourceApi(async()=>[{id:'window:42:0',name:'osu!'}])(failure);
  assert.equal(result[0].id,'window:42:0');
  await assert.rejects(sourceApi(async()=>{throw Error('Native failed');})(failure), /Discord failed/);
});
test('cancellation discards a late enumeration result', async () => {
  let finish;
  const controller = new AbortController();
  const pending = sourceApi(()=>new Promise(resolve=>{finish=resolve;}))(()=>[],controller.signal);
  await Promise.resolve();
  controller.abort(); finish([{id:'window:42:0',name:'osu!'}]);
  await assert.rejects(pending,{name:'AbortError'});
});

function hostHarness() {
  const handlers = new Map(), children = [], timers = new Set();
  const context = vm.createContext({module:{exports:{}},__dirname:path.join(root,'native'),
    setTimeout:callback=>{timers.add(callback);return callback;},clearTimeout:timer=>timers.delete(timer),
    require:name=>{
      if(name==='path')return path;
      if(name==='electron')return {ipcMain:{handle:(key,callback)=>handlers.set(key,callback)}};
      assert.equal(name,'child_process');
      return {spawn:(file,args,options)=>{
        assert.match(file,/CustomVoice\.Capture\.exe$/); assert.equal(args[0],'--list-windows'); assert.equal(options.windowsHide,true);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stdout.setEncoding=()=>{};
        child.stderr={resume(){}}; child.kill=()=>{child.killed=true;};
        children.push(child); return child;
      }};
    }});
  vm.runInContext(fs.readFileSync(path.join(root,'native/window-sources-main.cjs'),'utf8'),context);
  context.module.exports.install(event=>{if(!event.trusted)throw Error('Untrusted');});
  return {children,timers,list:()=>handlers.get('customvoice-native-v2:window-sources')({trusted:true}),
    untrusted:()=>handlers.get('customvoice-native-v2:window-sources')({}),
    complete:(child,result,code=0)=>{child.stdout.emit('data',JSON.stringify(result));child.emit('close',code);}};
}
test('source IPC authenticates callers, coalesces concurrent reads, and refreshes after completion', async()=>{
  const h=hostHarness(); assert.throws(h.untrusted,/Untrusted/); assert.equal(h.children.length,0);
  const first=h.list(), second=h.list(); assert.equal(first,second); assert.equal(h.children.length,1);
  h.complete(h.children[0],{type:'sources',sources:[{id:'window:42:0',name:'osu!',minimized:true}]});
  assert.equal((await first)[0].minimized,true); await second; assert.equal(h.timers.size,0);
  const refresh=h.list(); assert.equal(h.children.length,2);
  h.complete(h.children[1],{type:'sources',sources:[]}); assert.equal((await refresh).length,0);
});
test('source IPC rejects malformed helper data and allows a later retry', async()=>{
  const h=hostHarness(), first=h.list();
  h.complete(h.children[0],{type:'sources',sources:[{id:'window:0:0',name:'Invalid'}]});
  await assert.rejects(first,/잘못된/);
  const retry=h.list(); h.complete(h.children[1],{type:'sources',sources:[]}); await retry;
});
test('source IPC kills timed-out helpers without retaining a pending request',async()=>{
  const h=hostHarness(), first=h.list();
  for(const timer of [...h.timers])timer();
  await assert.rejects(first,/초과/); assert.equal(h.children[0].killed,true); assert.equal(h.timers.size,0);
  const retry=h.list();h.complete(h.children[1],{type:'sources',sources:[]});await retry;
});

// In-memory DOM model only. No browser, Electron, app window or desktop access.
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.attributes={};this.listeners={};}
  append(...nodes){for(const node of nodes){this.children.push(node);if(typeof node==='object')node.parent=this;}}
  prepend(node){this.children.unshift(node);node.parent=this;}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(type,listener){this.listeners[type]=listener;}
  close(){this.open=false;}
  showModal(){this.open=true;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  focus(){}
}
function pickerHarness(sources,refresh,options){
  const body=new Element('body'), document={body,createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)};
  const plugin=fs.readFileSync(path.join(root,'CustomVoice.plugin.js'),'utf8');
  const picker=plugin.slice(plugin.indexOf('function selectDesktopSource('),plugin.indexOf('function discordScreenCapture('));
  const context=vm.createContext({document,nextPickerId:0,imageData:()=>undefined,shareFrameRates:[30,60,165],shareQualities:['1080p'],shareQualityLabel:value=>value,cancelled:()=>new DOMException('Cancelled','AbortError')});
  const quality=plugin.slice(plugin.indexOf('// src/services/screen-quality.ts'),plugin.indexOf('// src/discord/screen-capture.ts'));
  vm.runInContext(quality+picker,context);
  const controller=new AbortController(), result=context.selectDesktopSource(sources,controller.signal,options,refresh);
  const all=()=>{const found=[];function visit(node){if(typeof node!=='object')return;found.push(node);for(const child of node.children)visit(child);}visit(body);return found;};
  return {body,result,controller,all,refresh:()=>all().find(node=>node.textContent==='목록 새로고침')};
}
test('picker refresh shows a newly discovered minimized game and resolves its exact source ID',async()=>{
  const h=pickerHarness([{id:'window:8:0',name:'Editor'}],async()=>[{id:'window:42:0',name:'osu!',minimized:true}]);
  await h.refresh().onclick();
  const game=h.all().find(node=>node.dataset.sourceId==='window:42:0');assert.ok(game);
  assert.ok(h.all().some(node=>node.textContent==='최소화된 창 · 공유 후 게임으로 돌아가세요'));
  game.onclick();assert.equal(await h.result,'window:42:0');assert.equal(h.body.children.length,0);
});
test('failed picker refresh preserves existing choices and remains retryable',async()=>{
  const h=pickerHarness([{id:'window:8:0',name:'Editor'}],async()=>{throw Error('Refresh failed');});
  await h.refresh().onclick(); assert.equal(h.refresh().disabled,false);
  assert.ok(h.all().some(node=>node.textContent==='Refresh failed'));
  h.all().find(node=>node.dataset.sourceId==='window:8:0').onclick();assert.equal(await h.result,'window:8:0');
});
test('closing the picker during refresh cannot recreate a closed dialog',async()=>{
  let finish;const h=pickerHarness([],()=>new Promise(resolve=>{finish=resolve;}));
  const rejection=assert.rejects(h.result,{name:'AbortError'}), pending=h.refresh().onclick();
  h.controller.abort(); await rejection;
  finish([{id:'window:42:0',name:'osu!'}]);await pending;assert.equal(h.body.children.length,0);
});

test('source search filters names without changing source IDs and can recover from an empty match',async()=>{
  const h=pickerHarness([{id:'window:8:0',name:'Editor'},{id:'window:42:0',name:'osu!'}]);
  const search=h.all().find(node=>node.className==='cv-share-search');
  search.value=' OSU ';search.oninput();
  assert.deepEqual(h.all().filter(node=>node.dataset.sourceId).map(node=>node.dataset.sourceId),['window:42:0']);
  search.value='없는 창';search.oninput();assert.equal(h.all().filter(node=>node.dataset.sourceId).length,0);
  assert.ok(h.all().some(node=>node.textContent?.includes('검색어를 바꾸거나')));
  search.value='';search.oninput();assert.equal(h.all().filter(node=>node.dataset.sourceId).length,2);
  h.all().find(node=>node.dataset.sourceId==='window:42:0').onclick();assert.equal(await h.result,'window:42:0');
});

test('app and screen tabs describe the actual audio scope and close cancels without sharing',async()=>{
  const options={quality:'1080p',resolution:{frameRate:60},audio:false};
  const h=pickerHarness([{id:'window:8:0',name:'Game'},{id:'screen:0:0',name:'Monitor'}],undefined,options);
  const audio=h.all().find(node=>node.type==='checkbox');
  assert.ok(h.all().some(node=>node.textContent?.includes('송출 해상도를 일시 조절')));
  assert.equal(audio.attributes['aria-label'],'앱 소리 공유');
  h.all().find(node=>node.dataset.type==='screen').onclick();assert.equal(audio.attributes['aria-label'],'시스템 소리 공유');
  assert.ok(h.all().some(node=>node.textContent?.includes('시스템 소리를 전달')));
  audio.checked=true;audio.onchange();assert.equal(options.audio,true);
  h.all().find(node=>node.dataset.type==='window').onclick();assert.equal(audio.attributes['aria-label'],'앱 소리 공유');assert.equal(options.audio,true);
  const rejection=assert.rejects(h.result,{name:'AbortError'});h.all().find(node=>node.className==='cv-share-close').onclick();await rejection;
  assert.equal(h.body.children.length,0);
});
