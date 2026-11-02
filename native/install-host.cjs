'use strict';
// Register only the native capture broker and isolated preload bridge. This
// preserves Discord's executable, webPreferences and existing BetterDiscord
// code, adding only the two marked startup hooks below.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const marker = /\n\/\/ <CustomVoiceNativeHost>[\s\S]*?\/\/ <\/CustomVoiceNativeHost>\n?/g;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function patchArchive(bytes, nativeDirectory, remove = false) {
  const header = JSON.parse(bytes.toString('utf8', 16, 16 + bytes.readUInt32LE(12)));
  const offset = 8 + bytes.readUInt32LE(4);
  for (const file of ['main.js', 'preload.js']) if (!header.files?.[file]?.size) throw new Error('Unsupported BetterDiscord archive layout.');
  const chunks = []; let cursor = 0;
  function visit(files, base = '') {
    for (const [name, entry] of Object.entries(files)) {
      const relative = base + name;
      if (entry.files) { visit(entry.files, relative + '/'); continue; }
      if (entry.unpacked || entry.link) continue;
      let content = bytes.subarray(offset + Number(entry.offset), offset + Number(entry.offset) + entry.size);
      if (relative === 'main.js' || relative === 'preload.js') {
        const host = path.join(nativeDirectory, relative === 'main.js' ? 'host-main.cjs' : 'host-preload.cjs');
        const code = content.toString('utf8').replace(marker, '');
        content = Buffer.from(code + (remove ? '' : `\n// <CustomVoiceNativeHost>\n;try { require(${JSON.stringify(host)}).install(); } catch (error) { console.error('[CustomVoice] Native host initialization failed:', error); }\n// </CustomVoiceNativeHost>\n`));
        if (entry.integrity) {
          const blockSize = entry.integrity.blockSize || 4 * 1024 * 1024, blocks = [];
          for (let i = 0; i < content.length; i += blockSize) blocks.push(hash(content.subarray(i, i + blockSize)));
          entry.integrity = { algorithm: 'SHA256', hash: hash(content), blockSize, blocks };
        }
      }
      entry.offset = String(cursor); entry.size = content.length;
      chunks.push(content); cursor += content.length;
    }
  }
  visit(header.files);
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = 4 + json.length + (4 - json.length % 4) % 4;
  const prefix = Buffer.alloc(16 + json.length + (4 - json.length % 4) % 4);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(payloadSize + 4, 4);
  prefix.writeUInt32LE(payloadSize, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}
function install(archive, nativeDirectory, remove = false) {
  if (!remove) for (const name of ['host-main.cjs', 'host-preload.cjs', 'capture.js', 'CustomVoice.Capture.exe']) {
    if (!fs.existsSync(path.join(nativeDirectory, name))) throw new Error(`Required native capture file is missing: ${name}`);
  }
  const original = fs.readFileSync(archive);
  const updated = patchArchive(original, nativeDirectory, remove);
  if (original.equals(updated)) return { changed: false, archive };
  const backup = `${archive}.before-customvoice-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(archive, backup, fs.constants.COPYFILE_EXCL);
  const temporary = archive + '.customvoice-new';
  fs.writeFileSync(temporary, updated, { flag: 'wx' });
  try {
    if (hash(fs.readFileSync(archive)) !== hash(original)) throw new Error('BetterDiscord archive changed during installation.');
    fs.renameSync(temporary, archive);
  } catch (error) { fs.unlinkSync(temporary); throw error; }
  return { changed: true, archive, backup, restartRequired: true };
}
module.exports = { patchArchive, install };
if (require.main === module) {
  const remove = process.argv.includes('--remove');
  if (!remove && !process.argv.includes('--install')) throw new Error('Use --install or --remove, then fully restart Discord.');
  const archive = path.join(process.env.APPDATA, 'BetterDiscord', 'data', 'betterdiscord.asar');
  console.log(JSON.stringify(install(archive, __dirname, remove)));
}
