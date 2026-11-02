'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
async function migrate() {
  const directory = path.join(process.env.APPDATA, 'BetterDiscord', 'plugins', 'logs', 'CustomVoice');
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  for (const client of ['discord', 'discordptb', 'discordcanary']) {
    const logs = path.join(process.env.APPDATA, client, 'logs');
    if (!fs.existsSync(logs)) continue;
    for (const name of fs.readdirSync(logs).filter(name => /^renderer_js.*\.log$/i.test(name))) {
      const source = path.join(logs, name), selected = []; let record = [];
      const collect = () => {
        const text = record.join('\n');
        if (/\[CustomVoice\]|\[PluginManager\].*CustomVoice|\[CustomVoice\] Native host|customvoice-native-v2/.test(text)) selected.push(text);
        record = [];
      };
      const lines = readline.createInterface({input:fs.createReadStream(source), crlfDelay:Infinity});
      for await (const line of lines) {
        if (/^\[\d{4}-\d\d-\d\d /.test(line) && record.length) collect();
        record.push(line);
      }
      collect();
      if (!selected.length) continue;
      const content = selected.join('\n') + '\n';
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const output = `imported-${client}-${path.parse(name).name}-${sha256.slice(0,12)}.log`;
      if (!fs.existsSync(path.join(directory,output))) fs.writeFileSync(path.join(directory,output),content,{flag:'wx'});
      results.push({source,output,records:selected.length,sha256});
    }
  }
  fs.writeFileSync(path.join(directory,'migration.json'),JSON.stringify({importedAt:new Date().toISOString(),originalSharedLogsPreserved:true,files:results},null,2)+'\n');
  console.log(JSON.stringify({directory,files:results.length,records:results.reduce((sum,item)=>sum+item.records,0)}));
}
migrate().catch(error=>{console.error(error);process.exitCode=1;});
