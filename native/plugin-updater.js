var PluginUpdater = class {
  constructor(api,active,files){this.api=api;this.active=active;this.files=files;this.running=false;this.busy=false;this.generation=0;this.updated=false;this.failures=0;this.etag='';this.candidate=null;}
  start(){
    if(this.running)return;this.running=true;++this.generation;
    try{(this.files??this.diskFiles()).cleanupLegacyToken?.();}catch(error){this.log('Legacy update credential cleanup',error);}
    this.schedule(3500);
    this.nativeUpdater=new NativeAutoUpdater(this.api);this.nativeUpdater.start();
  }
  stop(){this.running=false;++this.generation;clearTimeout(this.timer);this.request?.abort();this.candidate=null;this.nativeUpdater?.stop();}
  schedule(delay=300000){
    if(!this.running||this.updated)return;clearTimeout(this.timer);
    this.timer=setTimeout(()=>{void this.check();},delay);
  }
  async download(){
    const controller=new AbortController();this.request=controller;
    const timeout=setTimeout(()=>controller.abort(),25000);
    try{
      const headers={'Cache-Control':'no-cache',...(this.etag?{'If-None-Match':this.etag}:{})};
      const url=UPDATE_URL;
      const options={method:'GET',headers,signal:controller.signal,timeout:20000,redirect:'error',maxRedirects:0,credentials:'omit',cache:'no-store'};
      const response=await (this.api.Net?.fetch?this.api.Net.fetch(url,options):globalThis.fetch(url,options));
      if(response.status===304&&this.etag)return {unchanged:true};
      if(!response.ok)throw Error(`공개 GitHub 다운로드 실패 (HTTP ${response.status}). 잠시 후 자동으로 다시 확인합니다.`);
      if(Number(response.headers?.get?.('content-length'))>8*1024*1024)throw Error('업데이트 파일이 너무 큽니다.');
      let source;
      if(response.body?.getReader){
        const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;source='';
        try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024)throw Error('업데이트 파일이 너무 큽니다.');source+=decoder.decode(value,{stream:true});}source+=decoder.decode();}
        catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      }else source=await response.text();
      if(typeof source!=='string'||source.length>8*1024*1024)throw Error('업데이트 파일 응답이 올바르지 않습니다.');
      return {source,etag:response.headers?.get?.('etag')??''};
    }finally{clearTimeout(timeout);if(this.request===controller)this.request=null;}
  }
  async check(notify=false){
    if(!this.running||this.updated)return;
    if(this.busy){if(notify)this.toast('업데이트를 확인하고 있습니다. 잠시 기다려 주세요.');return;}
    this.busy=true;clearTimeout(this.timer);
    const generation=this.generation,current=()=>this.running&&this.generation===generation;
    let delay=300000;
    try{
      if(this.candidate?.expires<=Date.now())this.candidate=null;
      const result=this.candidate?.result??await this.download();
      if(!current())return;
      const files=this.files??this.diskFiles(),previous=files.read(),local=pluginVersion(previous);
      if(result.unchanged){this.failures=0;if(notify)this.toast(`CustomVoice ${local}: 최신 버전입니다.`);return;}
      const source=result.source,remote=pluginVersion(source);
      if(!newerVersion(remote,local)){this.etag=result.etag;this.candidate=null;this.failures=0;if(notify)this.toast(`CustomVoice ${local}: 최신 버전입니다.`);return;}
      try{new Function('require','module','exports',source);}catch(error){throw Error(error?.name==='SyntaxError'?`CustomVoice ${remote} 파일에 문법 오류가 있어 현재 버전을 유지합니다.`:'다운로드 파일의 문법을 확인할 수 없습니다.');}
      if(!current())return;
      // Discover and download updates during a call; only replacement waits.
      if(this.active()){
        this.candidate??={result,expires:Date.now()+600000};delay=30000;this.failures=0;
        if(notify||this.announcedVersion!==remote){this.announcedVersion=remote;this.toast(`CustomVoice ${remote} 다운로드 완료. 통화·방송이 끝나면 자동 적용합니다.`);}
        return;
      }
      files.replace(source,previous);this.updated=true;this.candidate=null;this.failures=0;clearTimeout(this.timer);
      this.toast(`CustomVoice ${local} → ${remote} 자동 업데이트됨`,'success');
    }catch(error){
      if(current()){
        this.candidate=null;this.etag='';delay=Math.min(900000,60000*2**Math.min(this.failures++,4));
        const message=error?.message??String(error);
        if(this.lastError!==message||Date.now()-(this.lastErrorAt??0)>=900000){this.lastError=message;this.lastErrorAt=Date.now();this.log('Plugin update',message);}
        if(notify)this.toast(message,'error');
      }
    }finally{this.busy=false;if(current())this.schedule(delay);}
  }
  log(label,error){try{customVoiceLog('warn','[CustomVoice] '+label,error);}catch{}}
  toast(message,type='info'){try{this.api.UI.showToast(message,{type});}catch{}}
  diskFiles(){
    const fs=require('fs'),path=require('path'),file=path.join(this.api.Plugins.folder,'CustomVoice.plugin.js');
    return {
      cleanupLegacyToken:()=>{const legacy=path.join(this.api.Plugins.folder,'..','data','CustomVoice','github-token.bin');if(fs.existsSync(legacy))fs.unlinkSync(legacy);},
      read:()=>fs.readFileSync(file,'utf8'),
      replace:(source,previous)=>{
        if(fs.readFileSync(file,'utf8')!==previous)throw Error('다른 작업이 플러그인 파일을 변경했습니다. 다음에 다시 확인합니다.');
        const backup=path.join(this.api.Plugins.folder,'..','data','CustomVoice-install-backups','auto-'+Date.now()+'-'+Math.random().toString(16).slice(2));
        fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'CustomVoice.plugin.js'),previous,'utf8');
        try{fs.writeFileSync(file,source,'utf8');if(fs.readFileSync(file,'utf8')!==source)throw Error('업데이트 파일 기록을 확인하지 못했습니다.');}
        catch(error){
          try{fs.writeFileSync(file,previous,'utf8');if(fs.readFileSync(file,'utf8')!==previous)throw Error('Restore failed');}
          catch{throw Error(`업데이트 복원에 실패했습니다. 백업: ${backup}`);}
          throw error;
        }
      }
    };
  }
};

var NativeAutoUpdater = class {
  constructor(api){this.api=api;this.running=false;this.busy=false;this.generation=0;this.failures=0;}
  start(){if(this.running)return;this.running=true;++this.generation;this.schedule(12000);}
  stop(){this.running=false;++this.generation;clearTimeout(this.timer);}
  schedule(delay=900000){if(this.running){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.check(),delay);}}
  async check(){
    if(!this.running||this.busy)return;this.busy=true;
    const generation=this.generation,current=()=>this.running&&this.generation===generation;
    let delay=900000;
    try{
      const bridge=globalThis.CustomVoiceNative;
      if(!bridge?.checkNativeUpdate||!bridge?.prepareNativeUpdate)return;
      const info=await bridge.checkNativeUpdate();if(!current())return;
      let pending=info.pending;
      if(!['downloading','waiting','applying'].includes(pending?.state)&&info.available)pending=await prepareNativeUpdateWithStatus(bridge,info.latestVersion,current);
      if(!current())return;this.failures=0;
      if(pending?.state==='waiting'&&this.announcedState!==`${pending.version}:${pending.message??''}`){
        this.announcedState=`${pending.version}:${pending.message??''}`;
        this.api.UI?.showToast?.(`native ${pending.version}: ${pending.message||'다운로드 완료. Discord를 완전히 종료하면 업데이트를 적용합니다.'}`,{type:'info'});
      }
      if(pending?.state==='failed')throw Error(pending.message||'native 자동 업데이트 실패');
    }catch(error){
      if(current()){delay=Math.min(900000,60000*2**Math.min(this.failures++,4));try{customVoiceLog('warn','[CustomVoice] Native auto update',error.message);}catch{}}
    }finally{this.busy=false;if(current())this.schedule(delay);}
  }
};

function prepareNativeUpdateWithStatus(bridge,version,current=()=>true) {
  // Older native launchers leave inherited response pipes open after preparing
  // a worker. Its status file is authoritative even before that request closes.
  return new Promise((resolve,reject)=>{
    let settled=false,timer;const deadline=Date.now()+340000;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const poll=async()=>{
      if(settled)return;if(!current()){finish(null);return;}
      if(Date.now()>deadline){finish(Error('업데이트 준비 시간이 초과되었습니다. 잠시 후 자동 재시도합니다.'));return;}
      try{
        const state=await bridge.nativeUpdateStatus?.();
        if(state&&['waiting','applying'].includes(state.state)&&(!version||state.version===version)){finish(null,state);return;}
      }catch{}
      if(!settled)timer=setTimeout(()=>void poll(),1000);
    };
    timer=setTimeout(()=>void poll(),1000);
    Promise.resolve().then(()=>bridge.prepareNativeUpdate()).then(value=>finish(null,value),error=>finish(error));
  });
}

function updateCallActive(state,room) {
  return Boolean(state?.sharing || ['Connecting','Connected','Reconnecting','Disconnecting'].includes(state?.connection) || room?.state && room.state!=='disconnected');
}

function createNativeUpdatePanel() {
  const element=document.createElement('section');element.className='cv-native-update';
  const heading=document.createElement('h3');heading.textContent='캡처 구성요소';
  const description=document.createElement('p');
  description.textContent='공개 GitHub에서 플러그인은 시작 후와 5분마다, native는 시작 후와 15분마다 자동으로 확인하고 다운로드합니다. 플러그인은 통화·방송 종료 후 30초 이내에, native는 Discord 완전 종료 후 적용합니다. 연결 실패 시 자동 재시도합니다.';
  const version=document.createElement('p');version.textContent=`현재 native: ${globalThis.CustomVoiceNative?.version??'연결 없음'}`;
  const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const check=document.createElement('button');check.type='button';check.textContent='새 버전 확인';
  const install=document.createElement('button');install.type='button';install.textContent='구성요소 업데이트';install.disabled=true;
  element.append(heading,description,version,status,check,install);
  let disposed=false,busy=false,info,pending,timer,revision=0;
  const inProgress=()=>['downloading','waiting','applying'].includes(pending?.state);
  const bridge=()=>{const value=globalThis.CustomVoiceNative;if(!value?.checkNativeUpdate||!value?.prepareNativeUpdate)throw Error('native 업데이트 버튼을 처음 사용하려면 1.1.1 이상의 전체 ZIP 설치와 Discord 완전 재시작이 필요합니다.');return value;};
  function paint(){
    if(disposed)return;
    const loaded=globalThis.CustomVoiceNative?.version,installed=info?.installedVersion;
    version.textContent=`실행 중: ${loaded??'연결 없음'} / 설치된 native: ${installed??'확인 전'}${info?.latestVersion?' / 최신: '+info.latestVersion:''}${info?.repairRequired?' (복구 필요)':loaded&&installed&&loaded!==installed?' (완전 재시작 필요)':''}`;
    check.disabled=busy;install.disabled=busy||!info?.available||inProgress();
    install.textContent=pending?.state==='waiting'?'적용 대기 중':info?.repairRequired?'구성요소 복구':'구성요소 업데이트';
  }
  function showState(value){
    pending=value;if(disposed)return;
    if(value.state==='waiting')status.textContent=`native ${value.version}: ${value.message||'다운로드 완료. Discord를 트레이에서 완전히 종료하면 자동 적용합니다. 종료 후 5초 정도 기다렸다가 다시 실행해 주세요.'}`;
    else if(value.state==='downloading')status.textContent='native 배포 파일을 다운로드하고 있습니다…';
    else if(value.state==='applying')status.textContent='native 업데이트를 적용하고 있습니다…';
    else if(value.state==='failed')status.textContent=value.message||'native 업데이트가 중단되었습니다. 다시 시도해 주세요.';
    else if(value.state==='installed'||value.state==='current'){
      status.textContent='업데이트 작업 완료. 설치 파일을 다시 확인합니다…';
    }
    paint();schedule();
  }
  function schedule(){clearTimeout(timer);if(!disposed&&inProgress())timer=setTimeout(()=>void poll(),pending?.state==='waiting'?10000:5000);}
  async function poll(){
    if(disposed)return;if(busy){schedule();return;}const request=++revision;
    try{const value=await bridge().nativeUpdateStatus();if(!disposed&&request===revision){if(['installed','current'].includes(value.state))await refresh();else showState(value);}}
    catch(error){if(!disposed&&request===revision){status.textContent=error.message;schedule();}}
  }
  async function refresh(){
    if(disposed||busy)return;const request=++revision;clearTimeout(timer);busy=true;paint();status.textContent='GitHub에서 native 버전을 확인하고 있습니다…';
    try{
      const result=await bridge().checkNativeUpdate();if(disposed||request!==revision)return;info=result;
      status.textContent=result.repairRequired?(result.message||'설치 파일을 복구해야 합니다.') :result.available?`native ${result.latestVersion} 업데이트가 있습니다.`:globalThis.CustomVoiceNative?.version!==result.installedVersion?'최신 native 설치 완료. Discord를 완전히 종료한 뒤 다시 실행하면 적용됩니다.':'native는 최신 버전입니다.';
      const required='1.1.17';
      if(newerVersion(required,result.installedVersion)&&newerVersion(required,result.latestVersion))status.textContent=`이 플러그인에 필요한 native ${required}가 정식 릴리스에 아직 없습니다. 전체 ZIP으로 업데이트해 주세요.`;
      if(result.pending&&['downloading','waiting','applying','failed'].includes(result.pending.state))showState(result.pending);
      else {pending=result.pending;clearTimeout(timer);}
    }catch(error){if(!disposed&&request===revision){info=undefined;status.textContent=error.message;}}
    finally{busy=false;paint();schedule();}
  }
  check.addEventListener('click',()=>void refresh());
  install.addEventListener('click',async()=>{
    if(disposed||busy||!info?.available||inProgress())return;
    const request=++revision;clearTimeout(timer);busy=true;paint();status.textContent='native 배포 파일을 다운로드하고 있습니다…';
    try{const value=await prepareNativeUpdateWithStatus(bridge(),info.latestVersion,()=>!disposed&&request===revision);if(!disposed&&request===revision)showState(value);}
    catch(error){if(!disposed){status.textContent=error.message;pending=undefined;}}
    finally{busy=false;paint();if(!disposed&&['installed','current'].includes(pending?.state))void refresh();}
  });
  void refresh();
  return {element,dispose(){disposed=true;++revision;clearTimeout(timer);}};
}
