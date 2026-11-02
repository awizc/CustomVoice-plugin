'use strict';
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const prefix = 'customvoice-native-v2:';

function install({ allowTest = false } = {}) {
  if (!/^https:\/\/(?:canary\.|ptb\.)?(?:discord\.com|discordapp\.com)(?:\/|$)/.test(location.href) && !(allowTest && location.protocol === 'file:')) return;
  const textures = sharedTexture?.subtle;
  const active = new Set();
  const audioSessions = new Set();
  const deliveries = new Map();
  let startRevision = 0;
  const targetOrigin = location.protocol === 'file:' ? '*' : location.origin;
  function status(message) {
    const { type, ...details } = message;
    window.postMessage({ ...details, type: 'customvoice-native-status-v2', event: message.event ?? type }, targetOrigin);
  }
  ipcRenderer.on(prefix+'audio-status',(_event,message)=>{if(audioSessions.has(message.session))window.postMessage({...message,type:message.event==='stats'?'customvoice-process-audio-status':'customvoice-process-audio-error'},targetOrigin);});
  ipcRenderer.on(prefix+'audio-frame',(_event,message)=>{
    if(!audioSessions.has(message.session)){ipcRenderer.send(prefix+'audio-consumed',message.session,message.sequence);return;}
    try{
      const bytes=message.pcm;
      if(!ArrayBuffer.isView(bytes)||bytes.byteLength!==message.frames*4||bytes.byteLength>19200)throw Error('Invalid audio transport packet');
      const pcm=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      window.postMessage({type:'customvoice-process-audio',session:message.session,sequence:message.sequence,pcm},targetOrigin,[pcm]);
    }catch(error){
      window.postMessage({type:'customvoice-process-audio-error',session:message.session,error:error.message},targetOrigin);
      audioSessions.delete(message.session);void ipcRenderer.invoke(prefix+'audio-stop',message.session).catch(()=>{});
    }
  });
  ipcRenderer.on(prefix + 'status', (_event, message) => { if (active.has(message.session)) status(message); });
  const releaseMessage = message => ipcRenderer.send(prefix + 'release', message.session, message.slot, message.sequence);
  function forget(id) {
    const delivery = deliveries.get(id);
    deliveries.delete(id); active.delete(id);
    if (delivery?.pending) releaseMessage(delivery.pending);
  }
  function deliver(message) {
    const release = () => ipcRenderer.send(prefix + 'release', message.session, message.slot, message.sequence);
    if (!active.has(message.session)) { release(); return; }
    const delivery = deliveries.get(message.session);
    if (delivery) delivery.inFlight = message.sequence;
    let imported, frame;
    try {
      if (message.format !== 'nv12' || !Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width < 2 || message.height < 2) throw new Error('Invalid native GPU frame.');
      const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(message.handle));
      imported = textures.importSharedTexture({
        id: `${message.session}-${message.sequence}`, pixelFormat: 'nv12',
        codedSize: { width: message.width, height: message.height },
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' },
        timestamp: message.timestamp, handle: { ntHandle: handle }
      });
      frame = imported.getVideoFrame();
      // Transfer the GPU VideoFrame across Electron's isolated-world boundary;
      // contextBridge never exposes require, process, shared handles or Node APIs.
      window.postMessage({ type: 'customvoice-native-frame-v2', session: message.session, sequence: message.sequence, revision: message.revision, preImportDropped: delivery?.dropped ?? 0, frame }, targetOrigin, [frame]);
    } catch (error) {
      forget(message.session);
      status({ session: message.session, event: 'error', message: error.message });
      void ipcRenderer.invoke(prefix + 'stop', message.session).catch(() => {});
    }
    finally {
      frame?.close();
      if (imported) imported.release(release);
      else release();
    }
  }
  ipcRenderer.on(prefix + 'frame', (_event, message) => {
    if (!active.has(message.session)) { releaseMessage(message); return; }
    const delivery = deliveries.get(message.session);
    if (delivery?.inFlight != null) {
      // Keep one latest raw handle. Superseded frames never enter Chromium's
      // GPU importer, while imported textures retain their normal release fence.
      if (delivery.pending) { releaseMessage(delivery.pending); delivery.dropped++; }
      delivery.pending = message;
      return;
    }
    deliver(message);
  });
  contextBridge.exposeInMainWorld('CustomVoiceNative', {
    protocol: 2, version: '1.1.5', available: Boolean(textures?.importSharedTexture),
    async audioStart(source){const info=await ipcRenderer.invoke(prefix+'audio-start',source);audioSessions.add(info.session);return info;},
    audioActivate:(id,transport=1)=>ipcRenderer.invoke(prefix+'audio-activate',id,transport),
    audioConsumed:(id,sequence)=>{if(audioSessions.has(id))ipcRenderer.send(prefix+'audio-consumed',id,sequence);},
    audioStop:id=>{audioSessions.delete(id);return ipcRenderer.invoke(prefix+'audio-stop',id);},
    getUpdateSource:(knownCommit='')=>ipcRenderer.invoke(prefix+'update-source',knownCommit),
    setUpdateToken:token=>ipcRenderer.invoke(prefix+'update-token',token),
    checkNativeUpdate:()=>ipcRenderer.invoke(prefix+'native-update-check'),
    prepareNativeUpdate:()=>ipcRenderer.invoke(prefix+'native-update-prepare'),
    nativeUpdateStatus:()=>ipcRenderer.invoke(prefix+'native-update-status'),
    async start(source, fps, quality) {
      if (!textures?.importSharedTexture) throw new Error('GPU texture import is unavailable in this Electron version.');
      const revision = ++startRevision;
      for (const id of [...active]) forget(id);
      const info = await ipcRenderer.invoke(prefix + 'start', source, fps, quality);
      if (revision !== startRevision) {
        void ipcRenderer.invoke(prefix + 'stop', info.session).catch(() => {});
        throw new Error('Capture startup was superseded.');
      }
      active.add(info.session); return { ...info, preloadVersion: '1.1.5' };
    },
    activate: (id, boundedDelivery = false) => {
      // Opt in so older renderer bundles remain compatible with this preload.
      if (active.has(id) && boundedDelivery === true && !deliveries.has(id)) deliveries.set(id, { inFlight: null, pending: null, dropped: 0 });
      return ipcRenderer.invoke(prefix + 'activate', id);
    },
    frameConsumed: (id, sequence) => {
      const delivery = deliveries.get(id);
      if (!delivery || delivery.inFlight !== sequence || !Number.isSafeInteger(sequence)) return;
      delivery.inFlight = null;
      const pending = delivery.pending; delivery.pending = null;
      if (pending) deliver(pending);
    },
    configure: (id, fps, quality) => ipcRenderer.invoke(prefix + 'configure', id, fps, quality),
    setBorder: (id, visible) => ipcRenderer.invoke(prefix + 'border', id, visible),
    pace: (id, fps) => { if (active.has(id) && Number.isFinite(fps) && fps >= 1 && fps <= 165) ipcRenderer.send(prefix + 'pace', id, fps); },
    stop: id => { forget(id); return ipcRenderer.invoke(prefix + 'stop', id); }
  });
}
module.exports = { install };
