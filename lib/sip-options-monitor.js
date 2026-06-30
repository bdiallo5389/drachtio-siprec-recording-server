const PeerManager = require('./peer-manager');
const debug = require('debug')('drachtio:siprec-recording-server');

class SipOptionsMonitor {

  constructor(srf, config, logger) {

    this.srf = srf;
    this.logger = logger;

    this.interval = config.interval;
    this.timeouts = config.timeouts;

    this.peerManager = new PeerManager('./peers/peers.json', logger);

    this.peerLoops = new Map();

  }

  start() {

    this.logger.info('Starting SIP OPTIONS monitor');

    // initial load
    this.syncPeers(this.peerManager.getPeers());

    // dynamic config update listening
    this.peerManager.on('update', (peers) => {
      this.syncPeers(peers);
    });

  }

  stop() {

    for (const [name] of [...this.peerLoops]) {
      this.stopPeer(name);
    }

    this.peerManager.removeAllListeners('update');
    this.logger.info('SIP OPTIONS monitor stopped');

  }

  // sync (add / update / remove ) a peer

  syncPeers(peers) {

    const newMap = new Map(peers.map(p => [p.name, p]));

    for (const [name, peer] of newMap) {

      const existing = this.peerLoops.get(name);
      // adding a peer
      if (!existing) {

        this.logger.info(`Peer added: ${name}`);
        this.startPeer(peer);
        continue;

      }
      // updating a peer
      if (existing.peer.host !== peer.host ||
          existing.peer.port !== peer.port ||
          existing.peer.transport !== peer.transport) {

        this.logger.info(`Peer updated: ${name}`);

        this.stopPeer(name);
        this.startPeer(peer);

      }

    }
    // Removing a peer
    for (const [name] of [...this.peerLoops]) {

      if (!newMap.has(name)) {

        this.logger.info(`Peer removed: ${name}`);
        this.stopPeer(name);

      }

    }

  }

  // Running a monitoring loop per peer
  startPeer(peer) {

    this.logger.info(`Start monitoring ${peer.name}`);

    // Register the entry immediately so stopPeer can cancel during the first sendOptions await
    this.peerLoops.set(peer.name, { timeoutId: null, peer, cancelled: false });

    const loop = async () => {

      const entry = this.peerLoops.get(peer.name);
      if (!entry || entry.cancelled) return;

      await this.sendOptions(peer);

      // Re-check after the await — peer may have been removed while sendOptions was running
      const entryAfter = this.peerLoops.get(peer.name);
      if (!entryAfter || entryAfter.cancelled) return;

      const timeoutId = setTimeout(loop, this.interval);
      this.peerLoops.set(peer.name, { timeoutId, peer, cancelled: false });

    };

    loop();

  }

  // stopping a peer monitoring loop
  stopPeer(name) {

    const entry = this.peerLoops.get(name);

    if (!entry) return;

    entry.cancelled = true;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    this.peerLoops.delete(name);

    this.logger.info(`Stopped monitoring ${name}`);

  }

  // SIPOPTIONS uri building
  buildUri(peer) {
    if (!peer || typeof peer !== 'object') {
      this.logger.error({ peer }, 'Invalid peer object');
      return null;
    }

    const { name, host, port, transport } = peer;

    if (!host) {
      this.logger.error({ peer: name, transport }, 'Missing host for peer');
      return null;
    }

    if (!port || typeof port !== 'number') {
      this.logger.error({ peer: name, ip: host, port, transport }, 'Invalid port for peer');
      return null;
    }

    if (!transport) {
      this.logger.error({ peer: name, ip: host, port }, 'Missing transport for peer');
      return null;
    }

    const normalizedTransport = transport.toLowerCase();

    const allowedTransports = ['udp', 'tcp', 'tls'];
    if (!allowedTransports.includes(normalizedTransport)) {
      this.logger.error({ peer: name, ip: host, port, transport }, 'Unsupported transport for peer');
      return null;
    }

    try {
      let uri;

      if (normalizedTransport === 'tls') {
        uri = `sips:${host}:${port}`;
        return uri;
      }

      uri = `sip:${host}:${port};transport=${normalizedTransport}`;
      return uri;

    } catch (err) {
      this.logger.error({ peer: name, ip: host, port, transport, err }, 'Error while building URI');
      return null;
    }
  }

  getTimeout(peer) {

    return this.timeouts[peer.transport] || 5000;

  }

  sendOptions(peer) {
    return new Promise((resolve) => {

      const uri = this.buildUri(peer);

      if (!uri) {
        this.logger.warn({ peer: peer.name, ip: peer.host, transport: peer.transport, peerConfig: peer }, 'Skipping OPTIONS due to invalid URI');
        return resolve();
      }

      const timeout = this.getTimeout(peer);
      const start = process.hrtime.bigint();

      let finished = false;

      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      // Timeout handling
      const timer = setTimeout(() => {
        this.logger.error({ peer: peer.name, ip: peer.host, transport: peer.transport, timeout }, 'SIP OPTIONS timeout');
        done();
      }, timeout);

      try {
        this.srf.request(
          uri,
          {
            method: 'OPTIONS',
            headers: {
              'Accept': 'application/sdp',
              'User-Agent': 'siprec-healthcheck'
            }
          },
          (err, req) => {

            if (err) {
              clearTimeout(timer);

              this.logger.error({ peer: peer.name, ip: peer.host, transport: peer.transport, error: err.message }, 'SIP OPTIONS send error');

              return done();
            }

            // SIP OPTIONS response handler
            req.on('response', (res) => {

              if (finished) return;

              clearTimeout(timer);

              const rttMs = Number(process.hrtime.bigint() - start) / 1e6;

              if (res.status !== 200) {
                this.logger.error({ peer: peer.name, ip: peer.host, transport: peer.transport, status: res.status, rtt: Math.round(rttMs) }, 'SIP OPTIONS bad status');

                return done();
              }

              this.logger.info({ peer: peer.name, ip: peer.host, transport: peer.transport, rtt: Math.round(rttMs) }, 'SIP OPTIONS ok');

              done();
            });
          }
        );
      } catch (err) {
        clearTimeout(timer);

        this.logger.error({ peer: peer.name, ip: peer.host, transport: peer.transport, uri, err }, 'Unexpected error during SIP OPTIONS request');

        done();
      }
    });
  }

}

module.exports = SipOptionsMonitor;
