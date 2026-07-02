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
let clientPromise;
const payloadParser = require('./payload-parser');
const payloadCombiner = require('./payload-combiner');
const {isFreeswitchSource, getAvailableFreeswitch} = require('./utils');
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');
const Srf = require('drachtio-srf');
const updatePayloadParser = require('./update-payload-parser');
const { URL } = require('url');
const net = require('net');

module.exports = (logger) => {
  const isTest = process.env.NODE_ENV === 'test';
  const redisOpts = isTest ? {
    reconnectStrategy: () => { return false; }
  } : {} ;

  clientPromise = redis.createClient({
    socket: {
      port: config.get('redis.port'),
      host: config.get('redis.host'),
      ...redisOpts
    }
  }).connect();
  clientPromise.then((client) => {
    logger.info(`successfully connected to redis at ${config.get('redis.host')}:${config.get('redis.port')}`);
    client.on('error', (err) => {
      if (isTest && err.constructor.name === 'SocketClosedUnexpectedlyError')
        return ;
      logger.error(err, 'redis error') ;
    }) ;
  }, (err) => {
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
async function createSdpForResponse(opts, sdp) {
  const client = await clientPromise;
  const result = await client.get(opts.sessionId);
  return payloadCombiner(sdp, result, opts.sdp1, opts.sdp2);
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

        // Round-robin across calls; fall back to any untried server if round-robin
        // lands on one already tried within this call (failover scenario).
        let fsUri = getAvailableFreeswitch();
        if (tried.has(fsUri)) {
          const servers = config.get('freeswitch');
          const candidates = servers.filter(s => !tried.has(s));
          if (candidates.length === 0) {
            opts.logger.warn({ tried: [...tried] }, 'All media servers exhausted — declining call');
            return Promise.reject(new Error('All media servers exhausted'));
          }
          fsUri = candidates[0];
        }

        tried.add(fsUri);
        attempt++;

        opts.logger.info({ fsUri, attempt, maxAttempts }, `Attempt ${attempt}/${maxAttempts}: connecting to media server ${fsUri}`);

        // Shared cancel state between the timeout and cbRequest.
        // If the timeout fires before cbRequest, cancelRequested ensures
        // the INVITE is cancelled as soon as drachtio confirms it was sent.
        let inviteSent;
        let cancelRequested = false;

        const b2buaPromise = srf.createB2BUA(
          req,
          res,
          fsUri,
          callOpts,
          {
            cbRequest: (error, reqSent) => {
              inviteSent = reqSent;
              if (cancelRequested && inviteSent) inviteSent.cancel();
            }
          }
        );
        // If no answer within callTimeout on the B-leg
        const callTimeout = config.has('callTimeoutMs') ? config.get('callTimeoutMs') : 1350;
        return withTimeout(
          b2buaPromise,
          callTimeout,
          () => {
            debug(`Timeout waiting media server ${fsUri}`);
            cancelRequested = true;
            if (inviteSent) inviteSent.cancel();
          }
        )
        .catch(err => {

          // Application-level timeout
          if (err.message === 'MEDIA_TIMEOUT') {
            opts.logger.warn(
              { fsUri, attempt, maxAttempts, timeoutMs: callTimeout },
              `Attempt ${attempt}/${maxAttempts}: media server ${fsUri} did not respond within ${callTimeout}ms`
            );
          }

          // Caller cancelled — stop all failover immediately
          else if (err instanceof Srf.SipError && err.status === 487) {
            opts.logger.warn({ fsUri, attempt }, 'Caller cancelled — aborting failover');
            return;
          }

          // SIP error from media server
          else {
            opts.logger.warn(
              { fsUri, attempt, maxAttempts, sipStatus: err.status, sipReason: err.reason },
              `Attempt ${attempt}/${maxAttempts}: media server ${fsUri} rejected with ${err.status} ${err.reason}`
            );
          }

          if (attempt < maxAttempts && tried.size < maxAttempts) {
            opts.logger.info({ attempt, maxAttempts }, `Retrying with next media server (attempt ${attempt + 1}/${maxAttempts})`);
            return tryConnect();
          }

          opts.logger.error(
            { tried: [...tried], attempts: attempt },
            `All ${attempt} media server(s) failed — declining call with 503`
          );
          throw err;
        });
      }

      return tryConnect()
        .then((dialogs) => {
            if (!dialogs) {
              // None media server responded, we decline client call
              if (!res.finalResponseSent) {
                res.send(503);
              }
              return;
            }

            return setDialogHandlers(opts.logger, dialogs);
         })
    })
    .catch((err) => {
      if (!res.finalResponseSent) {
        res.send(503);
      }
    })
}

async function storeUnusedSdp(opts) {
  debug(`sessionId: ${opts.sessionId}: sdp ${opts.sdp2}`);
  const client = await clientPromise;
  await client.set(opts.sessionId, opts.sdp2, 'EX', 10);
  return opts;
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
    })
    .on('update', async (req, res) => {
      logger.info('Received SIPREC UPDATE from SRC');

      const aaConfig = config.get('aa');
      const { apiCallIP, port, route, apiCallTimeout } = aaConfig;

      try {
        // Parse payload
        const opts = await updatePayloadParser({ req, res, logger });
        
        logger.debug(`Parsed opts: ${JSON.stringify(opts)}`);

        if (
          !opts?.updateData ||
          !opts.updateData.session_id ||
          !opts.updateData.participant_1 ||
          !opts.updateData.participant_2
        ) {
          logger.error('Invalid SIPREC UPDATE payload: missing required fields');
          return res.send(500);
        }

        logger.debug('Validated SIPREC UPDATE payload', opts.updateData);

        // We prioritize the IP address provided in the configuration file.
        // If it is not provided, we use the IP address of the media server handling the call.
        const sourceIp = apiCallIP || uac?.res?.source_address;

        if (!sourceIp || net.isIP(sourceIp) === 0) {
          logger.error(`Invalid or missing source IP: ${sourceIp}`);
          return res.send(500);
        }

        const apiUrl = new URL(`http://${sourceIp}`);
        apiUrl.port = port;
        apiUrl.pathname = `/${route.replace(/^\/+/, '')}`;

        logger.info(`Calling Agent Assist API: ${apiUrl.href}`);

        // Call Agent Assist API with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), apiCallTimeout);

        let apiResponse;

        try {
          apiResponse = await fetch(apiUrl.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.updateData),
            signal: controller.signal
          });
        } catch (fetchErr) {
          if (fetchErr.name === 'AbortError') {
            logger.error(`Agent Assist API timeout after ${apiCallTimeout}ms`);
            return res.send(500);
          }

          logger.error(`Network error calling Agent Assist API: ${fetchErr.message}`);
          return res.send(500);
        } finally {
          clearTimeout(timeout);
        }

        // Check API response
        if (!apiResponse.ok) {
          logger.error(`Agent Assist API responded with status ${apiResponse.status}`);
          return res.send(500);
        }

        logger.info('Agent Assist API call successful');

        return res.send(200, {
          body: uas.local.sdp
        });

      } catch (err) {
        logger.error(`Unexpected error during SIPREC UPDATE handling: ${err.message}`);
        return res.send(500);
      }
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

async function exchangeSdp(sessionId, sdp) {
  const client = await clientPromise;
  const [oldSdp] = await client.multi()
    .get(sessionId)
    .set(sessionId, sdp, 10)
    .exec();
  return oldSdp;
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
