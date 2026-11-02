'use strict';
const {randomUUID} = require('node:crypto');

// Framework-neutral reference for the existing authenticated backend.
// All callbacks are server-owned. No room/owner identity comes from request JSON.
// One service instance per deployment; replace the lock/map with a shared
// transaction + lease store before using multiple backend workers.
function createNativeScreenService({resolveVoiceSession, issueToken, writeBindings, removeParticipant, now = Date.now}) {
  const sessions = new Map(), queues = new Map();
  const serial = (room, action) => {
    const before = queues.get(room) ?? Promise.resolve();
    const work = before.catch(() => {}).then(action);
    queues.set(room, work);
    return work.finally(() => { if (queues.get(room) === work) queues.delete(room); });
  };
  const bindings = room => [...sessions.values()].filter(s => s.room === room).map(s => ({owner:s.owner,publisher:s.identity,session:s.session}));
  const sync = room => writeBindings(room, {version:1, bindings:bindings(room)});
  async function voice(context) {
    const value = await resolveVoiceSession(context);
    if (!value?.room || !value?.identity || !value.canScreenShare || !value.url?.startsWith('wss://')) throw Object.assign(Error('Screen sharing is not authorized'), {status:403});
    return value;
  }
  async function remove(session) {
    // Keep the record on failure so sweep can retry removal; never silently
    // leave an orphan participant publishing after owner authorization ends.
    await removeParticipant(session.room, session.identity);
    sessions.delete(session.session);
    try { await sync(session.room); }
    catch (error) { sessions.set(session.session, {...session, expires:0}); throw error; }
  }
  return {
    async create(context) {
      const current = await voice(context);
      return serial(current.room, async () => {
        const verified = await voice(context);
        if (verified.room !== current.room || verified.identity !== current.identity) throw Object.assign(Error('Voice session changed'),{status:409});
        for (const previous of sessions.values()) if (previous.room === current.room && previous.owner === current.identity) await remove(previous);
        const session = randomUUID(), identity = 'cv-screen:' + session;
        const record = {session,identity,owner:current.identity,room:current.room,expires:now()+90000};
        // LiveKit AccessToken signer stays exclusively on the backend.
        const token = await issueToken({identity,room:current.room,ttlSeconds:600,grant:{roomJoin:true,room:current.room,canPublish:true,canSubscribe:false,canPublishData:false,canUpdateOwnMetadata:false,canPublishSources:['screen_share']}});
        sessions.set(session,record);
        try { await sync(current.room); }
        catch(error) { sessions.delete(session); throw error; }
        return {version:1,session,identity,owner:current.identity,url:current.url,token,leaseSeconds:90};
      });
    },
    async renew(context,id) {
      const current = await voice(context);
      return serial(current.room, async () => {
        const record = sessions.get(id);
        if (!record || record.room !== current.room || record.owner !== current.identity || record.expires <= now()) throw Object.assign(Error('Screen session expired'),{status:404});
        record.expires = now()+90000;
        return {leaseSeconds:90};
      });
    },
    async stop(context,id) {
      const current = await voice(context);
      return serial(current.room, async () => {
        const record = sessions.get(id);
        if (!record) return;
        if (record.room !== current.room || record.owner !== current.identity) throw Object.assign(Error('Not the screen owner'),{status:403});
        await remove(record);
      });
    },
    authorizePublisher(room,identity) {
      return [...sessions.values()].some(s=>s.room===room && s.identity===identity && s.expires>now());
    },
    async revokeOwner(room,owner) {
      return serial(room,async()=>{for (const record of [...sessions.values()]) if(record.room===room && record.owner===owner) await remove(record);});
    },
    async sweep() {
      const expired = [...sessions.values()].filter(record=>record.expires<=now());
      await Promise.all(expired.map(record=>serial(record.room,async()=>{const current=sessions.get(record.session);if(current && current.expires<=now())await remove(current);})));
    }
  };
}
module.exports = {createNativeScreenService};
