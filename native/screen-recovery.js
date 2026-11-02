// Receiver progress is independent of the broadcaster's outbound FPS.
function createRemoteScreenRecovery(recover, now = () => Date.now()) {
  let previous, rendered, decodedAt = now(), renderedAt = decodedAt, incoming = 0;
  let pending = false, nextAttempt = 0, disposed = false;
  function reset() { previous = undefined; rendered = undefined; incoming = 0; decodedAt = renderedAt = now(); }
  return {
    reset,
    observe(stats, { active = true, renderedFrames, muted = false } = {}) {
      if (disposed) return;
      const time = now(), sample = stats?.sample;
      if (!active) { reset(); return; }
      if (sample && (!previous || previous.id !== sample.id || sample.frames < previous.frames)) {
        previous = sample; decodedAt = renderedAt = time; incoming = 0;
      } else if (sample && sample.timestamp > previous.timestamp) {
        if (sample.frames > previous.frames) { decodedAt = time; incoming = 0; }
        else if (Number.isFinite(sample.bytes) && Number.isFinite(previous.bytes)) incoming += Math.max(0, sample.bytes - previous.bytes);
        previous = sample;
      }
      if (Number.isFinite(renderedFrames) && renderedFrames !== rendered) { rendered = renderedFrames; renderedAt = time; }
      // A static stream with no incoming packets is not a decoder failure.
      const decodeStalled = time - decodedAt >= 8000 && (incoming > 0 || muted || previous?.frames === 0);
      const renderStalled = Number.isFinite(renderedFrames) && time - renderedAt >= 8000 && time - decodedAt < 4000;
      if (pending || time < nextAttempt || !decodeStalled && !renderStalled) return;
      const details = { reason: decodeStalled ? 'decode-stalled' : 'playback-stalled', framesDecoded: previous?.frames, bytesWhileStalled: incoming };
      pending = true; nextAttempt = time + 15000; decodedAt = renderedAt = time; incoming = 0;
      void Promise.resolve().then(() => { if (!disposed) return recover(details); }).catch(() => {}).finally(() => { pending = false; });
    },
    dispose() { disposed = true; }
  };
}
