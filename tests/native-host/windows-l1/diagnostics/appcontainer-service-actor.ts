/** Fixed denial actor: no real credentials, no host imports, no emitted bytes/paths. */
export const actualServiceActor = String.raw`
const fs = require('fs'), net = require('net');
const args = process.argv.slice(2);
if (args.length !== 6) process.exit(70);
const files = args.slice(0,5), endpoint = args[5];
const attempt = fn => { try { fn(); return 'ALLOWED'; } catch(e) { return typeof e.code === 'string' ? e.code : 'UNKNOWN'; } };
const reads = files.map(f => attempt(() => fs.readFileSync(f)));
const writes = files.map(f => attempt(() => fs.writeFileSync(f,'forbidden')));
const socket = net.createConnection({path:endpoint});
let done = false;
const finish = endpointResult => {
 if(done) return; done = true; clearTimeout(timer); socket.destroy();
 const result = {ready:true,reads,writes,endpointAttempted:true,endpointResult};
 process.stdout.write(JSON.stringify(result));
 process.exitCode = [...reads,...writes,endpointResult].every(c => ['EACCES','EPERM'].includes(c)) ? 0 : 72;
};
const timer = setTimeout(() => finish('TIMEOUT'),2000);
socket.once('connect',() => finish('ALLOWED'));
socket.once('error',e => finish(typeof e.code === 'string' ? e.code : 'UNKNOWN'));
`;
