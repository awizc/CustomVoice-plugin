// Runtime observations are advisory, local and scoped to adapter/driver/browser.
// A network or capture bottleneck must never blacklist an encoder.
var screenEncoderHistory = (() => {
  let rows;
  const age = 14 * 86400000;
  const read = () => {
    if (rows) return rows;
    try { rows = globalThis.BdApi?.Data?.load('CustomVoice', 'encoderHistoryV1'); } catch {}
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter(r => typeof r?.key === 'string' && r.key.length < 1024 && Number.isFinite(r.score) && r.time > Date.now() - age && r.time <= Date.now());
    return rows;
  };
  const profile = text => /profile-level-id=([\da-f]+)/i.exec(text ?? '')?.[1]?.toLowerCase() ?? '';
  const key = (device, width, height, fps, codec, parameters) => device && JSON.stringify([
    device, globalThis.navigator?.userAgent ?? '', Math.ceil(width / 640), Math.ceil(height / 360), Math.ceil(fps / 30), codec, profile(parameters)
  ]);
  return {
    key,
    score(key) { return key ? read().find(r => r.key === key)?.score ?? 0 : 0; },
    observe(track, stats, native) {
      const selection = screenCodecSelections.get(track);
      if (!selection || !selection.device || !stats.sample || stats.intervalMs > 6000 || !(stats.intervalMs > 0) || stats.networkLimited || native?.sourceAvailable === false || native?.backpressureFps > 1 || native?.outputOverrunFps > 1 || native?.cadenceState !== 'target') return;
      if (!(stats.captureFps >= selection.fps * .9) || !(stats.encodeFps >= 0) || !stats.codec) return;
      const id = key(selection.device, selection.width, selection.height, selection.fps, stats.codec, stats.codecParameters);
      if (!id) return;
      if (selection.observedId !== id) { selection.observedId = id; selection.observedMs = 0; selection.observedSum = 0; }
      // Only full-size observations compare equal workloads.
      if (stats.width < selection.width * .95 || stats.height < selection.height * .95) return;
      selection.observedMs += stats.intervalMs;
      selection.observedSum += Math.min(1, stats.encodeFps / selection.fps) * stats.intervalMs;
      if (selection.observedMs < 30000) return;
      const ratio = selection.observedSum / selection.observedMs;
      const score = ratio >= .95 ? 2 : ratio < .8 && stats.limitation === 'cpu' ? -2 : 0;
      const values = read().filter(r => r.key !== id && r.time > Date.now() - age);
      rows = [...values, { key: id, score, time: Date.now() }].slice(-64);
      try { globalThis.BdApi?.Data?.save('CustomVoice', 'encoderHistoryV1', rows); } catch {}
      selection.observedMs = selection.observedSum = 0;
    }
  };
})();
