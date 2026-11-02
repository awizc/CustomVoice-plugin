var PluginUpdater = class {
  constructor(api,active,files){this.api=api;this.active=active;this.files=files;this.running=false;this.busy=false;this.generation=0;this.updated=false;}
  start(){
    if(this.running)return;this.running=true;++this.generation;
    // BetterDiscord must finish marking the newly enabled plugin as running
    // before its file can trigger a reload.
    this.timer=setTimeout(()=>{void this.check().finally(()=>this.schedule());},3500);
  }
  stop(){this.running=false;++this.generation;clearTimeout(this.timer);}
  schedule(){
    if(!this.running||this.updated)return;clearTimeout(this.timer);
    const next=new Date();next.setHours(next.getHours()+1,0,0,0);
    this.timer=setTimeout(()=>{void this.check().finally(()=>this.schedule());},next.getTime()-Date.now());
  }
  async check(notify=false){
    if(!this.running||this.busy||this.updated)return;
    if(this.active()){if(notify)this.api.UI.showToast('통화와 방송을 종료한 뒤 업데이트할 수 있습니다.',{type:'info'});return;}
    this.busy=true;const generation=this.generation,current=()=>this.running&&this.generation===generation;
    try{
      const bridge=globalThis.CustomVoiceNative;
      if(!bridge?.getUpdateSource)throw Error('private 저장소 업데이트에는 최신 native 설치와 Discord 완전 재시작이 필요합니다.');
      const result=await bridge.getUpdateSource();
      if(!current()||this.active())return;
      if(result.repository!==UPDATE_REPO||typeof result.source!=='string')throw Error('업데이트 저장소 응답이 올바르지 않습니다.');
      const source=result.source,remote=pluginVersion(source),files=this.files??this.diskFiles();
      const previous=files.read(),local=pluginVersion(previous);
      if(!newerVersion(remote,local)){if(notify)this.api.UI.showToast(`CustomVoice ${local}: 최신 버전입니다.`,{type:'info'});return;}
      const required=source.match(/^\s*\*\s*@nativeVersion\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
      if(!current()||this.active())return;
      files.replace(source,previous);this.updated=true;clearTimeout(this.timer);
      this.api.UI.showToast(`CustomVoice ${local} → ${remote} 업데이트됨`,{type:'success'});
      if(required&&(!bridge.version||newerVersion(required,bridge.version)))this.api.UI.showToast('새 native도 있습니다. CustomVoice 플러그인 설정에서 native 업데이트를 눌러 주세요.',{type:'info'});
    }catch(error){
      if(current()){
        customVoiceLog('warn','[CustomVoice] Private update',error.message);
        if(notify)this.api.UI.showToast(error.message,{type:'error'});
      }
    }finally{this.busy=false;}
  }
  diskFiles(){
    const fs=require('fs'),path=require('path'),file=path.join(this.api.Plugins.folder,'CustomVoice.plugin.js');
    return {
      read:()=>fs.readFileSync(file,'utf8'),
      replace:(source,previous)=>{
        if(fs.readFileSync(file,'utf8')!==previous)throw Error('다른 작업이 플러그인 파일을 변경했습니다. 다음에 다시 업데이트합니다.');
        const backup=path.join(this.api.Plugins.folder,'..','data','CustomVoice-install-backups','auto-'+Date.now());
        fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'CustomVoice.plugin.js'),previous,'utf8');
        // In-place writes preserve the enabled state; renaming over the plugin
        // can make the file watcher treat it as a removal and disable it.
        // BetterDiscord exposes a restricted fs facade without descriptor APIs.
        // writeFileSync overwrites the existing file without a rename/removal.
        try{fs.writeFileSync(file,source,'utf8');}
        catch(error){
          try{fs.writeFileSync(file,previous,'utf8');}
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
  description.textContent='플러그인 파일은 시작 후와 매시간 자동 업데이트합니다. 통화·방송 중에는 적용을 미룹니다. native는 아래 버튼을 눌렀을 때만 다운로드합니다.';
  const version=document.createElement('p');version.textContent=`현재 native: ${globalThis.CustomVoiceNative?.version??'연결 없음'}`;
  const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const check=document.createElement('button');check.type='button';check.textContent='native 새 버전 확인';
  const install=document.createElement('button');install.type='button';install.textContent='native 업데이트';install.disabled=true;
  element.append(heading,description,version,status,check,install);
  let disposed=false,busy=false,info,pending,timer;
  const inProgress=()=>['downloading','waiting','applying'].includes(pending?.state);
  const bridge=()=>{const value=globalThis.CustomVoiceNative;if(!value?.checkNativeUpdate||!value?.prepareNativeUpdate)throw Error('native 업데이트 버튼을 처음 사용하려면 1.1.1 이상의 전체 ZIP 설치와 Discord 완전 재시작이 필요합니다.');return value;};
  function paint(){
    if(disposed)return;
    version.textContent=`현재 native: ${info?.installedVersion??globalThis.CustomVoiceNative?.version??'연결 없음'}${info?.latestVersion?' / 최신 native: '+info.latestVersion:''}`;
    check.disabled=busy;install.disabled=busy||!info?.available||inProgress();
    install.textContent=pending?.state==='waiting'?'Discord 종료 후 적용 예정':'native 업데이트';
  }
  function showState(value){
    pending=value;if(disposed)return;
    if(value.state==='waiting')status.textContent=`native ${value.version} 다운로드 완료. Discord를 트레이에서 완전히 종료하면 자동 적용합니다. 종료 후 5초 정도 기다렸다가 다시 실행해 주세요.`;
    else if(value.state==='downloading')status.textContent='native 배포 파일을 다운로드하고 있습니다…';
    else if(value.state==='applying')status.textContent='native 업데이트를 적용하고 있습니다…';
    else if(value.state==='failed')status.textContent=value.message||'native 업데이트가 중단되었습니다. 다시 시도해 주세요.';
    else if(value.state==='installed'||value.state==='current')status.textContent=`native ${value.version}: 최신 버전입니다.`;
    paint();schedule();
  }
  function schedule(){clearTimeout(timer);if(!disposed&&inProgress())timer=setTimeout(()=>void poll(),3000);}
  async function poll(){
    if(disposed)return;
    try{showState(await bridge().nativeUpdateStatus());}
    catch(error){if(!disposed){status.textContent=error.message;schedule();}}
  }
  async function refresh(){
    if(disposed||busy)return;busy=true;paint();status.textContent='GitHub에서 native 버전을 확인하고 있습니다…';
    try{
      const result=await bridge().checkNativeUpdate();if(disposed)return;info=result;
      status.textContent=result.available?`native ${result.latestVersion} 업데이트가 있습니다.`:'native는 최신 버전입니다.';
      if(result.pending&&result.pending.state!=='idle'&&!(result.available&&['installed','current'].includes(result.pending.state)))showState(result.pending);
      else {pending=result.pending;clearTimeout(timer);}
    }catch(error){if(!disposed)status.textContent=error.message;}
    finally{busy=false;paint();}
  }
  check.addEventListener('click',()=>void refresh());
  install.addEventListener('click',async()=>{
    if(disposed||busy||!info?.available||inProgress())return;
    busy=true;paint();status.textContent='native 배포 파일을 다운로드하고 있습니다…';
    try{const value=await bridge().prepareNativeUpdate();if(!disposed)showState(value);}
    catch(error){if(!disposed){status.textContent=error.message;pending=undefined;}}
    finally{busy=false;paint();}
  });
  void refresh();
  return {element,dispose(){disposed=true;clearTimeout(timer);}};
}
