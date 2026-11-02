const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bundle = fs.readFileSync(path.join(__dirname, '../CustomVoice.plugin.js'), 'utf8');
const code = bundle.slice(bundle.indexOf('// src/services/file-logger.ts'), bundle.indexOf('// src/services/screen-quality.ts'));
test('file logging appends with BetterDiscord-supported APIs, redacts credentials and flushes once', () => {
  const files = new Map(), timers = new Set(); let writes = 0;
  const mock = { mkdirSync() {}, existsSync: p => files.has(p), statSync: p => ({size: files.get(p).length}),
    writeFileSync(p, data, options) { assert.equal(options.flag, 'a'); files.set(p, (files.get(p) || '') + data); writes++; }
  };
  const context = vm.createContext({ console, require: id => id === 'fs' ? mock : path,
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) });
  vm.runInContext(code, context);
  const logger = context.createCustomVoiceFileLogger({Plugins:{folder:'/plugins'}});
  logger.write('info', ['[CustomVoice] Started', {target:144, token:'secret-value'}]);
  logger.write('warn', [new Error('Bearer secret-access-token')]);
  assert.equal(writes, 0); assert.equal(timers.size, 1);
  logger.flush(); assert.equal(writes, 1); assert.equal(timers.size, 0);
  logger.write('error', ['[CustomVoice] Failure']); assert.equal(writes, 2);
  const [file, text] = [...files.entries()][0];
  assert.ok(file.includes(path.join('logs','CustomVoice')));
  assert.match(text, /Started/); assert.match(text, /Failure/); assert.match(text, /\[redacted\]/);
  assert.ok(!text.includes('secret-value')); assert.ok(!text.includes('secret-access-token'));
  logger.flush(); assert.equal(writes, 2);
});
