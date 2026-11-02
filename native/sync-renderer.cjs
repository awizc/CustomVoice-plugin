'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'CustomVoice.plugin.js');
const source = fs.readFileSync(path.join(__dirname, 'capture.js'), 'utf8').replace(/\r\n/g, '\n');
const exportLine = 'module.exports = { available, start, stopAll, createCadenceController };';
if (!source.includes(exportLine)) throw new Error('Unexpected renderer adapter export.');
const body = source.replace(exportLine, 'return { available, start, stopAll };');
const block = '// <CustomVoiceNativeRenderer>\nfunction createNativeCaptureModule() {\n' + body.split('\n').map(line => '  ' + line).join('\n') + '\n}\n// </CustomVoiceNativeRenderer>\n';
let bundle = fs.readFileSync(file, 'utf8');
if (bundle.includes('// <CustomVoiceNativeRenderer>')) bundle = bundle.replace(/\/\/ <CustomVoiceNativeRenderer>[\s\S]*?\/\/ <\/CustomVoiceNativeRenderer>\r?\n/, block);
else {
  const anchor = '// src/discord/screen-capture.ts\n';
  bundle = bundle.replace(/\r\n/g, '\n');
  if (!bundle.includes(anchor)) throw new Error('Native renderer bundle anchor is missing.');
  bundle = bundle.replace(anchor, anchor + block);
}
fs.writeFileSync(file, bundle);
require('./sync-features.cjs');
