'use strict';
const {ipcMain}=require('electron');
const {spawn}=require('child_process');
const path=require('path');
function install(trusted){
  const prefix='customvoice-native-v2:';let fetching,checking,preparing;
  function run(mode,input='',timeout=45000){
    return new Promise((resolve,reject)=>{
      const child=spawn(path.join(__dirname,'CustomVoice.Capture.exe'),[mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let output='',finished=false;
      const timer=setTimeout(()=>{child.kill();finish(Error('GitHub 요청 시간이 초과되었습니다.'));},timeout);
      function finish(error,result){if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(result);}
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>8*1024*1024){child.kill();finish(Error('GitHub response too large'));}});
      child.stderr.resume();child.on('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
      child.on('close',code=>{try{const result=JSON.parse(output.trim());if(code!==0||result.type==='error')throw Error(result.message||'GitHub helper failed');finish(null,result);}catch(error){finish(error);}});
      child.stdin.end(input);
    });
  }
  ipcMain.handle(prefix+'update-source',event=>{
    trusted(event);
    if(!fetching)fetching=run('--update-source').finally(()=>{fetching=undefined;});
    return fetching;
  });
  ipcMain.handle(prefix+'update-token',(event,token)=>{
    trusted(event);if(typeof token!=='string'||token.length>512)throw Error('Invalid GitHub token');
    return run('--store-update-token',token);
  });
  ipcMain.handle(prefix+'native-update-check',event=>{
    trusted(event);if(!checking)checking=run('--native-update-check').finally(()=>{checking=undefined;});return checking;
  });
  ipcMain.handle(prefix+'native-update-prepare',event=>{
    trusted(event);if(!preparing)preparing=run('--native-update-prepare','',330000).finally(()=>{preparing=undefined;});return preparing;
  });
  ipcMain.handle(prefix+'native-update-status',event=>{trusted(event);return run('--native-update-status');});
}
module.exports={install};
