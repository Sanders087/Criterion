import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
import {configuration} from './server.mjs';
const input=createInterface({input:process.stdin,terminal:false});
console.log('READY FOR HIDDEN CONFIGURATION');
for await (const line of input) {
  try {
    const value=JSON.parse(line);
    const keys=['CRITERION_MODE','CRITERION_GATEWAY_SECRET','CRITERION_LIVE_TERMINAL','CRITERION_SITE_ORIGIN','CRITERION_SITE_TOKEN','PORT'];
    if(Object.keys(value).length!==keys.length||keys.some(key=>typeof value[key]!=='string'||/[\r\n\s"'\\]/.test(value[key])))throw new Error('Invalid keys');
    const config=configuration(value);
    if(config.mode!=='live'||config.port!==8789)throw new Error('Invalid live configuration');
    writeFileSync('/root/criterion-live-staging/gateway.env',keys.map(key=>`${key}=${value[key]}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
    console.log('Live configuration saved securely');
  } catch { console.error('Configuration rejected; no credentials printed');process.exitCode=1; }
  input.close();break;
}
