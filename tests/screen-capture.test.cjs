const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the shipped plugin's adapter without loading Discord or LiveKit.
const plugin = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'), 'utf8');
const adapter = plugin.slice(
  plugin.indexOf('// src/discord/screen-capture.ts'),
  plugin.indexOf('// src/components/dialog-lifecycle.ts')
);

function mediaTrack(kind) {
  return { kind, readyState: 'live', stop() { this.readyState = 'ended'; } };
}

function mediaStream(...tracks) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    getAudioTracks: () => tracks.filter(track => track.kind === 'audio')
  };
}

function harness({ getUserMedia, sourceId = 'window:42:0', pick, bridge = true, AudioTrack, configure = async () => {} } = {}) {
  const requests = [], warnings = [], toasts = [];
  class LocalTrack {
    constructor(track) { this.mediaStreamTrack = track; this.kind = track.kind; }
    stop() { this.mediaStreamTrack.stop(); }
  }
  const context = vm.createContext({
    DOMException,
    fixScreenCapture: configure,
    console: { warn: (...args) => warnings.push(args) },
    customVoiceLog: (_level, ...args) => warnings.push(args),
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      requests.push(constraints);
      return getUserMedia(constraints, requests.length);
    } } },
    DiscordNative: bridge ? { desktopCapture: {
      getDesktopCaptureSources: async () => [{ id: sourceId, name: 'Selected source' }]
    } } : undefined,
    BdApi: { UI: { showToast: (...args) => toasts.push(args) } },
    LocalVideoTrack: LocalTrack,
    LocalAudioTrack: AudioTrack ?? LocalTrack,
    Track: { Source: { ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' } }
  });
  vm.runInContext(adapter, context);
  const capture = context.discordScreenCapture(pick ?? (async () => sourceId));
  const controller = new AbortController();
  const start = (audio = false, nativeCapture = () => assert.fail('Unexpected native fallback')) =>
    capture({ audio, resolution: { width: 1920, height: 1080, frameRate: 60 } }, nativeCapture, controller.signal);
  return { start, capture, controller, requests, warnings, toasts };
}

for (const sourceId of ['window:42:0', 'screen:7:0']) {
  test(`${sourceId}: captures selected video separately from system loopback audio`, async () => {
    const video = mediaTrack('video'), dummyVideo = mediaTrack('video'), audio = mediaTrack('audio');
    const h = harness({ sourceId, getUserMedia: async constraints => {
      if (constraints.audio && constraints.video.mandatory.chromeMediaSourceId)
        throw new DOMException('Could not start video source', 'NotReadableError');
      return constraints.audio ? mediaStream(dummyVideo, audio) : mediaStream(video);
    } });
    const tracks = await h.start(true);
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].mediaStreamTrack, video);
    assert.equal(tracks[0].source, 'screen_share');
    assert.equal(tracks[1].mediaStreamTrack, audio);
    assert.equal(tracks[1].source, 'screen_share_audio');
    assert.equal(h.requests[0].audio, false);
    assert.equal(h.requests[0].video.mandatory.chromeMediaSourceId, sourceId);
    assert.equal(h.requests[1].video.mandatory.chromeMediaSourceId, undefined);
    assert.equal(h.requests[1].video.mandatory.maxFrameRate, 1);
    assert.equal(h.requests[1].video.mandatory.maxWidth, 16);
    assert.equal(h.requests[1].video.mandatory.maxHeight, 16);
    assert.equal(dummyVideo.readyState, 'ended');
    assert.equal(video.readyState, 'live');
    assert.equal(audio.readyState, 'live');
  });
}

test('retries a video startup failure once without imposing an initial frame rate', async () => {
  const video = mediaTrack('video');
  const h = harness({ getUserMedia: async (_, attempt) => {
    if (attempt === 1) throw new DOMException('Could not start video source', 'NotReadableError');
    return mediaStream(video);
  } });
  const tracks = await h.start();
  assert.equal(tracks[0].mediaStreamTrack, video);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].video.mandatory.maxFrameRate, 60);
  assert.equal(h.requests[1].video.mandatory.maxFrameRate, undefined);
  assert.equal(h.requests[1].video.mandatory.chromeMediaSourceId, 'window:42:0');
  assert.equal(h.requests[1].audio, false);
});

test('persistent capture failure keeps the cause and explains normal-privilege restart', async () => {
  const cause = new DOMException('Could not start video source', 'NotReadableError');
  const h = harness({ getUserMedia: async () => { throw cause; } });
  await assert.rejects(h.start(true), error => error.cause === cause && /일반 권한/.test(error.message));
  assert.equal(h.requests.length, 2);
  await assert.rejects(h.capture.captureAudio(h.controller.signal));
  assert.equal(h.requests.length, 2, 'Failed video must not leave a selected audio session');
});

for (const name of ['NotAllowedError', 'AbortError']) {
  test(`${name} is propagated without retry or audio capture`, async () => {
    const cause = new DOMException('Capture rejected', name);
    const h = harness({ getUserMedia: async () => { throw cause; } });
    await assert.rejects(h.start(true), error => error === cause);
    assert.equal(h.requests.length, 1);
  });
}

test('system audio failure preserves video and visibly reports video-only sharing', async () => {
  const video = mediaTrack('video');
  const h = harness({ getUserMedia: async constraints => {
    if (constraints.audio) throw new DOMException('Could not start audio source', 'NotReadableError');
    return mediaStream(video);
  } });
  const tracks = await h.start(true);
  assert.equal(tracks.length, 1);
  assert.equal(video.readyState, 'live');
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0][0], /화면만 공유/);
});

test('turning on audio after video started does not recapture the selected window', async () => {
  const video = mediaTrack('video'), dummyVideo = mediaTrack('video'), audio = mediaTrack('audio');
  const h = harness({ getUserMedia: async constraints => constraints.audio ? mediaStream(dummyVideo, audio) : mediaStream(video) });
  await h.start(false);
  assert.equal(h.requests.length, 1);
  const tracks = await h.capture.captureAudio(h.controller.signal);
  assert.equal(tracks[0].mediaStreamTrack, audio);
  assert.equal(h.requests[1].video.mandatory.chromeMediaSourceId, undefined);
  assert.equal(video.readyState, 'live');
  assert.equal(dummyVideo.readyState, 'ended');
});

test('cancelling during video acquisition stops a late stream', async () => {
  const video = mediaTrack('video');
  const h = harness({ getUserMedia: async () => {
    h.controller.abort();
    return mediaStream(video);
  } });
  await assert.rejects(h.start(true), { name: 'AbortError' });
  assert.equal(video.readyState, 'ended');
  assert.equal(h.requests.length, 1);
});

test('cancelling a failed acquisition prevents its retry', async () => {
  const h = harness({ getUserMedia: async () => {
    h.controller.abort();
    throw new DOMException('Could not start video source', 'NotReadableError');
  } });
  await assert.rejects(h.start(), { name: 'AbortError' });
  assert.equal(h.requests.length, 1);
});

test('cancelling during loopback acquisition cleans up both streams', async () => {
  const video = mediaTrack('video'), dummyVideo = mediaTrack('video'), audio = mediaTrack('audio');
  const h = harness({ getUserMedia: async constraints => {
    if (!constraints.audio) return mediaStream(video);
    h.controller.abort();
    return mediaStream(dummyVideo, audio);
  } });
  await assert.rejects(h.start(true), { name: 'AbortError' });
  for (const track of [video, dummyVideo, audio]) assert.equal(track.readyState, 'ended');
  assert.equal(h.toasts.length, 0);
});

test('a loopback stream with no audio stops its temporary video', async () => {
  const video = mediaTrack('video'), dummyVideo = mediaTrack('video');
  const h = harness({ getUserMedia: async constraints => constraints.audio ? mediaStream(dummyVideo) : mediaStream(video) });
  const tracks = await h.start(true);
  assert.equal(tracks.length, 1);
  assert.equal(dummyVideo.readyState, 'ended');
  assert.equal(h.toasts.length, 1);
});

test('failure constructing audio wrappers stops every raw loopback track', async () => {
  const video = mediaTrack('video'), dummyVideo = mediaTrack('video'), audio = mediaTrack('audio');
  const h = harness({
    AudioTrack: class { constructor() { throw new Error('Cannot wrap audio'); } },
    getUserMedia: async constraints => constraints.audio ? mediaStream(dummyVideo, audio) : mediaStream(video)
  });
  const tracks = await h.start(true);
  assert.equal(tracks.length, 1);
  assert.equal(dummyVideo.readyState, 'ended');
  assert.equal(audio.readyState, 'ended');
});

test('missing video cleans up the stream and never acquires system audio', async () => {
  const unexpectedAudio = mediaTrack('audio');
  const h = harness({ getUserMedia: async () => mediaStream(unexpectedAudio) });
  await assert.rejects(h.start(true));
  assert.equal(unexpectedAudio.readyState, 'ended');
  assert.equal(h.requests.length, 1);
});

test('cancelled selection never opens a capture device', async () => {
  const h = harness({ pick: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
  await assert.rejects(h.start(), { name: 'AbortError' });
  assert.equal(h.requests.length, 0);
});

test('browser fallback still uses the native source picker', async () => {
  const h = harness({ bridge: false });
  const expected = [{ kind: 'video' }];
  assert.equal(await h.start(false, async () => expected), expected);
  assert.equal(h.requests.length, 0);
});

test('loopback retries incompatible lightweight constraints without disturbing shared video', async () => {
  const video = mediaTrack('video'), dummy = mediaTrack('video'), audio = mediaTrack('audio');
  let configured = false;
  const h = harness({
    configure: async () => { configured = true; },
    getUserMedia: async constraints => {
      if (!constraints.audio) return mediaStream(video);
      assert.equal(configured, true, 'Native video profile must be applied before opening audio');
      if (constraints.video.mandatory.maxWidth) throw new DOMException('Unsupported size', 'OverconstrainedError');
      return mediaStream(dummy, audio);
    }
  });
  assert.equal((await h.start(true)).length, 2);
  assert.equal(h.requests.length, 3);
  assert.equal(video.readyState, 'live');
  assert.equal(dummy.readyState, 'ended');
});

test('capture profile failure releases raw video before audio is opened', async () => {
  const video = mediaTrack('video');
  const h = harness({ getUserMedia: async () => mediaStream(video), configure: async () => { throw new Error('Bad profile'); } });
  await assert.rejects(h.start(true), /Bad profile/);
  assert.equal(video.readyState, 'ended');
  assert.equal(h.requests.length, 1);
});
