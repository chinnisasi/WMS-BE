/**
 * Node 19+ ships `http.globalAgent` with `keepAlive: true`, and supertest
 * uses the global agent. Every e2e request here targets an EPHEMERAL server
 * (`request(app.getHttpServer())` binds port 0 per call), so pooled sockets
 * outlive the servers they point at and the OS recycles those port numbers
 * across a run. Pooling connections to short-lived, recycled ports is wrong
 * here; there is no keep-alive benefit when the server is discarded anyway.
 *
 * infra-1 honesty note: this did NOT fix the intermittent cross-suite
 * failure — 2 failures in 5 fresh runs with keep-alive off. It is kept
 * because the pooling is wrong, not because it fixed anything.
 */
import http from 'node:http';
import https from 'node:https';

http.globalAgent.destroy();
https.globalAgent.destroy();
http.globalAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
https.globalAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });
