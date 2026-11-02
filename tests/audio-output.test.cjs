const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../CustomVoice.plugin.js'),'utf8');
const cut=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const Track={Source:{ScreenShare:'screen',ScreenShareAudio:'screen-audio',Microphone:'mic'},Kind:{Audio:'audio',Video:'video'}};
function fixture(webAudio=true) {
  let state={watching:['peer'],deafened:false,settings:{outputDevice:'default'}};
  const calls=[],elements=[],pubs=new Map(),store={get:()=>state,set:patch=>state={...state,...patch}};
  const context=vm.createContext({Track,customVoiceLog(){},document:{body:{append:element=>elements.push(element)}},navigator:{mediaDevices:{enumerateDevices:async()=>[{kind:'audiooutput',deviceId:'default'}]}}});
  vm.runInContext(cut('var MediaController = class','function isTyping('),context);
  const media=new context.MediaController(store,error=>{throw error;}),peer={identity:'peer',getTrackPublication:source=>pubs.get(source),setVolume(value,source){const track=pubs.get(source)?.track;if(track){if(track.audioContext)track.gain=value;else track.element.volume=value;}calls.push({value,source});}};
  const room={remoteParticipants:new Map([['peer',peer]]),switchActiveDevice:async()=>{},startAudio:async()=>{calls.push('resume');}};media.room=room;media.playAudio=async()=>{};
  function track(source) {
    let volume=1;
    const element={dataset:{},muted:false,play:async()=>{calls.push('play');},pause(){},remove(){},get volume(){return volume;},set volume(value){if(value<0||value>1)throw new RangeError('HTMLMediaElement volume outside [0,1]');volume=value;}};
    const value={kind:'audio',source,element,audioContext:webAudio?{}:undefined,attach:()=>element,detach(){},gain:1};pubs.set(source,{source,track:value});return value;
  }
  return {context,media,store,track,room,pubs,calls,elements};
}
test('200% stream gain uses Web Audio without unmuting its backing element; microphone stays independent',()=>{
  const f=fixture(),audio=f.track('screen-audio'),mic=f.track('mic');f.media.addAudio(audio,'peer');f.media.addAudio(mic,'peer');
  f.media.streamVolume('peer',2);f.media.volume('peer',0.5);
  assert.equal(audio.gain,2);assert.equal(mic.gain,0.5);assert.equal(audio.element.volume,0);assert.equal(audio.element.muted,true);
  f.store.set({deafened:true});f.media.updateOutput();assert.equal(audio.gain,0);assert.equal(mic.gain,0);
  f.store.set({deafened:false});f.media.updateOutput();assert.equal(audio.gain,2);assert.equal(audio.element.muted,true);
});
test('without Web Audio, volume is bounded and an unavailable publication cannot store an unsafe HTML volume',()=>{
  const f=fixture(false),audio=f.track('screen-audio');f.media.addAudio(audio,'peer');
  assert.doesNotThrow(()=>f.media.streamVolume('peer',2));assert.equal(audio.element.volume,1);
  f.media.volume('peer',NaN);assert.equal(f.media.getVolume('peer'),1);assert.ok(f.calls.filter(c=>typeof c==='object').every(c=>c.value<=1));
});
test('rewatch attaches an already subscribed audio track after the watching state changes',()=>{
  const f=fixture(),audio=f.track('screen-audio');f.store.set({watching:[]});f.media.addAudio(audio,'peer');assert.equal(f.media.audio.size,0);
  vm.runInContext('var Manager = class {'+cut('  watch(identity2, watch = true)','  async watchParticipant(')+'};',f.context);
  const manager=new f.context.Manager();manager.store=f.store;manager.media=f.media;manager.error=assert.fail;manager.client={watchScreen:()=>f.media.addAudio(audio,'peer')};f.media.resumeAudio=async()=>{};
  manager.watch('peer');assert.equal(f.media.audio.size,1);
  manager.watch('peer',false);assert.equal(f.media.audio.size,0);
  manager.watch('peer');assert.equal(f.media.audio.size,1);assert.equal(f.elements.length,2);
});
test('room audio resume is requested before awaiting device enumeration, and detached tracks are not restarted',async()=>{
  const f=fixture(),audio=f.track('screen-audio');f.media.addAudio(audio,'peer');delete f.media.playAudio;
  let finish;f.media.outputReady=()=>new Promise(resolve=>{finish=resolve;});
  const work=f.media.playAudio([audio.element],true);assert.equal(f.calls.at(-1),'resume');
  f.media.removeAudio(audio);finish(true);await work;assert.ok(!f.calls.includes('play'));
});
