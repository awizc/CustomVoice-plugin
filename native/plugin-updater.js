var PluginUpdater = class {
  constructor(api,active,files){this.api=api;this.active=active;this.files=files;this.running=false;this.busy=false;this.generation=0;this.updated=false;this.failures=0;this.commit='';this.candidate=null;}
  start(){
    if(this.running)return;this.running=true;++this.generation;
    // BetterDiscord must finish marking the newly enabled plugin as running
    // before its file can trigger a reload.
    this.schedule(3500);
  }
  stop(){this.running=false;++this.generation;clearTimeout(this.timer);this.candidate=null;}
  schedule(delay=3600000){
    if(!this.running||this.updated)return;clearTimeout(this.timer);
    this.timer=setTimeout(()=>{void this.check();},delay);
  }
  async check(notify=false){
    if(!this.running||this.updated)return;
    if(this.busy){if(notify)this.toast('업데이트를 확인하고 있습니다. 잠시 기다려 주세요.');this.schedule(3000);return;}
    this.busy=true;clearTimeout(this.timer);
    const generation=this.generation,current=()=>this.running&&this.generation===generation;
    let delay=3600000;
    try{
      if(this.candidate?.expires<=Date.now())this.candidate=null;
      if(this.active()){delay=30000;if(notify)this.toast('통화와 방송을 종료하면 30초 이내에 업데이트를 다시 확인합니다.');return;}
      const bridge=globalThis.CustomVoiceNative;
      if(!bridge?.getUpdateSource)throw Error('private 저장소 업데이트에는 최신 native 설치와 Discord 완전 재시작이 필요합니다.');
      const cached=this.candidate;this.candidate=null;
      const result=cached?.result??await bridge.getUpdateSource(this.commit);
      if(!current())return;
      if(result?.repository!==UPDATE_REPO||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(result.commit??''))throw Error('업데이트 저장소 응답이 올바르지 않습니다.');
      if(result.unchanged===true){
        if(!this.commit||result.commit!==this.commit)throw Error('업데이트 버전 응답이 일치하지 않습니다.');
        this.failures=0;if(notify)this.toast(`CustomVoice ${pluginVersion((this.files??this.diskFiles()).read())}: 저장소에 새 변경이 없습니다.`);return;
      }
      if(typeof result.source!=='string'||result.source.length>8*1024*1024)throw Error('업데이트 파일 응답이 올바르지 않습니다.');
      if(this.active()){this.candidate={result,expires:cached?.expires??Date.now()+60000};delay=30000;return;}
      const source=result.source,remote=pluginVersion(source),files=this.files??this.diskFiles();
      const previous=files.read(),local=pluginVersion(previous);
      if(!newerVersion(remote,local)){this.commit=result.commit;this.candidate=null;this.failures=0;if(notify)this.toast(`CustomVoice ${local}: 설치 가능한 새 버전이 없습니다.`);return;}
      const header=source.match(/^\uFEFF?\s*\/\*\*[\s\S]*?\*\//)?.[0]??'';
      const required=header.match(/^\s*\*\s*@nativeVersion\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
      // Compile the downloaded module body without executing it. A malformed
      // release must not replace the working plugin and disable it on reload.
      try{new Function('require','module','exports',source);}catch(error){throw Error(error?.name==='SyntaxError'?`CustomVoice ${remote} 파일에 문법 오류가 있어 업데이트를 적용하지 않았습니다.`:'다운로드 파일의 문법을 확인할 수 없어 현재 플러그인을 유지합니다.');}
      if(!current())return;
      if(this.active()){this.candidate={result,expires:cached?.expires??Date.now()+60000};delay=30000;return;}
      files.replace(source,previous);this.updated=true;this.candidate=null;this.failures=0;clearTimeout(this.timer);
      this.toast(`CustomVoice ${local} → ${remote} 업데이트됨`,'success');
      if(required&&(!bridge.version||newerVersion(required,bridge.version)))this.toast('새 native도 있습니다. CustomVoice 플러그인 설정에서 native 업데이트를 눌러 주세요.');
    }catch(error){
      if(current()){
        this.candidate=null;this.commit='';
        delay=Math.min(900000,60000*2**Math.min(this.failures++,4));
        const message=error?.message??String(error);
        if(this.lastError!==message||Date.now()-(this.lastErrorAt??0)>=900000){this.lastError=message;this.lastErrorAt=Date.now();try{customVoiceLog('warn','[CustomVoice] Private update',message);}catch{}}
        if(notify)this.toast(message,'error');
      }
    }finally{this.busy=false;if(current())this.schedule(delay);}
  }
  toast(message,type='info'){try{this.api.UI.showToast(message,{type});}catch{}}
  diskFiles(){
    const fs=require('fs'),path=require('path'),file=path.join(this.api.Plugins.folder,'CustomVoice.plugin.js');
    return {
      read:()=>fs.readFileSync(file,'utf8'),
      replace:(source,previous)=>{
        if(fs.readFileSync(file,'utf8')!==previous)throw Error('다른 작업이 플러그인 파일을 변경했습니다. 다음에 다시 업데이트합니다.');
        const backup=path.join(this.api.Plugins.folder,'..','data','CustomVoice-install-backups','auto-'+Date.now()+'-'+Math.random().toString(16).slice(2));
        fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'CustomVoice.plugin.js'),previous,'utf8');
        // In-place writes preserve the enabled state; renaming over the plugin
        // can make the file watcher treat it as a removal and disable it.
        // BetterDiscord exposes a restricted fs facade without descriptor APIs.
        // writeFileSync overwrites the existing file without a rename/removal.
        try{
          fs.writeFileSync(file,source,'utf8');
          if(fs.readFileSync(file,'utf8')!==source)throw Error('업데이트 파일을 완전히 기록하지 못했습니다. 이전 버전으로 복원합니다.');
        }
        catch(error){
          try{fs.writeFileSync(file,previous,'utf8');if(fs.readFileSync(file,'utf8')!==previous)throw Error('Restore failed');}
          catch{throw Error(`업데이트 파일 복원에 실패했습니다. 백업: ${backup}`);}
          throw error;
        }
      }
    };
  }
};

function createNativeUpdatePanel() {
  const element=document.createElement('section');element.className='cv-native-update';
  const heading=document.createElement('h3');heading.textContent='업데이트';
  const description=document.createElement('p');
  description.textContent='플러그인은 시작 후와 1시간마다 확인합니다. 통화·방송이 끝나면 30초 이내에 다시 확인하고, 연결 실패 시 잠시 후 재시도합니다. native는 아래 버튼을 눌렀을 때만 다운로드합니다.';
  const version=document.createElement('p');version.textContent=`현재 native: ${globalThis.CustomVoiceNative?.version??'연결 없음'}`;
  const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const check=document.createElement('button');check.type='button';check.textContent='native 새 버전 확인';
  const install=document.createElement('button');install.type='button';install.textContent='native 업데이트';install.disabled=true;
  element.append(heading,description,version,status,check,install);
  let disposed=false,busy=false,info,pending,timer,revision=0;
  const inProgress=()=>['downloading','waiting','applying'].includes(pending?.state);
  const bridge=()=>{const value=globalThis.CustomVoiceNative;if(!value?.checkNativeUpdate||!value?.prepareNativeUpdate)throw Error('native 업데이트 버튼을 처음 사용하려면 1.1.1 이상의 전체 ZIP 설치와 Discord 완전 재시작이 필요합니다.');return value;};
  function paint(){
    if(disposed)return;
    const loaded=globalThis.CustomVoiceNative?.version,installed=info?.installedVersion??loaded;
    version.textContent=`설치된 native: ${installed??'연결 없음'}${info?.latestVersion?' / 배포된 native: '+info.latestVersion:''}${loaded&&installed&&newerVersion(installed,loaded)?' (완전 재시작 필요)':''}`;
    check.disabled=busy;install.disabled=busy||!info?.available||inProgress();
    install.textContent=pending?.state==='waiting'?'Discord 종료 후 적용 예정':'native 업데이트';
  }
  function showState(value){
    pending=value;if(disposed)return;
    if(value.state==='waiting')status.textContent=`native ${value.version} 다운로드 완료. Discord를 트레이에서 완전히 종료하면 자동 적용합니다. 종료 후 5초 정도 기다렸다가 다시 실행해 주세요.`;
    else if(value.state==='downloading')status.textContent='native 배포 파일을 다운로드하고 있습니다…';
    else if(value.state==='applying')status.textContent='native 업데이트를 적용하고 있습니다…';
    else if(value.state==='failed')status.textContent=value.message||'native 업데이트가 중단되었습니다. 다시 시도해 주세요.';
    else if(value.state==='installed'||value.state==='current'){
      const installed=value.version??info?.installedVersion;
      if(info&&installed){if(!info.installedVersion||newerVersion(installed,info.installedVersion))info.installedVersion=installed;info.available=Boolean(info.latestVersion&&newerVersion(info.latestVersion,info.installedVersion));}
      status.textContent=`native ${installed??''} 설치됨.${info?.available?' 더 새로운 버전이 있습니다.':''}`;
    }
    paint();schedule();
  }
  function schedule(){clearTimeout(timer);if(!disposed&&inProgress())timer=setTimeout(()=>void poll(),pending?.state==='waiting'?10000:5000);}
  async function poll(){
    if(disposed)return;if(busy){schedule();return;}const request=++revision;
    try{const value=await bridge().nativeUpdateStatus();if(!disposed&&request===revision)showState(value);}
    catch(error){if(!disposed&&request===revision){status.textContent=error.message;schedule();}}
  }
  async function refresh(){
    if(disposed||busy)return;const request=++revision;clearTimeout(timer);busy=true;paint();status.textContent='GitHub에서 native 버전을 확인하고 있습니다…';
    try{
      const result=await bridge().checkNativeUpdate();if(disposed||request!==revision)return;info=result;
      status.textContent=result.available?`native ${result.latestVersion} 업데이트가 있습니다.`:'native는 최신 버전입니다.';
      const required='1.1.5';
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
    try{const value=await bridge().prepareNativeUpdate();if(!disposed&&request===revision)showState(value);}
    catch(error){if(!disposed){status.textContent=error.message;pending=undefined;}}
    finally{busy=false;paint();}
  });
  void refresh();
  return {element,dispose(){disposed=true;++revision;clearTimeout(timer);}};
}
