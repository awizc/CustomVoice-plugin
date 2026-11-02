'use strict';
const {ipcMain}=require('electron');
const {spawn}=require('child_process');
const {randomUUID}=require('crypto');
const path=require('path');
const prefix='customvoice-native-v2:';
function install(trusted) {
  const sessions=new Map();
  const owned=(event,id)=>{trusted(event);const s=sessions.get(id);if(!s||s.owner!==event.sender)throw Error('Audio session is closed');return s;};
  ipcMain.handle(prefix+'audio-start',(event,source)=>{
    trusted(event);
    if(typeof source!=='string'||!/^window:\d+:\d+$/.test(source))throw Error('Select an application window for process audio.');
    for(const session of sessions.values())if(session.owner===event.sender)session.close();
    return new Promise((resolve,reject)=>{
      const owner=event.sender,id=randomUUID();
      const child=spawn(path.join(__dirname,'CustomVoice.Capture.exe'),['--process-audio',String(owner.getOSProcessId()),source],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let closed=false,ready=false,active=false,batch=false,buffer='',killTimer,deliveryTimer,sequence=0,inFlight=0,queuedFrames=0,droppedFrames=0;
      const pending=[];
      const notify=(type,data)=>{if(!owner.isDestroyed())owner.send(prefix+type,{...data,session:id});};
      const timer=setTimeout(()=>fail(Error('애플리케이션 소리 캡처 시작 시간이 초과되었습니다.')),10000);
      function close(error){
        if(closed)return;closed=true;clearTimeout(timer);clearTimeout(deliveryTimer);sessions.delete(id);pending.length=0;queuedFrames=0;
        owner.off('destroyed',destroyed);owner.off('did-start-navigation',navigation);
        if(!ready)reject(error||Error('Audio capture cancelled'));
        child.stdin.end();if(child.exitCode===null)killTimer=setTimeout(()=>child.kill(),2000);
      }
      function fail(error){if(closed)return;notify('audio-status',{error:error.message});close(error);}
      function destroyed(){close();}
      function navigation(_event,_url,inPlace,main){if(main&&!inPlace)close();}
      function deliver(packet){
        inFlight=++sequence;notify('audio-frame',{sequence:inFlight,frames:packet.frames,pcm:packet.pcm});
        clearTimeout(deliveryTimer);deliveryTimer=setTimeout(()=>fail(Error('앱별 오디오 전달이 멈췄습니다. 소리 공유를 다시 켜 주세요.')),5000);
      }
      function drain(){
        if(closed||inFlight||!pending.length)return;
        if(!batch){const packet=pending.shift();queuedFrames-=packet.frames;deliver(packet);return;}
        const frames=queuedFrames,pcm=Buffer.concat(pending.map(packet=>packet.pcm),frames*4);
        pending.length=0;queuedFrames=0;deliver({frames,pcm});
      }
      sessions.set(id,{owner,close,activate(transport){active=true;batch=transport===2;},consumed(serial){if(inFlight!==serial)return;clearTimeout(deliveryTimer);inFlight=0;drain();}});
      owner.on('destroyed',destroyed);owner.on('did-start-navigation',navigation);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(closed)return;
        try{
          buffer+=chunk;let end;
          while(!closed&&(end=buffer.indexOf('\n'))>=0){
            if(end>65536)throw Error('Audio packet is too large');
            const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
            const message=JSON.parse(line);
            if(message.type==='audio-ready'){ready=true;clearTimeout(timer);resolve({...message,session:id});}
            else if(message.type==='error')fail(Error(message.message));
            else if(message.type==='audio-stats')notify('audio-status',{event:'stats',processId:message.processId,frames:message.frames,packets:message.packets,silentFrames:message.silentFrames,droppedFrames});
            else if(message.type==='audio'&&active){
              if(!Number.isInteger(message.frames)||message.frames<1||message.frames>960||typeof message.pcm!=='string')throw Error('Invalid process audio packet');
              const pcm=Buffer.from(message.pcm,'base64');if(pcm.length!==message.frames*4)throw Error('Invalid process audio length');
              const packet={frames:message.frames,pcm};
              // Preserve contiguous audio samples; keep at most 100 ms queued.
              pending.push(packet);queuedFrames+=packet.frames;
              while(queuedFrames>4800&&pending.length>1){const removed=pending.shift();queuedFrames-=removed.frames;droppedFrames+=removed.frames;}
              drain();
            }
          }
          if(buffer.length>65536)throw Error('Invalid process audio response');
        }catch(error){fail(error);}
      });
      child.stderr.resume();child.stdin.on('error',error=>{if(!closed)fail(error);});
      child.on('error',fail);child.on('exit',code=>{clearTimeout(killTimer);if(!closed)fail(Error(`애플리케이션 소리 캡처가 종료되었습니다 (${code}).`));});
    });
  });
  ipcMain.handle(prefix+'audio-activate',(event,id,transport)=>owned(event,id).activate(transport));
  ipcMain.handle(prefix+'audio-stop',(event,id)=>{trusted(event);const s=sessions.get(id);if(s?.owner===event.sender)s.close();});
  ipcMain.on(prefix+'audio-consumed',(event,id,sequence)=>{try{if(Number.isSafeInteger(sequence))owned(event,id).consumed(sequence);}catch{}});
}
module.exports={install};
