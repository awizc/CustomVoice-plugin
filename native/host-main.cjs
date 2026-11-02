'use strict';
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const prefix = 'customvoice-native-v2:';

function install({ allowTest = false } = {}) {
  const key = Symbol.for('CustomVoice.NativeHost.v2');
  if (global[key]) return;
  const sessions = new Map();
  global[key] = sessions;
  function trusted(event) {
    const url = event.senderFrame?.url ?? '';
    if (event.senderFrame !== event.sender.mainFrame || !(/^https:\/\/(?:canary\.|ptb\.)?(?:discord\.com|discordapp\.com)(?:\/|$)/.test(url) || allowTest && url.startsWith('file:')))
      throw new Error('Native capture is restricted to the Discord main window.');
  }
  function owned(event, id) {
    trusted(event);
    const session = sessions.get(id);
    if (!session || session.owner !== event.sender) throw new Error('Native capture session is closed.');
    return session;
  }
  function validate(fps, quality) {
    if (![15, 30, 60, 90, 120, 144, 165].includes(fps) || !['720p', '1080p', '1440p', 'source'].includes(quality)) throw new Error('Invalid capture profile.');
  }
  require('./audio-main.cjs').install(trusted);
  require('./github-main.cjs').install(trusted);
  ipcMain.handle(prefix + 'start', (event, sourceId, fps, quality) => {
    trusted(event); validate(fps, quality);
    if (typeof sourceId !== 'string' || !/^(screen|window):\d+:\d+$/.test(sourceId)) throw new Error('Invalid capture source.');
    for (const previous of sessions.values()) if (previous.owner === event.sender) previous.close();
    return new Promise((resolve, reject) => {
      const id = randomUUID(), owner = event.sender;
      const published = path.join(__dirname, 'CustomVoice.Capture.exe');
      const executable = fs.existsSync(published) ? published : path.join(__dirname, 'publish', 'CustomVoice.Capture.exe');
      const child = spawn(executable, [String(owner.getOSProcessId()), sourceId, String(fps), quality], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let closed = false, active = false, started = false, buffer = '', errors = '', killTimer, serial = 0;
      const requests = new Map();
      const notify = (kind, message) => { if (!owner.isDestroyed()) owner.send(prefix + kind, { ...message, session: id }); };
      const send = message => { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n'); };
      const timer = setTimeout(() => fail(new Error('Native capture startup timed out.')), 8000);
      function close(error) {
        if (closed) return;
        closed = true; clearTimeout(timer); sessions.delete(id);
        owner.off('destroyed', destroyed); owner.off('did-start-navigation', navigation);
        for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error ?? new Error('Capture stopped.')); }
        requests.clear();
        if (!started) reject(error ?? new Error('Capture cancelled.'));
        child.stdin.end();
        if (child.exitCode === null) killTimer = setTimeout(() => child.kill(), 2000);
      }
      function fail(error) { if (!closed) { notify('status', { type: 'error', message: error.message }); close(error); } }
      function destroyed() { close(new Error('Capture owner closed.')); }
      function navigation(_event, _url, isInPlace, isMainFrame) { if (isMainFrame && !isInPlace) close(new Error('Capture owner navigated.')); }
      const session = {
        owner, close, send, activate: () => { active = true; },
        setBorder(visible) {
          if (typeof visible !== 'boolean') throw new Error('Invalid capture border setting.');
          return new Promise((done, failed) => {
            const request = ++serial;
            const deadline = setTimeout(() => { requests.delete(request); failed(new Error('테두리 변경 응답이 없습니다. 방송을 다시 시작해 주세요.')); }, 30000);
            requests.set(request, { resolve: done, reject: failed, timer: deadline });
            send({ type: 'border', request, visible });
          });
        },
        configure(nextFps, nextQuality) {
          validate(nextFps, nextQuality);
          return new Promise((done, failed) => {
            const request = ++serial;
            const deadline = setTimeout(() => { requests.delete(request); failed(new Error('Native capture configuration timed out.')); }, 4000);
            requests.set(request, { resolve: done, reject: failed, timer: deadline });
            send({ type: 'configure', request, fps: nextFps, quality: nextQuality });
          });
        }
      };
      sessions.set(id, session);
      owner.on('destroyed', destroyed); owner.on('did-start-navigation', navigation);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (closed) return;
        try {
          buffer += chunk;
          let end;
          while (!closed && (end = buffer.indexOf('\n')) >= 0) {
            if (end > 65536) throw new Error('Invalid capture helper output.');
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.type === 'ready') {
              if (message.protocol !== 1 || message.intervalMs > 1.1) throw new Error('Unsupported native capture protocol.');
              clearTimeout(timer); started = true; resolve({ ...message, session: id, hostVersion: '1.1.5', hostAdaptivePacing: true, hostBorderControl: true });
            } else if (message.type === 'frame') {
              if (active) notify('frame', message);
              else send({ type: 'release', slot: message.slot, sequence: message.sequence });
            } else if (message.type === 'configured' || message.type === 'border') {
              const pending = requests.get(message.request);
              if (pending) { clearTimeout(pending.timer); requests.delete(message.request); pending.resolve(message); }
            } else if (message.type === 'error') fail(new Error(message.message));
            else notify('status', message);
          }
          if (!closed && buffer.length > 65536) throw new Error('Invalid capture helper output.');
        } catch (error) { fail(error); }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2048); });
      child.stdin.on('error', error => { if (!closed) fail(error); });
      child.on('error', fail);
      child.on('exit', code => { clearTimeout(killTimer); if (!closed) fail(new Error(`Native capture exited (${code}). ${errors}`)); });
    });
  });
  ipcMain.handle(prefix + 'activate', (event, id) => { owned(event, id).activate(); });
  ipcMain.handle(prefix + 'configure', (event, id, fps, quality) => owned(event, id).configure(fps, quality));
  ipcMain.handle(prefix + 'border', (event, id, visible) => owned(event, id).setBorder(visible));
  ipcMain.handle(prefix + 'stop', (event, id) => { trusted(event); const session = sessions.get(id); if (session?.owner === event.sender) session.close(); });
  ipcMain.on(prefix + 'pace', (event, id, fps) => {
    try { if (Number.isFinite(fps) && fps >= 1 && fps <= 165) owned(event, id).send({ type: 'pace', fps }); }
    catch { /* A late pacing update after stop is expected. */ }
  });
  ipcMain.on(prefix + 'release', (event, id, slot, sequence) => {
    try {
      if (Number.isInteger(slot) && slot >= 0 && slot < 8 && Number.isSafeInteger(sequence)) owned(event, id).send({ type: 'release', slot, sequence });
    } catch { /* A late GPU release after stop is expected. */ }
  });
}
module.exports = { install };
