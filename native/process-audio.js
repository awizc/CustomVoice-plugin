'use strict';
function createProcessAudioModule(){
  const sessions=new Set();
  const processor=`class CVProcessAudio extends AudioWorkletProcessor {
    constructor(){super();this.left=new Float32Array(16384);this.right=new Float32Array(16384);this.read=0;this.write=0;this.count=0;this.started=false;this.ready=false;this.input=0;this.played=0;this.nonzero=0;this.underruns=0;this.elapsed=0;
      this.port.onmessage=event=>{const {pcm,sequence}=event.data||{};
        try{if(!pcm||pcm.byteLength%4||pcm.byteLength>19200)throw Error('Invalid process audio packet');const view=new DataView(pcm);
          for(let i=0;i<pcm.byteLength;i+=4){this.left[this.write]=view.getInt16(i,true)/32768;this.right[this.write]=view.getInt16(i+2,true)/32768;this.write=(this.write+1)%16384;this.count++;}
          this.input+=pcm.byteLength/4;if(this.count>7680){this.count=4800;this.read=(this.write-this.count+16384)%16384;}
          this.port.postMessage({type:'consumed',sequence});
        }catch{this.port.postMessage({type:'error',message:'Audio packet decoding failed'});}
      };
    }
    process(_inputs,outputs){
      if(!this.ready){this.ready=true;this.port.postMessage({type:'ready'});}
      const out=outputs[0];if(!out?.length)return true;
      if(!this.started&&this.count>=960)this.started=true;
      for(let i=0;i<out[0].length;i++){
        const present=this.started&&this.count>0,l=present?this.left[this.read]:0,r=present?this.right[this.read]:0;
        out[0][i]=l;if(out[1])out[1][i]=r;
        if(present){this.read=(this.read+1)%16384;this.count--;this.played++;if(l!==0||r!==0)this.nonzero++;}else this.underruns++;
      }
      if(this.count===0)this.started=false;this.elapsed+=out[0].length;
      if(this.elapsed>=sampleRate*10){this.port.postMessage({type:'stats',inputFrames:this.input,playedFrames:this.played,nonzeroFrames:this.nonzero,underrunFrames:this.underruns,queuedFrames:this.count});this.input=this.played=this.nonzero=this.underruns=this.elapsed=0;}
      return true;
    }
  } registerProcessor('cv-process-audio',CVProcessAudio);`;
  async function start(source,signal){
    const bridge=globalThis.CustomVoiceNative;
    const log=(level,stage,details)=>{if(typeof customVoiceLog==='function')customVoiceLog(level,'[CustomVoice] Process audio '+stage,details);};
    if(!/^window:\d+:\d+$/.test(source))throw Error('앱별 소리 캡처에는 선택한 창이 필요합니다.');
    if(!bridge?.audioStart)throw Error('앱별 소리 캡처용 native가 없습니다. 송출자 PC에 최신 전체 ZIP을 설치한 뒤 Discord를 완전히 재시작해 주세요. 시스템 소리로 대체하지 않습니다.');
    if(signal.aborted)throw new DOMException('Capture cancelled','AbortError');
    const context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});
    let info,node,destination,track,silentSink,closed=false,timer,readyTimer,recoveryTimer,resuming,readyResolve,readyReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
    const origin=location.protocol==='file:'?'null':location.origin;
    const stop=()=>{
      if(closed)return;closed=true;clearTimeout(timer);clearTimeout(readyTimer);clearTimeout(recoveryTimer);readyReject(new DOMException('Capture cancelled','AbortError'));
      signal.removeEventListener('abort',stop);window.removeEventListener('message',message);context.onstatechange=null;
      if(track){track.enabled=false;MediaStreamTrack.prototype.stop.call(track);}
      if(node){node.onprocessorerror=null;node.port.onmessage=null;node.disconnect();node.port.close();}
      destination?.disconnect();silentSink?.disconnect();void context.close().catch(()=>{});
      if(info)void bridge.audioStop(info.session).catch(()=>{});sessions.delete(stop);
    };
    const fail=error=>{if(closed)return;log('warn','failed',{message:error.message});readyReject(error);stop();track?.dispatchEvent(new Event('ended'));globalThis.BdApi?.UI?.showToast?.(error.message,{type:'warning'});};
    function message(event){
      const data=event.data;
      if(event.source!==window||event.origin!==origin||!info||data?.session!==info.session||closed)return;
      if(data.type==='customvoice-process-audio-error'){fail(Error(data.error||'앱별 오디오 캡처가 중단되었습니다.'));return;}
      if(data.type==='customvoice-process-audio-status'){log('info','native',{processId:data.processId,frames:data.frames,packets:data.packets,silentFrames:data.silentFrames,droppedFrames:data.droppedFrames});return;}
      if(data.type!=='customvoice-process-audio')return;
      try{
        let pcm=data.pcm;if(ArrayBuffer.isView(pcm))pcm=pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.byteLength);
        if(Object.prototype.toString.call(pcm)!=='[object ArrayBuffer]'||!pcm.byteLength||pcm.byteLength%4||pcm.byteLength>19200)throw Error('앱별 오디오 데이터 형식이 올바르지 않습니다.');
        node.port.postMessage({pcm,sequence:data.sequence},[pcm]);
      }catch(error){fail(error);}
    }
    signal.addEventListener('abort',stop,{once:true});window.addEventListener('message',message);sessions.add(stop);
    const url=URL.createObjectURL(new Blob([processor],{type:'text/javascript'}));
    try{
      const resumed=context.resume();
      resumed.catch(()=>{});
      await context.audioWorklet.addModule(url);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      node=new AudioWorkletNode(context,'cv-process-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
      node.onprocessorerror=()=>fail(Error('앱별 오디오 처리기가 중단되었습니다. 소리 공유를 다시 켜 주세요.'));
      node.port.onmessage=event=>{
        if(closed)return;const data=event.data;
        if(data?.type==='ready'){clearTimeout(readyTimer);readyResolve();}
        else if(data?.type==='consumed'&&info)bridge.audioConsumed(info.session,data.sequence);
        else if(data?.type==='error')fail(Error(data.message));
        else if(data?.type==='stats')log('info','output',{...data,contextState:context.state});
      };
      destination=context.createMediaStreamDestination();node.connect(destination);
      // A silent output keeps the render graph pulling while WebRTC subscribes
      // to the MediaStream destination. No captured sound is played locally.
      silentSink=context.createGain();silentSink.gain.value=0;node.connect(silentSink);silentSink.connect(context.destination);
      track=destination.stream.getAudioTracks()[0];track.stop=stop;
      await Promise.race([resumed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('오디오 재생 권한을 활성화한 뒤 다시 시도해 주세요.')),5000);})]);
      clearTimeout(timer);
      readyTimer=setTimeout(()=>readyReject(Error('앱별 오디오 처리기가 시작되지 않았습니다.')),4000);
      await ready;clearTimeout(readyTimer);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      info=await bridge.audioStart(source);
      if(closed){await bridge.audioStop(info.session);throw new DOMException('Capture cancelled','AbortError');}
      if(info.sampleRate!==48000||info.channels!==2)throw Error('앱별 오디오 캡처 형식을 지원하지 않습니다.');
      context.onstatechange=()=>{
        if(closed||context.state==='running')return;
        log('warn','context',{state:context.state});
        if(context.state==='closed'){fail(Error('앱 소리 처리 연결이 종료되었습니다. 공유 대상 소리를 다시 켜 주세요.'));return;}
        if(resuming)return;
        recoveryTimer=setTimeout(()=>{if(context.state!=='running')fail(Error('앱 소리 처리가 일시 중지되었습니다. 공유 대상 소리를 다시 켜 주세요.'));},5000);
        resuming=context.resume().then(()=>{if(context.state==='running')clearTimeout(recoveryTimer);}).catch(fail).finally(()=>{resuming=undefined;});
      };
      await bridge.audioActivate(info.session,2);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      log('info','started',{processId:info.processId,windowProcessId:info.windowProcessId,scope:info.scope??'process-tree',sampleRate:info.sampleRate,nativeVersion:bridge.version});
      return track;
    }catch(error){log('warn','startup failed',{message:error.message,nativeVersion:bridge.version});stop();throw error;}finally{URL.revokeObjectURL(url);}
  }
  return {start,stopAll(){for(const stop of [...sessions])stop();}};
}
