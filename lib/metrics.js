const http = require('http');
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ── Peer supervision — trunks (role=client) and media servers (role=media) ──

const peerUp = new client.Gauge({
  name: 'siprec_peer_up',
  help: 'Peer reachability via SIP OPTIONS: 1=UP, 0=DOWN',
  labelNames: ['name', 'role', 'transport'],
  registers: [register]
});

const peerRttMs = new client.Gauge({
  name: 'siprec_peer_rtt_ms',
  help: 'Last measured SIP OPTIONS RTT in milliseconds',
  labelNames: ['name', 'role', 'transport'],
  registers: [register]
});

const peerOptionsSentTotal = new client.Counter({
  name: 'siprec_peer_options_sent_total',
  help: 'Total SIP OPTIONS requests sent per peer',
  labelNames: ['name', 'role'],
  registers: [register]
});

const peerOptionsResultTotal = new client.Counter({
  name: 'siprec_peer_options_result_total',
  help: 'SIP OPTIONS results per peer — label result: ok | timeout | error | bad_status',
  labelNames: ['name', 'role', 'transport', 'result'],
  registers: [register]
});

// ── Call metrics per client trunk ──────────────────────────────────────────

const invitesTotal = new client.Counter({
  name: 'siprec_invites_total',
  help: 'Total INVITE requests received — label type: siprec | leg2 | rejected',
  labelNames: ['client', 'type'],
  registers: [register]
});

const callsActive = new client.Gauge({
  name: 'siprec_calls_active',
  help: 'Currently active SIPREC calls per client trunk',
  labelNames: ['client'],
  registers: [register]
});

const callsTotal = new client.Counter({
  name: 'siprec_calls_total',
  help: 'Completed SIPREC calls per client — label result: success | abnormal | media_failure | cancelled',
  labelNames: ['client', 'result'],
  registers: [register]
});

const callDurationSeconds = new client.Histogram({
  name: 'siprec_call_duration_seconds',
  help: 'Duration of established SIPREC calls in seconds',
  labelNames: ['client', 'result'],
  buckets: [5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [register]
});

// ── Call metrics per media server ──────────────────────────────────────────

const mediaCallsActive = new client.Gauge({
  name: 'siprec_media_calls_active',
  help: 'Currently active calls per FreeSwitch media server',
  labelNames: ['server'],
  registers: [register]
});

const mediaCallsTotal = new client.Counter({
  name: 'siprec_media_calls_total',
  help: 'Completed calls per media server — label result: success | abnormal | media_failure',
  labelNames: ['server', 'result'],
  registers: [register]
});

const mediaCallDurationSeconds = new client.Histogram({
  name: 'siprec_media_call_duration_seconds',
  help: 'Duration of calls handled per FreeSwitch media server in seconds',
  labelNames: ['server', 'result'],
  buckets: [5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [register]
});

// ── HTTP server ────────────────────────────────────────────────────────────

function startMetricsServer(port, logger) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        const data = await register.metrics();
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(data);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    } else if (req.method === 'GET' && req.url === '/calls') {
      try {
        const [activeData, invitesData] = await Promise.all([
          callsActive.get(),
          invitesTotal.get()
        ]);

        // Aggregate per client
        const clients = new Map();
        const ensure = (name) => {
          if (!clients.has(name)) clients.set(name, { active: 0, received: 0, rejected: 0 });
          return clients.get(name);
        };
        for (const v of activeData.values)  ensure(v.labels.client).active   = v.value;
        for (const v of invitesData.values) {
          if (v.labels.type === 'siprec')   ensure(v.labels.client).received += v.value;
          if (v.labels.type === 'rejected') ensure(v.labels.client).rejected += v.value;
        }

        const pad = (s, n, r) => r ? String(s).padStart(n) : String(s).padEnd(n);
        const lines = [
          `SIPREC — Active calls  ${new Date().toISOString()}`,
          '',
          `${pad('CLIENT', 24)} ${pad('ACTIVE', 8, true)} ${pad('RECEIVED', 10, true)} ${pad('REJECTED', 10, true)}`,
          `${pad('', 24, false).replace(/ /g, '-')} ${pad('', 8, true).replace(/ /g, '-')} ${pad('', 10, true).replace(/ /g, '-')} ${pad('', 10, true).replace(/ /g, '-')}`,
        ];

        if (clients.size === 0) {
          lines.push('  (no traffic)');
        } else {
          for (const [name, s] of clients) {
            lines.push(`${pad(name, 24)} ${pad(s.active, 8, true)} ${pad(s.received, 10, true)} ${pad(s.rejected, 10, true)}`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(lines.join('\n') + '\n');
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    } else if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info({ port, endpoints: ['/metrics', '/calls', '/health', '/healthz'] }, 'Metrics HTTP server started');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Metrics server error');
  });

  return server;
}

module.exports = {
  startMetricsServer,
  peerUp, peerRttMs, peerOptionsSentTotal, peerOptionsResultTotal,
  invitesTotal, callsActive, callsTotal, callDurationSeconds,
  mediaCallsActive, mediaCallsTotal, mediaCallDurationSeconds
};
