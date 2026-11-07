const http = require('node:http');
const { createSharedRunner } = require('./shared.js');
const { sharedEvidence } = require('./shared-evidence.js');
const server = http.createServer(createSharedRunner(sharedEvidence()));
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
