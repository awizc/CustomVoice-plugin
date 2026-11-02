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
      if(required&&(!bridge.version||newerVersion(required,bridge.version)))throw Error('이 업데이트에는 새 native가 필요합니다. awizc/CustomVoice-plugin의 Releases에서 전체 ZIP을 설치해 주세요.');
      if(!current()||this.active())return;
      files.replace(source,previous);this.updated=true;clearTimeout(this.timer);
      this.api.UI.showToast(`CustomVoice ${local} → ${remote} 업데이트됨`,{type:'success'});
    }catch(error){
      if(current()){
        customVoiceLog('warn','[CustomVoice] Private update',error.message);
        if(notify)this.api.UI.showToast(error.message,{type:'error'});
      }
    }finally{this.busy=false;}
  }
  diskFiles(){
    const fs=require('fs'),path=require('path'),Buffer=require('buffer').Buffer,file=path.join(this.api.Plugins.folder,'CustomVoice.plugin.js');
    return {
      read:()=>fs.readFileSync(file,'utf8'),
      replace:(source,previous)=>{
        if(fs.readFileSync(file,'utf8')!==previous)throw Error('다른 작업이 플러그인 파일을 변경했습니다. 다음에 다시 업데이트합니다.');
        const backup=path.join(this.api.Plugins.folder,'..','data','CustomVoice-install-backups','auto-'+Date.now());
        fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'CustomVoice.plugin.js'),previous,'utf8');
        // In-place writes preserve the enabled state; renaming over the plugin
        // can make the file watcher treat it as a removal and disable it.
        const fd=fs.openSync(file,'r+');
        const write=code=>{const bytes=Buffer.from(code,'utf8');let offset=0;while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count===0)throw Error('Plugin write stalled');offset+=count;}fs.ftruncateSync(fd,bytes.length);fs.fsyncSync(fd);};
        try{write(source);}catch(error){write(previous);throw error;}finally{fs.closeSync(fd);}
      }
    };
  }
};
