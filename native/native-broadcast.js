// Only room metadata written by the server can bind a dedicated publisher to
// a voice participant. Never accept self-declared participant metadata.
function installNativeScreenBindings(client, room) {
  const originals = new Map();
  let bindings = new Map(), closed = false;
  const ownerOf = identity => bindings.get(identity)?.owner ?? identity;
  const refresh = () => {
    if (closed) return;
    const next = new Map(), owners = new Set();
    try {
      const metadata = JSON.parse(room.metadata || '{}').customVoiceNativeScreen;
      if (metadata?.version === 1 && Array.isArray(metadata.bindings) && metadata.bindings.length <= 512) {
        for (const row of metadata.bindings) {
          if (typeof row?.owner !== 'string' || typeof row.publisher !== 'string' || typeof row.session !== 'string' || row.owner.startsWith('cv-screen:') || row.owner.length > 256 || row.publisher.length > 256 || !row.publisher.startsWith('cv-screen:') || row.owner === row.publisher || owners.has(row.owner) || next.has(row.publisher)) throw Error('Invalid screen binding');
          owners.add(row.owner); next.set(row.publisher, row);
        }
      }
    } catch { next.clear(); }
    const previous = bindings;
    bindings = next;
    for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
      if (originals.has(participant)) continue;
      const original = participant.getTrackPublication;
      function get(source) {
        if (source === Track.Source.ScreenShare) {
          if (participant === room.localParticipant && room.customVoiceNativePreview) return room.customVoiceNativePreview;
          if (participant !== room.localParticipant) {
            const row = [...bindings.values()].find(row => row.owner === participant.identity);
            const publisher = row && room.remoteParticipants.get(row.publisher);
            const lookup = publisher && originals.get(publisher)?.original;
            const publication = lookup ? lookup.call(publisher, source) : publisher?.getTrackPublication(source);
            if (publication) return publication;
          }
        }
        return original.call(this, source);
      }
      originals.set(participant, {original, get}); participant.getTrackPublication = get;
    }
    for (const [participant, methods] of originals) if (participant !== room.localParticipant && room.remoteParticipants.get(participant.identity) !== participant) {
      if (participant.getTrackPublication === methods.get) participant.getTrackPublication = methods.original;
      originals.delete(participant);
    }
    for (const [id, row] of bindings) {
      const participant = room.remoteParticipants.get(id);
      participant?.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(client.watching.has(row.owner));
    }
    for (const owner of new Set([...previous.values(), ...bindings.values()].map(row => row.owner))) {
      const voice = room.remoteParticipants.get(owner);
      if (!voice || voice.getTrackPublication(Track.Source.ScreenShare)) continue;
      const timers = client.nativeScreenEndedTimers ??= new Map();
      if (!timers.has(owner)) timers.set(owner, setTimeout(() => {
        timers.delete(owner);
        if (closed || client.room !== room || room.remoteParticipants.get(owner)?.getTrackPublication(Track.Source.ScreenShare)) return;
        try { client.watchScreen(owner, false); } catch {}
        client.emit({op:'MEDIA_SCREEN_ENDED',success:true,data:{identity:owner}});
      }, 10000));
    }
    // Re-evaluate the owner's screen after metadata and track updates arrive
    // in either order. Keep the existing owner identity used by viewer rosters.
    if (client.room === room) for (const owner of room.remoteParticipants.values()) {
      if (bindings.has(owner.identity)) continue;
      const publication = owner.getTrackPublication(Track.Source.ScreenShare);
      if (publication) client.emit({op:'MEDIA_SCREEN_PUBLISHED', success:true, data:{identity:owner.identity}});
    }
  };
  room.customVoiceScreenOwner = ownerOf;
  const events = [RoomEvent.RoomMetadataChanged, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished];
  for (const event of events) room.on(event, refresh);
  refresh();
  return () => {
    closed = true;
    for (const event of events) room.off(event, refresh);
    for (const [participant, methods] of originals) if (participant.getTrackPublication === methods.get) participant.getTrackPublication = methods.original;
    delete room.customVoiceScreenOwner; delete room.customVoiceNativePreview;
  };
}

async function tryNativeScreenPublisher(client, room, video, profile, signal) {
  const capture = nativeScreenCaptures.get(video.mediaStreamTrack);
  if (client.nativeScreenCapability !== 'nvenc-v1' || !capture?.startPublisher || !globalThis.CustomVoiceNative?.startPublisher) return false;
  const current = () => client.room === room && !signal.aborted && video.mediaStreamTrack.readyState !== 'ended';
  let session;
  try {
    const credentials = await client.request('/api/v1/livekit/screen-publisher', 'POST');
    session = credentials?.session;
    if (!current()) throw new DOMException('Screen cancelled', 'AbortError');
    if (typeof session !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(session) || credentials.owner !== room.localParticipant.identity || credentials.identity === credentials.owner || !credentials.identity?.startsWith('cv-screen:')) throw Error('Invalid screen publisher identity');
    const result = await capture.startPublisher({...credentials, bitrate:profile.bitrate});
    if (!current()) throw new DOMException('Screen cancelled', 'AbortError');
    room.customVoiceNativePreview = {track:video,trackSid:result.sid,source:Track.Source.ScreenShare,isLocal:true,isMuted:false};
    video.getRTCStatsReport = async () => {
      const data = capture.metadata.publisherStats, timestamp = data?.timestamp;
      return new Map(data?.timestamp > 0 ? [['native', {id:result.sid,type:'outbound-rtp',kind:'video',timestamp,framesEncoded:data.frames,framesSent:data.sentFrames,bytesSent:data.sentBytes,totalEncodeTime:data.encodeUs/1e6,encoderImplementation:'NVENC direct',qualityLimitationReason:'none',frameWidth:video.mediaStreamTrack.getSettings().width,frameHeight:video.mediaStreamTrack.getSettings().height}]] : []);
    };
    const ended = () => {
      if (client.room !== room) return;
      room.emit?.(RoomEvent.LocalTrackUnpublished, {track:video,trackSid:result.sid,source:Track.Source.ScreenShare});
      void client.stopScreenShare().catch(() => {});
    };
    let renewing = false;
    const leaseTimer = setInterval(async () => {
      if (renewing || !current()) return; renewing = true;
      try { await client.request('/api/v1/livekit/screen-publisher/' + encodeURIComponent(session), 'PATCH'); }
      catch { if (current() && client.nativeBroadcast?.video === video) { video.mediaStreamTrack.stop(); ended(); } }
      finally { renewing = false; }
    }, 30000);
    const stop = async () => {
      clearInterval(leaseTimer);
      video.mediaStreamTrack.removeEventListener('customvoicepublishererror', fallback);
      video.mediaStreamTrack.removeEventListener('ended', ended);
      if (room.customVoiceNativePreview?.track === video) delete room.customVoiceNativePreview;
      await capture.stopPublisher().catch(() => {});
      await client.request('/api/v1/livekit/screen-publisher/' + encodeURIComponent(session), 'DELETE').catch(() => {});
      if (client.nativeBroadcast?.video === video) client.nativeBroadcast = undefined;
    };
    let fallingBack = false;
    const fallback = async () => {
      if (fallingBack || !current()) return; fallingBack = true;
      try {
        await room.localParticipant.publishTrack(video, profile.publish);
        if (!current()) { await room.localParticipant.unpublishTrack(video); return; }
        await configureScreenSender(video, profile);
        await stop();
        globalThis.BdApi?.UI?.showToast?.('NVENC 연결이 중단되어 일반 화면공유로 전환했습니다.', {type:'warning'});
      } catch (error) { await stop(); if (current()) { video.mediaStreamTrack.stop(); ended(); } }
    };
    client.nativeBroadcast = {video,stop};
    video.mediaStreamTrack.addEventListener('customvoicepublishererror', fallback);
    video.mediaStreamTrack.addEventListener('ended', ended, {once:true});
    return true;
  } catch (error) {
    await capture.stopPublisher().catch(() => {});
    if (typeof session === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(session)) await client.request('/api/v1/livekit/screen-publisher/' + encodeURIComponent(session), 'DELETE').catch(() => {});
    if (!current()) throw new DOMException('Screen cancelled', 'AbortError');
    customVoiceLog('warn', '[CustomVoice] Native publisher unavailable; using browser encoder');
    return false;
  }
}
