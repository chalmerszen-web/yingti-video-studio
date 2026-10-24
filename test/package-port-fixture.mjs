import http from 'node:http';
const server = http.createServer((req, res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({app:'installer-foreign-port-fixture'})); });
server.listen(3210,'127.0.0.1');
process.on('SIGTERM',()=>server.close());
