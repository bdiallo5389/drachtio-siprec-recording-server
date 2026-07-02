const assert = require('assert');
const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf() ;
const logger = srf.locals.logger = pino();

// Returns the matching ACL entry { client, srcs } or null. Supports exact IP and CIDR x.x.x.x/y.
function findAclMatch(sourceIp, aclEntries) {
  const toUint32 = (ip) => ip.split('.').reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);
  const matchesSrc = (src) => {
    if (!src.includes('/')) return src === sourceIp;
    const [network, bits] = src.split('/');
    const mask = (0xFFFFFFFF << (32 - parseInt(bits, 10))) >>> 0;
    return (toUint32(sourceIp) & mask) === (toUint32(network) & mask);
  };
  return aclEntries.find((entry) => entry.srcs.some(matchesSrc)) || null;
}

const SipOptionsMonitor = require('./lib/sip-options-monitor');
const debug = require('debug')('drachtio:siprec-recording-server');

let callHandler;
let sipOptionsMonitor = null;

srf.options((req, res) => {
  const sourceIp = req.source_address;
  const via = req.msg?.headers?.via;
  const from = req.msg?.headers?.from;
  debug(
    `[receive] source_address=${req.source_address} via=${req.msg?.headers?.via} from=${req.msg?.headers?.from}`
  );
  res.send(200);
});

if (config.has('drachtio.host')) {
  logger.info(config.get('drachtio'), 'attempting inbound connection');
  srf.connect(config.get('drachtio'));
  srf
    .on('connect', (err, hp) => {
      logger.info(`inbound connection to drachtio listening on ${hp}`);
      // Start SIP OPTIONS pings
      if (!config.has('sipOptions')) {
        logger.warn("sipOptions config not found → SIP OPTIONS monitoring disabled");
      } else {
        const sipOptionsConfig = config.get('sipOptions');

        if (sipOptionsConfig.state !== 1) {
          logger.info(
            { state: sipOptionsConfig.state },
            "SIP OPTIONS monitoring disabled (state != 1)"
          );
        } else {
          logger.info("SIP OPTIONS monitoring enabled");

          if (sipOptionsMonitor) sipOptionsMonitor.stop();
          sipOptionsMonitor = new SipOptionsMonitor(
            srf,
            sipOptionsConfig,
            logger
          );

          sipOptionsMonitor.start();
        }
      }
    })
    .on('error', (err) => { logger.error(err, `Error connecting to drachtio server: ${err}`); });
}
else {
  logger.info(config.get('drachtio'), 'listening for outbound connections');
  srf.listen(config.get('drachtio'));
}

if (config.has('rtpengine')) {
  logger.info(config.get('rtpengine'), 'using rtpengine as the recorder');
  callHandler = require('./lib/rtpengine-call-handler');
  // start DTMF listener
  require('./lib/dtmf-event-handler')(logger);
  
  // we only want to deal with siprec invites (having multipart content) in this application
  srf.use('invite', (req, res, next) => {
    const ctype = req.get('Content-Type') || '';
    if (!ctype.includes('multipart/mixed')) {
      logger.info(`rejecting non-SIPREC INVITE with call-id ${req.get('Call-ID')}`);
      return res.send(488);
    }
    next();
  });

}
else if (config.has('freeswitch')) {
  logger.info(config.get('freeswitch'), 'using freeswitch as the recorder');
  callHandler = require('./lib/freeswitch-call-handler')(logger);
}
else {
  throw new Error('recorder type not specified in configuration: must be either rtpengine or freeswitch');
}

// Optional SIP source IP ACL — activate per client via "sipAcl": { "enabled": true } in local.json.
// ACL entries are defined in config/acl.json as [{ "client": "...", "srcs": ["IP or CIDR", ...] }].
// The file is watched and reloaded automatically on change — no restart needed.
if (config.has('sipAcl.enabled') && config.get('sipAcl.enabled')) {
  const fs = require('fs');
  const path = require('path');
  const chokidar = require('chokidar');
  const aclPath = path.resolve(__dirname, 'config/acl.json');

  const aclState = { entries: [] };

  const loadAcl = () => {
    try {
      aclState.entries = JSON.parse(fs.readFileSync(aclPath, 'utf8'));
      logger.info({ count: aclState.entries.length }, 'SIP source IP ACL loaded');
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to read config/acl.json — ACL entries cleared');
      aclState.entries = [];
    }
  };

  loadAcl();

  chokidar.watch(aclPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
  }).on('change', () => {
    logger.info('config/acl.json changed — reloading ACL');
    loadAcl();
  });

  srf.use('invite', (req, res, next) => {
    const srcIp = req.source_address;
    const match = findAclMatch(srcIp, aclState.entries);
    if (!match) {
      logger.warn({ srcIp }, `INVITE rejected: source IP ${srcIp} not in ACL`);
      return res.send(403);
    }
    logger.debug({ srcIp, client: match.client }, 'INVITE accepted by ACL');
    next();
  });
}

srf.invite(callHandler);

module.exports = srf;
