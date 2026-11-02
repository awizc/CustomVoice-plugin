'use strict';
// This browser adapter is bundled directly into CustomVoice.plugin.js.
// BetterDiscord's external JS module loader is not used. The narrow preload bridge
// owns native process and GPU access; Electron isolation remains enabled.
const sessions = new Set();
// Preserve the requested profile, regulating work offered to a busy encoder.
function createCadenceController(target) {
  let rate = target, overloaded = 0, healthy = 0, previousTime, previousId, warmup = 0;
  let elapsed = 0, stableMs = 0, nextProbeAt = 0, probeBackoff = 15000, probe, ramp = 0, stableRate, adaptationGrace = 0;
  function clearFeedback() { overloaded = healthy = stableMs = 0; probe = undefined; }
  function failProbe() {
    rate = probe.from; clearFeedback();
    nextProbeAt = elapsed + probeBackoff;
    probeBackoff = Math.min(60000, probeBackoff * 2);
  }
  return {
    get fps() { return rate; },
    get diagnostics() { return { cadenceState: ramp ? 'warming' : probe ? 'probing' : elapsed < nextProbeAt ? 'cooldown' : rate < target ? 'limited' : 'target', probeWaitMs: Math.max(0, nextProbeAt - elapsed) }; },
    reset(next) { target = rate = next; clearFeedback(); warmup = ramp = elapsed = nextProbeAt = adaptationGrace = 0; stableRate = undefined; probeBackoff = 15000; previousTime = previousId = undefined; },
    recover() {
      clearFeedback(); nextProbeAt = elapsed; probeBackoff = 15000; warmup = 2; adaptationGrace = 0;
      rate = target > 60 ? Math.max(60, Math.min(target * 0.75, stableRate ?? target)) : target;
      ramp = rate < target ? 2 : 0;
    },
    update(stats, native = {}) {
      const timestamp = stats?.sample?.timestamp;
      let intervalMs = stats?.intervalMs;
      if (stats?.sample?.id !== undefined && previousId !== stats.sample.id) {
        previousId = stats.sample.id; previousTime = undefined; clearFeedback();
      }
      if (Number.isFinite(timestamp)) {
        if (previousTime !== undefined && timestamp <= previousTime) return rate;
        if (!(Number.isFinite(intervalMs) && intervalMs > 0) && previousTime !== undefined) intervalMs = timestamp - previousTime;
        previousTime = timestamp;
      }
      const sent = stats?.encodeFps, cost = stats?.processingMs;
      // Missing game frames and the low-rate placeholder are source waits,
      // not encoder overload. Discard feedback spanning a capture restart.
      if (native.sourceAvailable === false) { rate = target; clearFeedback(); ramp = 0; warmup = 2; return rate; }
      if (!Number.isFinite(sent) || sent < 0) return rate;
      if (intervalMs > 6000) { clearFeedback(); warmup = 1; return rate; }
      intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000;
      elapsed += intervalMs;
      if (warmup > 0) {
        warmup--;
        if (ramp > 0) { rate += (target - rate) / ramp; ramp--; }
        return rate;
      }
      // Counter deltas contain whole frames. Allow one frame per sampling
      // interval so a fractional low pace is not mistaken for lost throughput.
      const rounding = 1000 / intervalMs;
      const offered = Math.min(rate, Number.isFinite(stats.captureFps) ? Math.max(stats.captureFps, rate * 0.5) : rate);
      const busy = native.backpressureFps > rate * 0.1 || native.preImportDropFps > rate * 0.1;
      const networkLimited = stats.networkLimited === true || stats.limitation === 'bandwidth';
      const stalled = sent === 0 && stats.captureFps > 1;
      const slowEncoder = (sent === 0 || sent + rounding < offered * 0.82) && (busy || !networkLimited && (stalled || stats.limitation === 'cpu' || Number.isFinite(cost) && cost > 1000 / offered));
      const slowCapture = native.outputOverrunFps > rate * 0.15 && native.outputFps < rate * 0.85 && native.outputWorkMs > 1000 / rate;
      // Give WebRTC's spatial adaptation a bounded opportunity to shed pixels
      // before a second controller also restricts the input frame cadence.
      const spatialAdaptation = stats.degradationPreference === 'maintain-framerate' && stats.limitation === 'cpu' && !busy && !slowCapture && sent > 0;
      adaptationGrace = spatialAdaptation ? adaptationGrace + intervalMs : 0;
      const slow = slowCapture || slowEncoder && !(spatialAdaptation && adaptationGrace <= 6000);
      overloaded = slow ? overloaded + 1 : 0;
      // powerEfficientEncoder is not a serial/parallel guarantee. Even software
      // codecs can pipeline work, so measured throughput decides recovery.
      const captureReady = !Number.isFinite(native.outputWorkMs) || native.outputWorkMs < 750 / rate;
      const ready = sent > 0 && !slow && !busy && !networkLimited && captureReady;
      healthy = ready && sent + rounding >= rate * 0.95 ? healthy + 1 : 0;
      if (healthy >= 3) stableRate = rate;
      stableMs = ready && sent + rounding >= rate * 0.82 ? stableMs + intervalMs : 0;
      if (probe) {
        probe.samples++;
        // A failed increase returns to the last working pace. Longer retries
        // prevent a permanent bottleneck from producing a sawtooth load spike.
        const improved = ready && sent > probe.sent + Math.min(0.5, (rate - probe.from) * 0.25) && sent + rounding >= Math.min(rate * 0.95, probe.sent + (rate - probe.from) * 0.5);
        probe.good = improved ? probe.good + 1 : 0;
        if (networkLimited || overloaded >= 2 || probe.samples >= 3 && probe.good < 2) { failProbe(); return rate; }
        if (probe.good >= 2) probe = undefined;
        else return rate;
      }
      if (overloaded >= 2) {
        const encoderCapacity = !slowEncoder ? rate : sent === 0 ? rate * 0.5 : sent * 1.1;
        // Unlike parallel hardware encoding, this native worker is serial:
        // reserve some time when conversion/submission itself is the bottleneck.
        const capacity = Math.min(encoderCapacity, slowCapture ? 900 / native.outputWorkMs : rate);
        // A brief stall can skew one encode-time sample by hundreds of ms.
        // Bound each adjustment; ongoing overload still backs off every pair.
        rate = Math.max(1, rate * 0.5, Math.min(rate * 0.85, capacity));
        clearFeedback(); nextProbeAt = Math.max(nextProbeAt, elapsed + 3000);
      } else if (rate < target && elapsed >= nextProbeAt && (healthy >= 3 || stableMs >= 10000)) {
        probe = { from: rate, sent, samples: 0, good: 0 };
        rate = Math.min(target, rate + Math.max(2, rate * 0.2));
        healthy = 1; stableMs = 0;
      } else if (rate === target && healthy >= 30) {
        probeBackoff = 15000;
      }
      return rate;
    }
  };
}
function createHandoffWindow() {
  const buckets = Array.from({ length: 10 }, () => ({ second: -1, count: 0, sum: 0, max: 0, late: 0 }));
  return {
    record(time, gap, fps) {
      const second = Math.floor(time / 1000), bucket = buckets[second % buckets.length];
      if (bucket.second !== second) { bucket.second = second; bucket.count = bucket.sum = bucket.max = bucket.late = 0; }
      bucket.count++; bucket.sum += gap; bucket.max = Math.max(bucket.max, gap);
      if (gap > Math.max(100, 3000 / fps)) bucket.late++;
    },
    snapshot(time) {
      const second = Math.floor(time / 1000);
      let count = 0, sum = 0, max = 0, late = 0;
      for (const bucket of buckets) if (bucket.second > second - buckets.length && bucket.second <= second) {
        count += bucket.count; sum += bucket.sum; max = Math.max(max, bucket.max); late += bucket.late;
      }
      return { handoffWindowMs: 10000, handoffSamples: count, handoffMaxGapMs: count ? max : undefined, handoffMeanGapMs: count ? sum / count : undefined, handoffLateCount: late };
    }
  };
}
function available() { return globalThis.CustomVoiceNative?.protocol === 2 && globalThis.CustomVoiceNative.available && typeof MediaStreamTrackGenerator === 'function'; }
async function listSources(discordCapture, signal) {
  if (signal.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const native = globalThis.CustomVoiceNative;
  const hasNativeList = typeof native?.listWindowSources === 'function';
  const [desktop, windows] = await Promise.allSettled([
    Promise.resolve().then(() => discordCapture.getDesktopCaptureSources({
      types: ['screen', 'window'], thumbnailSize: { width: 640, height: 360 }, fetchWindowIcons: true
    })).then(sources => { if (!Array.isArray(sources)) throw Error('화면 목록 응답이 올바르지 않습니다.'); return sources; }),
    Promise.resolve().then(() => hasNativeList ? native.listWindowSources() : [])
      .then(sources => { if (!Array.isArray(sources)) throw Error('창 목록 응답이 올바르지 않습니다.'); return sources; })
  ]);
  if (signal.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const result = [], keys = new Map();
  function add(source, fromNative) {
    if (typeof source?.id !== 'string' || typeof source.name !== 'string' || !source.name.trim()) return;
    const match = /^(screen|window):(\d+):(\d+)$/.exec(source.id);
    if (!match || fromNative && match[1] !== 'window' || match[1] === 'window' && BigInt(match[2]) === 0n) return;
    const key = match[1] + ':' + BigInt(match[2]);
    if (keys.has(key)) {
      if (fromNative) result[keys.get(key)].minimized = source.minimized === true;
      return;
    }
    keys.set(key, result.length);
    result.push(fromNative
      ? { id: source.id, name: source.name, minimized: source.minimized === true, nativeOnly: true }
      : { ...source });
  }
  if (desktop.status === 'fulfilled') for (const source of desktop.value) add(source, false);
  if (windows.status === 'fulfilled') for (const source of windows.value) add(source, true);
  if (typeof customVoiceLog === 'function') {
    for (const [name, outcome] of [['Discord', desktop], ['Windows', windows]])
      if (outcome.status === 'rejected') customVoiceLog('warn', '[CustomVoice] '+name+' source list failed', outcome.reason);
    customVoiceLog('info', '[CustomVoice] Share source list', {
      discord: desktop.status === 'fulfilled' ? desktop.value.length : 0,
      native: windows.status === 'fulfilled' ? windows.value.length : 0,
      addedWindows: result.filter(source => source.nativeOnly).length, total: result.length, nativeListAvailable: hasNativeList
    });
  }
  if (desktop.status === 'rejected' && !result.length) throw desktop.reason;
  return result;
}
async function start(sourceId, fps, quality, signal, showBorder = true) {
  if (signal.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const bridge = globalThis.CustomVoiceNative;
  if (bridge?.protocol !== 2) throw new Error('네이티브 시작 연결이 로드되지 않았습니다. 설치 상태를 확인한 뒤 Discord를 완전히 종료하고 다시 실행해 주세요.');
  if (!bridge.available) throw new Error('현재 Discord에서 네이티브 GPU 프레임 연결 API를 사용할 수 없습니다.');
  if (typeof MediaStreamTrackGenerator !== 'function') throw new Error('현재 Discord에서 생성형 비디오 트랙 API를 사용할 수 없습니다.');
  if (sourceId.startsWith('window:') && bridge.windowCaptureAuto !== true) throw new Error('전체 화면 자동 감지와 제목 표시줄 제외에는 native 1.1.7 이상 설치 및 Discord 완전 재시작이 필요합니다.');
  const track = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = track.writable.getWriter(), originalStop = track.stop.bind(track), originalSettings = track.getSettings.bind(track);
  let info, diagnostics, lastNativeSample, closed = false, writing = false, received = false, readyResolve, readyReject;
  let pending, writingRevision, lastWriteStarted = -Infinity, lastDelivered = -Infinity, nativeSampleAt = -Infinity, skippedRepeats = 0, replacedFrames = 0, frameTimer, pacingDisabled = false;
  let lastPaceAt = -Infinity, lastPaceRate, borderRevision = 0;
  let preImportDropped = 0, previousImportDropped = 0;
  const boundedDelivery = typeof bridge.frameConsumed === 'function';
  const cadence = createCadenceController(fps);
  const handoffWindow = createHandoffWindow();
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const nativePacing = () => info?.adaptivePacing === true && info?.hostAdaptivePacing === true && typeof bridge.pace === 'function' && !pacingDisabled;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const timer = setTimeout(() => fail(new Error('Native capture first frame timed out.')), 8000);
  function close(error) {
    if (closed) return;
    closed = true; clearTimeout(timer); clearTimeout(frameTimer); frameTimer = undefined;
    pending?.frame.close(); pending = undefined;
    window.removeEventListener('message', message); signal.removeEventListener('abort', abort);
    originalStop(); void writer.abort(error).catch(() => {});
    if (info) void bridge.stop(info.session).catch(() => {});
    readyReject(error ?? new DOMException('Capture cancelled', 'AbortError'));
    sessions.delete(control);
  }
  function fail(error) {
    const live = received && !closed;
    if (live) {
      if (typeof customVoiceLog === 'function') customVoiceLog('warn', '[CustomVoice] Native capture stopped', error);
      else console.warn('[CustomVoice] Native capture stopped', error.message);
    }
    close(error); if (live) track.dispatchEvent(new Event('ended'));
  }
  const abort = () => close(new DOMException('Capture cancelled', 'AbortError'));
  function consumed(data) {
    if (!closed && boundedDelivery && Number.isSafeInteger(data.sequence)) {
      try { bridge.frameConsumed(info.session, data.sequence); } catch (error) { fail(error); }
    }
  }
  function borderState(state) {
    info = { ...info, ...state };
    if (!closed) track.dispatchEvent(new Event('customvoiceborderchange'));
  }
  function recoverCadence() {
    cadence.recover(); lastPaceAt = -Infinity; lastPaceRate = undefined;
    lastNativeSample = undefined; diagnostics = undefined;
    clearTimeout(frameTimer); frameTimer = undefined;
    control.updateEncoderStats(); drain();
  }
  function sourceState(available) {
    if (typeof available !== 'boolean' || info.sourceAvailable === available) return;
    info = { ...info, sourceAvailable: available };
    recoverCadence();
    if (typeof customVoiceLog === 'function') customVoiceLog('info', '[CustomVoice] Capture source', { available, width: info.width, height: info.height, backend: info.backend });
  }
  const control = {
    track, get backend() { return info?.backend === 'GAME-HOOK-D3D11' ? '게임 캡처 · GPU' : info?.backend === 'GAME-HOOK-MEMORY' ? '게임 캡처 · 호환 모드' : info?.backend === 'DXGI-D3D11' ? 'DXGI-D3D11 GPU (전체 화면)' : 'WGC-D3D11 GPU'; }, get metadata() { return info; },
    get diagnostics() {
      const time = now();
      return { ...diagnostics, ...cadence.diagnostics, sourceAvailable: info?.sourceAvailable, holdingFrame: info?.holdingFrame, skippedRepeats, replacedFrames, preImportDropped, boundedDelivery, pacingFps: cadence.fps, nativePacing: nativePacing(), encoderPressured: cadence.fps < (info?.fps ?? fps) - 0.5,
        ...handoffWindow.snapshot(time), handoffAgeMs: !closed && Number.isFinite(lastDelivered) ? Math.max(0, time - lastDelivered) : undefined,
        writerPendingMs: !closed && writing ? Math.max(0, time - lastWriteStarted) : 0,
        nativeSampleAgeMs: Number.isFinite(nativeSampleAt) ? Math.max(0, time - nativeSampleAt) : undefined };
    },
    updateEncoderStats(stats) {
      if (closed || info?.publisherSid) return;
      const before = cadence.fps, rate = cadence.update(stats, { ...(now() - nativeSampleAt <= 6000 ? diagnostics : undefined), sourceAvailable: info?.sourceAvailable });
      if (nativePacing() && (lastPaceRate !== rate || now() - lastPaceAt >= 3000)) {
        try { bridge.pace(info.session, rate); lastPaceRate = rate; lastPaceAt = now(); }
        catch (error) {
          pacingDisabled = true;
          if (typeof customVoiceLog === 'function') customVoiceLog('warn', '[CustomVoice] Native pacing unavailable; using bounded renderer pacing', error);
        }
      }
      if (Math.abs(before - rate) > 0.5 && typeof customVoiceLog === 'function') customVoiceLog('info', '[CustomVoice] Capture cadence', { target: info?.fps, pacingFps: rate, native: nativePacing(), encodeFps: stats?.encodeFps, encodeMs: stats?.processingMs, outputWorkMs: diagnostics?.outputWorkMs, outputOverrunFps: diagnostics?.outputOverrunFps });
      if (frameTimer && rate > before) { clearTimeout(frameTimer); frameTimer = undefined; drain(); }
    },
    async startPublisher(credentials) {
      if (closed || !bridge.startPublisher) throw Error('Native publisher unavailable');
      const result = await bridge.startPublisher(info.session, credentials);
      if (closed) throw Error('Capture closed');
      info = { ...info, publisherSid: result.sid, publisherIdentity: result.identity };
      cadence.reset(info.fps);
      if (nativePacing()) bridge.pace(info.session, info.fps);
      return result;
    },
    async stopPublisher() { if (!closed && bridge.stopPublisher) await bridge.stopPublisher(info.session); info = {...info, publisherSid: undefined, publisherStats: undefined}; cadence.reset(info.fps); lastPaceRate = undefined; control.updateEncoderStats(); },
    async configure(nextQuality, nextFps) {
      if (closed) throw new Error('Native capture is closed.');
      if (quality === nextQuality && info.fps === nextFps) return info;
      const applied = await bridge.configure(info.session, nextFps, nextQuality);
      if (closed) throw new Error('Native capture stopped.');
      info = { ...info, ...applied }; quality = nextQuality; cadence.reset(nextFps);
      lastPaceAt = -Infinity; lastPaceRate = undefined;
      clearTimeout(frameTimer); frameTimer = undefined; drain(); return info;
    },
    async setBorder(visible) {
      if (closed) throw new DOMException('방송이 종료되었습니다.', 'AbortError');
      if (typeof visible !== 'boolean') throw new TypeError('Invalid border setting');
      const revision = ++borderRevision;
      try {
        if (!info?.borderControl || !info?.hostBorderControl || typeof bridge.setBorder !== 'function')
          throw new Error('테두리 ON/OFF를 사용하려면 최신 native 파일을 적용하고 Discord를 완전히 종료한 뒤 다시 실행해 주세요.');
        borderState({ borderStatus: 'pending', borderMessage: undefined });
        const applied = await bridge.setBorder(info.session, visible);
        if (closed || revision !== borderRevision) throw new DOMException('방송이 종료되었거나 설정이 변경되었습니다.', 'AbortError');
        borderState({ borderVisible: applied.borderVisible, borderStatus: applied.borderStatus, borderMessage: applied.message });
        if (applied.borderStatus !== 'applied') throw new Error(applied.message || 'Windows에서 테두리 변경을 적용하지 못했습니다.');
        return applied;
      } catch (error) {
        if (!closed && revision === borderRevision) borderState({ borderStatus: info?.borderStatus === 'pending' ? 'failed' : info?.borderStatus ?? 'failed', borderMessage: error.message });
        throw error;
      }
    },
    stop: () => close()
  };
  function message(event) {
    const data = event.data;
    const origin = location.protocol === 'file:' ? 'null' : location.origin;
    if (event.source !== window || event.origin !== origin || !info || data?.session !== info.session) return;
    if (typeof data.holdingFrame === 'boolean') info = { ...info, holdingFrame: data.holdingFrame };
    if (data.type === 'customvoice-native-status-v2') {
      if (data.event === 'error') fail(new Error(data.message));
      else if (data.event === 'resized') {
        const changed = info.width !== data.width || info.height !== data.height;
        info = { ...info, ...data }; if (changed) recoverCadence();
      }
      else if (data.event === 'source-state') sourceState(data.sourceAvailable);
      else if (data.event === 'capture-mode') {
        const changed = info.backend !== data.backend || info.sourceAvailable !== data.sourceAvailable;
        info = { ...info, ...data };
        if (changed) recoverCadence();
        if (typeof customVoiceLog === 'function') customVoiceLog('info', '[CustomVoice] Automatic capture mode', { backend: data.backend, windowClientOnly: info.windowClientOnly });
      } else if (data.event === 'capture-warning') {
        if (typeof customVoiceLog === 'function') customVoiceLog('warn', '[CustomVoice] Fullscreen capture', data.message);
        globalThis.BdApi?.UI?.showToast?.(data.message, { type: 'warning' });
      }
      else if (data.event === 'publisher-error') { if (!closed) track.dispatchEvent(new Event('customvoicepublishererror')); }
      else if (data.event === 'stats') {
        sourceState(data.sourceAvailable);
        if (data.publisher) info = {...info, publisherStats: data.publisher, publisherTimestamp: data.elapsedMs};
        nativeSampleAt = now();
        if (lastNativeSample && data.elapsedMs > lastNativeSample.elapsedMs) {
          const seconds = (data.elapsedMs - lastNativeSample.elapsedMs) / 1000;
          const rate = key => Number.isFinite(data[key]) && Number.isFinite(lastNativeSample[key]) && data[key] >= lastNativeSample[key] ? (data[key] - lastNativeSample[key]) / seconds : undefined;
          const attempts = rate('outputAttempts'), work = rate('outputWorkUs');
          diagnostics = { sourceFps: rate('captured'), outputFps: data.publisher && lastNativeSample.publisher ? Math.max(0, data.publisher.frames - lastNativeSample.publisher.frames) / seconds : rate('frames'), previewFps: data.publisher ? rate('frames') : undefined, repeatedFps: rate('repeated'), backpressureFps: rate('dropped'), conversionFps: rate('conversions'), gpuContentionsFps: rate('gpuContentions'), nativePacingFps: data.pacingFps, sourceAgeMs: data.sourceAgeMs, captureMode: data.backend,
            preImportDropFps: Math.max(0, preImportDropped - previousImportDropped) / seconds,
            gpuWorkMs: rate('gpuSamples') > 0 ? rate('gpuWorkUs') / rate('gpuSamples') / 1000 : undefined,
            busySlots: data.busySlots, slotHoldMs: rate('slotReleases') > 0 ? rate('slotHoldUs') / rate('slotReleases') / 1000 : undefined,
            outputWorkMs: attempts > 0 && Number.isFinite(work) ? work / attempts / 1000 : undefined, outputOverrunFps: rate('outputOverruns') };
        }
        lastNativeSample = data;
        previousImportDropped = preImportDropped;
      }
      return;
    }
    if (data.type !== 'customvoice-native-frame-v2' || !data.frame) return;
    sourceState(data.sourceAvailable);
    if (Number.isSafeInteger(data.preImportDropped)) preImportDropped = Math.max(preImportDropped, data.preImportDropped);
    const frame = data.frame;
    if (closed) { frame.close(); return; }
    const repeated = Number.isSafeInteger(data.revision) && data.revision === writingRevision;
    if (repeated && writing) { skippedRepeats++; frame.close(); consumed(data); return; }
    if (pending) { const replaced = pending; pending = undefined; replaced.frame.close(); replacedFrames++; consumed(replaced); }
    pending = data; drain();
  }
  function drain() {
    if (closed || writing || !pending || frameTimer) return;
    // Old hosts fall back to one timer and one latest frame, never a backlog.
    const delay = !nativePacing() && cadence.fps < (info?.fps ?? fps) - 0.5 ? 1000 / cadence.fps - (now() - lastWriteStarted) : 0;
    if (delay > 1) { frameTimer = setTimeout(() => { frameTimer = undefined; drain(); }, Math.ceil(delay)); return; }
    const data = pending; pending = undefined; void writeFrame(data);
  }
  async function writeFrame(data) {
    writing = true;
    writingRevision = data.revision;
    const started = now();
    lastWriteStarted = started;
    try {
      await writer.write(data.frame);
      if (!closed) {
        const delivered = now();
        if (Number.isFinite(lastDelivered)) handoffWindow.record(delivered, Math.max(0, delivered - lastDelivered), cadence.fps);
        lastDelivered = delivered;
      }
      if (!closed && !received) { received = true; clearTimeout(timer); readyResolve(control); }
    } catch (error) { fail(error); }
    finally {
      data.frame.close(); writing = false;
      consumed(data);
      drain();
    }
  }
  track.stop = () => close();
  track.getSettings = () => ({ ...originalSettings(), ...(info ? { width: info.width, height: info.height, frameRate: info.fps, displaySurface: sourceId.startsWith('window:') ? 'window' : 'monitor' } : {}) });
  track.contentHint = 'motion'; sessions.add(control);
  window.addEventListener('message', message); signal.addEventListener('abort', abort, { once: true });
  void (async () => {
    info = await bridge.start(sourceId, fps, quality);
    if (sourceId.startsWith('window:') && info.windowClientOnly !== true) throw new Error('native 파일의 버전이 섞여 있습니다. 최신 전체 ZIP을 다시 설치해 주세요.');
    if (closed || signal.aborted) { await bridge.stop(info.session); abort(); }
    else {
      await bridge.activate(info.session, boundedDelivery);
      if (!showBorder && !closed) void control.setBorder(false).catch(error => {
        if (closed) return;
        if (typeof customVoiceLog === 'function') customVoiceLog('warn', '[CustomVoice] Capture border remains visible', error);
        globalThis.BdApi?.UI?.showToast?.(error.message, { type: 'warning' });
      });
    }
  })().catch(fail);
  return ready;
}
function stopAll() { for (const session of [...sessions]) session.stop(); }
module.exports = { available, start, stopAll, createCadenceController, listSources };
