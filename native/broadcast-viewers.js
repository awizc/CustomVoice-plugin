// Viewers announce established subscriptions to the publisher. The publisher
// relays its roster only to those viewers; each roster is scoped to a track SID.
var BroadcastViewers = class {
  constructor(manager) {
    this.manager = manager;
    this.viewers = new Map();
    this.sent = new Map();
    this.listeners = new Set();
    this.value = [];
    this.availability = 'available';
    this.remoteLists = new Map();
    this.revision = 0;
    this.rosterRevision = 0;
    this.bindings = [];
    this.closed = false;
    this.off = watchVoiceState(manager.store, ['connection', 'sessionChannel', 'sharing', 'watching', 'mediaRevision'], () => this.sync());
    this.timer = setInterval(() => this.sync(true), 10000);
    this.sync();
  }
  topic = 'customvoice.viewers.v1';
  get = () => this.value;
  getRevision = () => this.revision;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  notify() { this.revision++; for (const listener of this.listeners) listener(); }
  getBroadcast(identity) {
    if (this.manager.store.get().connection !== 'Connected') return { ids: [], availability: 'pending' };
    if (!identity || identity === this.room?.localParticipant.identity) return { ids: this.value, availability: this.availability };
    if (this.room?.localParticipant.permissions?.canPublishData === false || this.room?.remoteParticipants.get(identity)?.permissions?.canPublishData === false)
      return { ids: [], availability: 'unavailable' };
    return this.remoteLists.get(identity)?.snapshot ?? { ids: [], availability: 'pending' };
  }
  publishList() {
    const peers = !this.closed && this.manager.store.get().sharing ? [...this.room?.remoteParticipants.values() ?? []] : [];
    const blocked = peers.filter(peer => peer.permissions?.canPublishData === false);
    const availability = blocked.length ? blocked.length === peers.length ? 'unavailable' : 'partial' : 'available';
    for (const peer of blocked) this.viewers.delete(peer.identity);
    const next = [...this.viewers.keys()].sort();
    if (availability === this.availability && next.length === this.value.length && next.every((id, i) => id === this.value[i])) return false;
    this.availability = availability;
    this.value = next;
    this.rosterRevision++;
    this.notify();
    this.sendRoster();
    return true;
  }
  sendRoster(target) {
    if (this.closed || !this.localSid || !this.manager.store.get().sharing) return;
    const recipients = target ? [target] : this.value;
    for (const id of recipients) if (this.viewers.has(id)) this.send(this.room, id, {
      type: 'viewers', sid: this.localSid, revision: this.rosterRevision, viewers: this.value, availability: this.availability
    });
  }
  refreshRemote(active) {
    let changed = false;
    const now = Date.now(), room = this.room;
    for (const [id, entry] of this.remoteLists) if (active.get(id) !== entry.sid) { this.remoteLists.delete(id); changed = true; }
    for (const [id, sid] of active) {
      let entry = this.remoteLists.get(id);
      if (!entry) {
        entry = { sid, startedAt: now, revision: -1, reportedIds: [], snapshot: { ids: [], availability: 'pending' } };
        this.remoteLists.set(id, entry); changed = true;
      }
      const blocked = room.localParticipant.permissions?.canPublishData === false || room.remoteParticipants.get(id)?.permissions?.canPublishData === false;
      if (blocked) { entry.receivedAt = undefined; entry.reportedIds = []; }
      const fresh = entry.receivedAt !== undefined && now - entry.receivedAt <= 35000;
      const availability = blocked ? 'unavailable' : fresh ? entry.reportedAvailability : now - entry.startedAt >= 15000 ? 'unconfirmed' : 'pending';
      const ids = fresh ? entry.reportedIds.filter(viewer => viewer === room.localParticipant.identity || room.remoteParticipants.has(viewer)).sort() : [];
      if (availability !== entry.snapshot.availability || ids.length !== entry.snapshot.ids.length || ids.some((viewer, i) => viewer !== entry.snapshot.ids[i])) {
        entry.snapshot = { ids, availability }; changed = true;
      }
    }
    if (changed) this.notify();
  }
  send(room, identity, payload) {
    if (!room?.remoteParticipants.has(identity)) return;
    // LiveKit silently discards data when this grant is false. A resolved
    // publishData promise only means bytes were sent, not delivered to a peer.
    if (room.localParticipant.permissions?.canPublishData === false) return;
    try {
      return Promise.resolve(room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
        reliable: true, topic: this.topic, destinationIdentities: [identity]
      })).catch(error => {
        if (!this.closed && this.room === room) customVoiceLog('warn', '[CustomVoice] Viewer presence delivery failed', { message: error.message });
      });
    } catch (error) { customVoiceLog('warn', '[CustomVoice] Viewer presence unavailable', { message: error.message }); }
  }
  detach() {
    for (const [event, listener] of this.bindings) this.room?.off(event, listener);
    this.bindings = [];
    for (const [identity, sid] of this.sent) this.send(this.room, identity, { type: 'watch', sid, watching: false });
    this.sent.clear(); this.viewers.clear(); this.localSid = undefined;
    if (this.remoteLists.size) { this.remoteLists.clear(); this.notify(); }
    this.publishList();
  }
  bind(room) {
    const on = (event, listener) => { if (event) { room.on(event, listener); this.bindings.push([event, listener]); } };
    on(RoomEvent.DataReceived, (data, participant, _kind, topic) => this.receive(room, data, participant, topic));
    this.permissionState = undefined;
    on(RoomEvent.ParticipantPermissionsChanged, () => this.sync(true));
    for (const event of [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.ParticipantConnected])
      on(event, () => this.sync());
    on(RoomEvent.ParticipantDisconnected, participant => {
      this.viewers.delete(participant.identity); this.sent.delete(participant.identity); this.sync();
    });
    on(RoomEvent.Reconnecting, () => { this.viewers.clear(); this.sent.clear(); this.remoteLists.clear(); this.publishList(); this.notify(); });
    on(RoomEvent.Reconnected, () => this.sync(true));
    on(RoomEvent.Disconnected, () => { this.detach(); this.room = undefined; });
  }
  sync(heartbeat = false) {
    if (this.closed) return;
    const state = this.manager.store.get();
    const room = ['Connected', 'Reconnecting'].includes(state.connection) ? this.manager.client.mediaRoom : undefined;
    if (room !== this.room) { this.detach(); this.room = room; if (room) this.bind(room); }
    if (!room || state.connection !== 'Connected') return;
    const canPublishData = room.localParticipant.permissions?.canPublishData;
    const blockedPeers = [...room.remoteParticipants.values()].filter(peer => peer.permissions?.canPublishData === false).length;
    const permissionState = `${canPublishData}:${blockedPeers}`;
    if (this.permissionState !== permissionState) {
      this.permissionState = permissionState;
      customVoiceLog(canPublishData === false || blockedPeers ? 'warn' : 'info', '[CustomVoice] Viewer presence permissions', { canPublishData, blockedPeers });
      this.notify();
    }
    const local = state.sharing && room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const sid = local?.track?.mediaStreamTrack?.readyState !== 'ended' ? local?.trackSid : undefined;
    if (sid !== this.localSid) { this.localSid = sid; this.viewers.clear(); this.rosterRevision++; heartbeat = true; }
    const now = Date.now();
    for (const [id, at] of this.viewers) if (!room.remoteParticipants.has(id) || now - at > 35000) this.viewers.delete(id);
    const rosterChanged = this.publishList();
    if (heartbeat && !rosterChanged) this.sendRoster();
    const active = new Map();
    for (const id of state.watching) {
      const publication = room.remoteParticipants.get(id)?.getTrackPublication(Track.Source.ScreenShare);
      if (publication?.trackSid && publication.track && publication.isSubscribed !== false && publication.track.mediaStreamTrack?.readyState !== 'ended') active.set(id, publication.trackSid);
    }
    this.refreshRemote(active);
    if (room.localParticipant.permissions?.canPublishData === false) { this.sent.clear(); return; }
    for (const [id, previous] of this.sent) if (active.get(id) !== previous) this.send(room, id, { type: 'watch', sid: previous, watching: false });
    for (const [id, targetSid] of active) if (targetSid && (heartbeat || this.sent.get(id) !== targetSid)) this.send(room, id, { type: 'watch', sid: targetSid, watching: true });
    this.sent = active;
  }
  receive(room, bytes, participant, topic) {
    if (this.closed || this.manager.store.get().connection !== 'Connected' || room !== this.room || topic !== this.topic || !participant || room.remoteParticipants.get(participant.identity) !== participant || participant.permissions?.canPublishData === false || bytes?.byteLength > 15000) return;
    let message;
    try { message = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
    if (message?.type === 'viewers') { this.receiveRoster(room, message, participant); return; }
    if (bytes.byteLength > 1024) return;
    if (message?.type !== 'watch' || typeof message.watching !== 'boolean' || !this.localSid || message.sid !== this.localSid || !this.manager.store.get().sharing) return;
    if (message.watching) this.viewers.set(participant.identity, Date.now());
    else this.viewers.delete(participant.identity);
    const changed = this.publishList();
    // A watch heartbeat also requests the latest roster, supporting rewatch,
    // startup races, and retransmission without counting previews as viewers.
    if (message.watching && !changed) this.sendRoster(participant.identity);
  }
  receiveRoster(room, message, participant) {
    const state = this.manager.store.get(), id = participant.identity;
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    const entry = this.remoteLists.get(id);
    if (state.connection !== 'Connected' || !state.watching.includes(id) || !entry || entry.sid !== message.sid || publication?.trackSid !== message.sid || !publication.track || publication.isSubscribed === false || publication.track.mediaStreamTrack?.readyState === 'ended') return;
    if (!Number.isSafeInteger(message.revision) || message.revision < 0 || message.revision < entry.revision || !['available', 'partial', 'unavailable'].includes(message.availability)) return;
    if (!Array.isArray(message.viewers) || message.viewers.length > 512 || message.viewers.some(viewer => typeof viewer !== 'string' || !viewer || viewer.length > 256) || !message.viewers.includes(room.localParticipant.identity)) return;
    entry.reportedIds = [...new Set(message.viewers)].filter(viewer => viewer !== id);
    entry.reportedAvailability = message.availability;
    entry.revision = message.revision; entry.receivedAt = Date.now();
    this.refreshRemote(new Map([...this.remoteLists].map(([identity, value]) => [identity, value.sid])));
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.off(); clearInterval(this.timer); this.detach(); this.room = undefined; this.listeners.clear();
  }
};

function BroadcastViewerList({manager, identity: broadcastIdentity}) {
  const React = BdApi.React, service = manager.viewers;
  React.useSyncExternalStore(service.subscribe, service.getRevision);
  const snapshot = React.useMemo(() => createVoiceSnapshot(manager.store, ['profiles', 'participants', 'user', 'sharing', 'watching', 'connection']), [manager]);
  const state = React.useSyncExternalStore(manager.store.subscribe, snapshot);
  const compat = React.useMemo(() => new Compatibility(BdApi), []);
  const room = manager.client.mediaRoom, self = !broadcastIdentity || broadcastIdentity === room?.localParticipant.identity;
  if (self ? !state.sharing : !state.watching.includes(broadcastIdentity)) return null;
  const { ids, availability } = service.getBroadcast(broadcastIdentity);
  const unavailable = availability === 'unavailable', partial = availability === 'partial', pending = availability === 'pending', unconfirmed = availability === 'unconfirmed';
  const label = unavailable || unconfirmed ? '시청자 확인 불가' : pending ? '시청자 확인 중…' : `${partial ? '확인된 ' : ''}시청자 ${ids.length}명`;
  return React.createElement('details', {className: 'cv-viewers'},
    React.createElement('summary', {'aria-label': `${self ? '내' : '이'} 방송 ${label}`}, label),
    React.createElement('div', {className: 'cv-viewers-list'},
      React.createElement('strong', null, '이 방송을 보는 사람'),
      ids.length ? React.createElement('ul', null, ids.map(id => {
        const participant = state.participants.find(p => p.mediaIdentity === id);
        const me = id === room?.localParticipant.identity;
        const user = participant ? identity(participant, state, manager, compat) : {name: (me ? state.user?.username || room.localParticipant.name : room?.remoteParticipants.get(id)?.name) || '사용자'};
        return React.createElement('li', {key: id}, React.createElement(Avatar, {name: user.name, url: user.avatar}), React.createElement('span', {title: user.name, dir: 'auto'}, user.name, me ? ' (나)' : ''));
      })) : !unavailable && !pending && !unconfirmed && React.createElement('p', null, '확인된 시청자가 없습니다.'),
      pending && React.createElement('p', {className: 'cv-hint'}, '방송자의 시청자 목록을 확인하고 있습니다.'),
      unconfirmed && React.createElement('p', {className: 'cv-hint'}, '시청자 목록을 받지 못했습니다. 방송자와 본인 모두 1.1.11 이상인지 확인한 뒤 다시 시청해 주세요.'),
      (unavailable || partial) && React.createElement('p', {className: 'cv-hint'}, '서버 설정으로 시청 알림이 차단되어 ' + (partial ? '일부 시청자를' : '시청자를') + ' 확인할 수 없습니다. 서버 관리자가 시청 알림을 허용한 뒤 채널에 다시 입장해 주세요.'),
      React.createElement('p', {className: 'cv-hint'}, '시청자 집계는 1.1.8 이상을 지원합니다. 시청 중인 목록 확인은 방송자와 본인 모두 1.1.11 이상이어야 합니다. 미리보기와 방송자 본인은 집계하지 않습니다.')));
}
