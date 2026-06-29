const assert = require('assert');
const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf() ;
const logger = srf.locals.logger = pino();
const SipOptionsMonitor = require('./lib/sip-options-monitor');
const debug = require('debug')('drachtio:siprec-recording-server');

let callHandler;

srf.options((req, res) => {
  //console.log("Requête:", JSON.stringify(req, null, 2));
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

          const monitor = new SipOptionsMonitor(
            srf,
            sipOptionsConfig,
            logger
          );

          monitor.start();
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
  assert('recorder type not specified in configuration: must be either rtpengine or freeswitch');
}

srf.invite(callHandler);

// ── Global error safety net ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

// ── Graceful shutdown on SIGTERM (Docker/K8s stop) ──────────────────────────
function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, graceful shutdown starting (30s max)`);
  srf.disconnect();
  const timer = setTimeout(() => {
    logger.warn('Graceful shutdown timeout reached, forcing exit');
    process.exit(0);
  }, 30000);
  timer.unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = srf;
