// Isolated child-process fixture. Never included in production image.
import { createServer } from 'node:http';
const role = process.argv[2];
const pii = role === 'pii';
if (pii && (process.env.OPENAI_API_KEY || process.env.DATABASE_URL)) process.exit(2);
const token = process.env.PII_ANALYZER_TOKEN;
let detectorReadyAtSiteStart = false;
if (!pii) {
  const response = await fetch('http://127.0.0.1:8100/health', {headers:{Authorization:'Bearer '+token}});
  detectorReadyAtSiteStart = response.ok;
}
createServer((req,res) => {
  if (req.url === '/stop') {res.end('{}'); setTimeout(()=>process.exit(0),20);return;}
  if (pii && req.headers.authorization !== 'Bearer '+token) {res.writeHead(401).end('{}');return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(pii ? {status:'ready'} : {detectorReadyAtSiteStart,hasModelKey:!!process.env.OPENAI_API_KEY}));
}).listen(pii ? 8100 : Number(process.env.PORT),'127.0.0.1');
