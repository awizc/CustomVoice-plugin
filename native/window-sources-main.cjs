'use strict';
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

function install(trusted) {
  let pending;
  function list() {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(__dirname, 'CustomVoice.Capture.exe'), ['--list-windows'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', finished = false;
      const timer = setTimeout(() => fail(Error('창 목록을 가져오는 시간이 초과되었습니다. 다시 시도해 주세요.')), 5000);
      function finish(error, sources) {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(sources);
      }
      function fail(error) { if (!finished) { child.kill(); finish(error); } }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (finished) return;
        output += chunk;
        if (output.length > 2 * 1024 * 1024) fail(Error('창 목록 응답이 너무 큽니다.'));
      });
      child.stderr.resume();
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (finished) return;
        try {
          const result = JSON.parse(output.trim());
          if (code !== 0 || result.type !== 'sources' || !Array.isArray(result.sources)) throw Error(result.message || '창 목록을 가져오지 못했습니다.');
          const sources = result.sources.slice(0, 256).map(source => {
            if (!/^window:[1-9]\d*:0$/.test(source?.id) || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 512) throw Error('잘못된 창 목록 응답입니다.');
            return { id: source.id, name: source.name, minimized: source.minimized === true };
          });
          finish(null, sources);
        } catch (error) { finish(error); }
      });
    });
  }
  ipcMain.handle('customvoice-native-v2:window-sources', event => {
    trusted(event);
    if (!pending) pending = list().finally(() => { pending = undefined; });
    return pending;
  });
}
module.exports = { install };
