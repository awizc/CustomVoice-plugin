'use strict';
// This browser adapter is bundled directly into CustomVoice.plugin.js.
// BetterDiscord's external JS module loader is not used. The narrow preload bridge
// owns native process and GPU access; Electron isolation remains enabled.
const sessions = new Set();
// Preserve the requested profile, regulating work offered to a busy encoder.
function createCadenceController(target) {
  let rate = target, overloaded = 0, healthy = 0, previousTime;
  return {
    get fps() { return rate; },
    reset(next) { target = rate = next; overloaded = healthy = 0; previousTime = undefined; },
    update(stats, native = {}) {
      const timestamp = stats?.sample?.timestamp;
      if (Number.isFinite(timestamp)) {
        if (previousTime !== undefined && timestamp <= previousTime) return rate;
        previousTime = timestamp;
      }
      const sent = stats?.encodeFps, cost = stats?.processingMs;
      if (!Number.isFinite(sent) || sent < 0) return rate;
      const offered = Math.min(rate, Number.isFinite(stats.captureFps) ? Math.max(stats.captureFps, rate * 0.5) : rate);
      const busy = native.backpressureFps > rate * 0.1 || native.preImportDropFps > rate * 0.1;
      const stalled = sent === 0 && stats.captureFps > 1;
      const slowEncoder = sent < offered * 0.82 && (stalled || busy || stats.limitation === 'cpu' || Number.isFinite(cost) && cost > 1000 / offered);
      const slowCapture = native.outputOverrunFps > rate * 0.15 && native.outputFps < rate * 0.85 && native.outputWorkMs > 1000 / rate;
      const slow = slowEncoder || slowCapture;
      overloaded = slow ? overloaded + 1 : 0;
      const hardware = stats.powerEfficientEncoder === true;
      const captureReady = !Number.isFinite(native.outputWorkMs) || native.outputWorkMs < 750 / rate;
      healthy = !slow && !busy && captureReady && sent >= rate * 0.95 && (hardware || Number.isFinite(cost) && cost < 750 / rate) ? healthy + 1 : 0;
      if (overloaded >= 2) {
        const encoderCapacity = !slowEncoder ? rate : stalled ? rate * 0.5 : Math.min(sent * 1.1, !hardware && Number.isFinite(cost) && cost > 0 ? 900 / cost : rate);
        // Unlike parallel hardware encoding, this native worker is serial:
        // reserve some time when conversion/submission itself is the bottleneck.
        const capacity = Math.min(encoderCapacity, slowCapture ? 900 / native.outputWorkMs : rate);
        rate = Math.max(1, Math.min(rate * 0.85, capacity));
        overloaded = healthy = 0;
      } else if (healthy >= 3 && rate < target) {
        rate = Math.min(target, rate + Math.max(2, rate * 0.2));
        healthy = 1;
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
async function start(sourceId, fps, quality, signal, showBorder = true) {
  if (signal.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const bridge = globalThis.CustomVoiceNative;
  if (bridge?.protocol !== 2) throw new Error('네이티브 시작 연결이 로드되지 않았습니다. 설치 상태를 확인한 뒤 Discord를 완전히 종료하고 다시 실행해 주세요.');
  if (!bridge.available) throw new Error('현재 Discord에서 네이티브 GPU 프레임 연결 API를 사용할 수 없습니다.');
  if (typeof MediaStreamTrackGenerator !== 'function') throw new Error('현재 Discord에서 생성형 비디오 트랙 API를 사용할 수 없습니다.');
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
  const control = {
    track, backend: 'WGC-D3D11 GPU', get metadata() { return info; },
    get diagnostics() {
      const time = now();
      return { ...diagnostics, skippedRepeats, replacedFrames, preImportDropped, boundedDelivery, pacingFps: cadence.fps, nativePacing: nativePacing(), encoderPressured: cadence.fps < (info?.fps ?? fps) - 0.5,
        ...handoffWindow.snapshot(time), handoffAgeMs: !closed && Number.isFinite(lastDelivered) ? Math.max(0, time - lastDelivered) : undefined,
        writerPendingMs: !closed && writing ? Math.max(0, time - lastWriteStarted) : 0,
        nativeSampleAgeMs: Number.isFinite(nativeSampleAt) ? Math.max(0, time - nativeSampleAt) : undefined };
    },
    updateEncoderStats(stats) {
      if (closed) return;
      const before = cadence.fps, rate = cadence.update(stats, now() - nativeSampleAt <= 6000 ? diagnostics : undefined);
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
    if (data.type === 'customvoice-native-status-v2') {
      if (data.event === 'error') fail(new Error(data.message));
      else if (data.event === 'resized') info = { ...info, ...data };
      else if (data.event === 'stats') {
        nativeSampleAt = now();
        if (lastNativeSample && data.elapsedMs > lastNativeSample.elapsedMs) {
          const seconds = (data.elapsedMs - lastNativeSample.elapsedMs) / 1000;
          const rate = key => Number.isFinite(data[key]) && Number.isFinite(lastNativeSample[key]) && data[key] >= lastNativeSample[key] ? (data[key] - lastNativeSample[key]) / seconds : undefined;
          const attempts = rate('outputAttempts'), work = rate('outputWorkUs');
          diagnostics = { sourceFps: rate('captured'), outputFps: rate('frames'), repeatedFps: rate('repeated'), backpressureFps: rate('dropped'), conversionFps: rate('conversions'), gpuContentionsFps: rate('gpuContentions'), nativePacingFps: data.pacingFps,
            preImportDropFps: Math.max(0, preImportDropped - previousImportDropped) / seconds,
            outputWorkMs: attempts > 0 && Number.isFinite(work) ? work / attempts / 1000 : undefined, outputOverrunFps: rate('outputOverruns') };
        }
        lastNativeSample = data;
        previousImportDropped = preImportDropped;
      }
      return;
    }
    if (data.type !== 'customvoice-native-frame-v2' || !data.frame) return;
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
module.exports = { available, start, stopAll, createCadenceController };
