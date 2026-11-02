'use strict';
function createProcessAudioModule(){
  const sessions=new Set();
  const processor=`class CVProcessAudio extends AudioWorkletProcessor {
    constructor(){super();this.left=new Float32Array(8192);this.right=new Float32Array(8192);this.read=0;this.write=0;this.count=0;
      this.port.onmessage=event=>{const pcm=event.data;if(!(pcm instanceof ArrayBuffer)||pcm.byteLength%4||pcm.byteLength>3840)return;const view=new DataView(pcm);
        for(let i=0;i<pcm.byteLength;i+=4){this.left[this.write]=view.getInt16(i,true)/32768;this.right[this.write]=view.getInt16(i+2,true)/32768;this.write=(this.write+1)%8192;this.count++;}
        if(this.count>2880){this.count=1920;this.read=(this.write-this.count+8192)%8192;}
      };
    }
    process(_inputs,outputs){const out=outputs[0];if(!out?.length)return true;for(let i=0;i<out[0].length;i++){const present=this.count>0;out[0][i]=present?this.left[this.read]:0;if(out[1])out[1][i]=present?this.right[this.read]:0;if(present){this.read=(this.read+1)%8192;this.count--;}}return true;}
  } registerProcessor('cv-process-audio',CVProcessAudio);`;
  async function start(source,signal){
    const bridge=globalThis.CustomVoiceNative;
    if(!bridge?.audioStart)throw Error('애플리케이션 소리 캡처는 최신 native 설치와 Discord 완전 재시작이 필요합니다. 전체 시스템 소리는 공유하지 않았습니다.');
    if(signal.aborted)throw new DOMException('Capture cancelled','AbortError');
    const context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});
    let info,node,destination,track,closed=false,timer;
    const origin=location.protocol==='file:'?'null':location.origin;
    const stop=()=>{
      if(closed)return;closed=true;clearTimeout(timer);signal.removeEventListener('abort',stop);window.removeEventListener('message',message);
      if(track){track.enabled=false;MediaStreamTrack.prototype.stop.call(track);}
      node?.disconnect();node?.port.close();void context.close().catch(()=>{});
      if(info)void bridge.audioStop(info.session).catch(()=>{});sessions.delete(stop);
    };
    const fail=error=>{stop();track?.dispatchEvent(new Event('ended'));globalThis.BdApi?.UI?.showToast?.(error.message,{type:'warning'});};
    function message(event){
      const data=event.data;
      if(event.source!==window||event.origin!==origin||!info||data?.session!==info.session||closed)return;
      if(data.type==='customvoice-process-audio-error'){fail(Error(data.error));return;}
      if(data.type!=='customvoice-process-audio'||!(data.pcm instanceof ArrayBuffer))return;
      try{node.port.postMessage(data.pcm,[data.pcm]);bridge.audioConsumed(info.session,data.sequence);}catch(error){fail(error);}
    }
    signal.addEventListener('abort',stop,{once:true});window.addEventListener('message',message);sessions.add(stop);
    const url=URL.createObjectURL(new Blob([processor],{type:'text/javascript'}));
    try{
      const resumed=context.resume();
      resumed.catch(()=>{});
      await context.audioWorklet.addModule(url);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      node=new AudioWorkletNode(context,'cv-process-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
      destination=context.createMediaStreamDestination();node.connect(destination);
      track=destination.stream.getAudioTracks()[0];track.stop=stop;
      await Promise.race([resumed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('오디오 재생 권한을 활성화한 뒤 다시 시도해 주세요.')),5000);})]);
      clearTimeout(timer);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      info=await bridge.audioStart(source);
      if(closed){await bridge.audioStop(info.session);throw new DOMException('Capture cancelled','AbortError');}
      await bridge.audioActivate(info.session);
      if(closed)throw new DOMException('Capture cancelled','AbortError');
      return track;
    }catch(error){stop();throw error;}finally{URL.revokeObjectURL(url);}
  }
  return {start,stopAll(){for(const stop of [...sessions])stop();}};
}
