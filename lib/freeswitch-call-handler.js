/**
 * Call comes in and its a SIPREC call (multi-part content)
 * Parse the payload into two sdps
 * Creeate a uuid and store the uniused sdp by uuid
 * Srf#createB2BUA where localSdpA is the SDP we will use first,
 * and localSdpB is a function that pulls the sdp back out of redis
 * and creates a multipart SDP
 * Now, when the other INVITE comes in from freeswwitch
 * we pull the unused SDP out of redis and stick the one FS is offering back in there
 * we send 200 OK with the unused SDP and we are done
 */
const config = require('config');
const redis = require('redis') ;
let client;
const payloadParser = require('./payload-parser');
const payloadCombiner = require('./payload-combiner');
const {isFreeswitchSource, getAvailableFreeswitch} = require('./utils');
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');
const Srf = require('drachtio-srf');

module.exports = (logger) => {
  const redisOpts = Object.assign('test' === process.env.NODE_ENV ?
    {
      retry_strategy: () => {},
      disable_resubscribing: true,
    } : {}
  ) ;

  client = redis.createClient(config.get('redis.port'), config.get('redis.host'), redisOpts);
  client.on('connect', () => {
    logger.info(`successfully connected to redis at ${config.get('redis.host')}:${config.get('redis.port')}`);
  })
    .on('error', (err) => {
      logger.error(err, 'redis connection error') ;
    }) ;

  return handler;
};

const handler = (req, res) => {
  const callid = req.get('Call-ID');
  const logger = req.srf.locals.logger.child({callid});
  const opts = {req, res, logger};
  const ctype = req.get('Content-Type') || '';

  if (ctype.includes('multipart/mixed')) {
    logger.info(`received SIPREC invite: ${req.uri}`);
    handleIncomingSiprecInvite(req, res, opts);
  }
  else if (isFreeswitchSource(req)) {
    logger.info(`received leg2 invite from freeswitch: ${req.source_address} sessionID: ${req.get('X-Return-Token')}`);
    handleLeg2SiprecInvite(req, res, opts);
  }
  else {
    logger.info(`rejecting INVITE from ${req.source_address} because it is not a siprec INVITE`);
    res.send(488);
  }
};

/**
 * Retrieve the SDP from redis (which will be the one FS offered on the leg 2 INVITE), and
 * combine it with the SDP we just got in the 200 OK to the leg1 iNVITE
 * @param {*} sdp SDP offered by Freeswitch in leg2 INVITE
 * @param {*} res res SIP Response object
 */
function createSdpForResponse(opts, sdp, res) {
  return new Promise((resolve, reject) => {
    client.get(opts.sessionId, (err, result) => {
      if (err) {
        return reject(err);
      }
      resolve(payloadCombiner(sdp, result, opts.sdp1, opts.sdp2));
    });
  });
}

function handleIncomingSiprecInvite(req, res, opts) {
  const srf = req.srf;
  return payloadParser(opts)
    .then(storeUnusedSdp)
    .then((opts) => {

      const headers = {
        'X-Return-Token': opts?.sessionId ?? undefined,
        'X-SBC-Call-ID': opts?.originalCallId ?? undefined,
        'X-Client-ID': opts?.recordingData?.recording?.group?.[0]?.x_com_info?.[0]?.client_id?.[0]
          ?? opts?.req?.msg?.raw?.match(/^Contact:\s*<sip:([^@>;]+)@/im)?.[1]
          ?? opts?.req?.msg?.raw?.match(/^From:\s*.*?<sip:([^@>;]+)@/im)?.[1]
          ?? undefined,
        'X-CS-ID': opts?.recordingData?.recording?.session?.[0]?.$?.session_id ?? null,
        'X-CS-Type': opts?.recordingData?.recording?.group?.[0]?.x_com_info?.[0]?.type?.[0] ?? undefined,
        'X-CS-Group-ID': opts?.recordingData?.recording?.group?.[0]?.$?.group_id ?? undefined,
        'X-Agent-ID': opts?.recordingData?.recording?.group?.[0]?.x_com_info?.[0]?.agent_id?.[0] ?? undefined,
        'X-Customer-ID': opts?.recordingData?.recording?.group?.[0]?.x_com_info?.[0]?.customer_id?.[0] ?? undefined,
        'X-Tenant': opts?.recordingData?.recording?.group?.[0]?.x_custom_data?.[0]?.tenant?.[0] ?? undefined,
        'X-Request': opts?.recordingData?.recording?.group?.[0]?.x_custom_data?.[0]?.request?.[0] ?? undefined,
      };

      const callOpts = {
        callingNumber: opts.caller.number,
        calledNumber: opts.callee.number,
        passProvisionalResponses: false,
        headers,
        localSdpB: opts.sdp1,
        localSdpA: createSdpForResponse.bind(null, opts),
        // Do not systematically return SIP errors; we want to handle the fallback to the media servers ourselves
        passFailure: false
      };

      const maxAttempts = config.get('freeswitch').length;
      let attempt = 0;

      // Keep locally the media servers already attempted for this call
      // This ensures reliable failover in a PM2 cluster environment (multiple workers)
      const tried = new Set();

      function tryConnect() {

        let fsUri;

        do {
          fsUri = getAvailableFreeswitch();
          debug(`handleIncomingSiprecInvite: sending to ${fsUri}`);
        } while (tried.has(fsUri) && tried.size < maxAttempts);

        tried.add(fsUri);
        attempt++;

        debug(`handleIncomingSiprecInvite ATTEMPT: ${attempt}/${maxAttempts} -> ${fsUri}`);

        // Access for cancel in case of timeout
        let inviteSent;   

        const b2buaPromise = srf.createB2BUA(
          req,
          res,
          fsUri,
          callOpts,
          {
            cbRequest: (error, reqSent) => {  inviteSent = reqSent; }
          }
        );
        // If no answer within callTimeout on the B-leg
        let callTimeout = 1350; 
        return withTimeout(
          b2buaPromise,
          callTimeout,                       
          () => {
            debug(`Timeout waiting media server ${fsUri}`);
            if (inviteSent) inviteSent.cancel();
          }
        )
        .catch(err => {

          // Application-level timeout from the promises race
          if (err.message === 'MEDIA_TIMEOUT') {
            opts.logger.warn(`Media server ${fsUri} did not respond in time`);
          }

          // Caller hung up → full stop
          else if (err instanceof Srf.SipError && err.status === 487) {
            opts.logger.warn('Caller cancelled');
            return;
          }

          // Other SIP errors
          else {
            opts.logger.warn({err}, `Connection to ${fsUri} failed`);
          }

          if (attempt < maxAttempts && tried.size < maxAttempts)            
            return tryConnect();

          throw err;
        });
      }

      return tryConnect()
        .then((dialogs) => {
            if (!dialogs) {
              // None media server responded, we decline client call
              if (!res.finalResponseSent) {
                res.send(603);
              }
              return;
            }

            return setDialogHandlers(opts.logger, dialogs);
         })
    })
    .catch((err) => {
      opts.logger.error(err, 'Error connecting incoming SIPREC call to freeswitch');
      if (!res.finalResponseSent) {
        res.send(603);
      }
    })
}

function storeUnusedSdp(opts) {
  return new Promise((resolve) => {
    debug(`sessionId: ${opts.sessionId}: sdp ${opts.sdp2}`);
    client.set(opts.sessionId, opts.sdp2, 'EX', 10, (err, reply) => {
      if (err) throw err;
      resolve(opts) ;
    }) ;
  });
}

function setDialogHandlers(logger, dialogs) {
  if (!dialogs || !dialogs.uas || !dialogs.uac) {
    logger.warn('No dialogs to attach handlers to');
    return;
  }

  const { uas, uac } = dialogs;
  
  uas
    .on('destroy', () => {
      logger.info('call ended normally');
      uac.destroy();
    })
    .on('refresh', () => logger.info('received refreshing re-INVITE from siprec client'))
    .on('modify', (req, res) => {
      logger.info('received re-INVITE from SBC');
      res.send(200, {
        body: uas.local.sdp
      });
    });

  uac
    .on('destroy', () => {
      logger.info('call ended unexpectedly with BYE from Freeswitch');
      uas.destroy();
    })
    .on('refresh', () => logger.info('received refreshing re-INVITE from Freeswitch'));
}
/**
 * Get session-id from Subject header.  Lookup unused SDP by session id, and exchange the offered SDP back into redis.
 * Send 200 OK with the unused SDP from the original SIPREC INVITE.
 * @param {*} req
 * @param {*} res
 * @param {*} opts
 */
function handleLeg2SiprecInvite(req, res, opts) {
  const logger = opts.logger;
  const sessionId = req.get('X-Return-Token');
  debug(`handleLeg2SiprecInvite: sessionId is ${sessionId}`);

  // add a=recvonly
  let sdp = transform.parse(req.body);
  sdp.media[0].direction = 'recvonly';
  sdp = transform.write(sdp);
  exchangeSdp(sessionId, sdp)
    .then((sdp) => req.srf.createUAS(req, res, {localSdp: sdp}))
    .catch((err) => {
      logger.error(err, 'Error replying to leg2 INVITE from Freeswitch');
      res.send(480);
    });
}

function exchangeSdp(sessionId, sdp) {
  return new Promise((resolve, reject) => {
    client.multi()
      .get(sessionId)
      .set(sessionId, sdp, 10)
      .exec((err, replies) => {
        if (err) return reject(err);
        resolve(replies[0]);
      });
  });
}

function withTimeout(promise, callTimeout, onTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) 
        onTimeout();
      reject(new Error('MEDIA_TIMEOUT'));
    }, callTimeout);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise
  ]);
}
