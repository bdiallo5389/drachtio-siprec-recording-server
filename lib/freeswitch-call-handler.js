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
const payloadParser = require('./payload-parser');
const payloadCombiner = require('./payload-combiner');
const { isFreeswitchSource } = require('./utils');
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');
const updatePayloadParser = require('./update-payload-parser');
const createSdpStore = require('./sdp-store');
const callAgentAssist = require('./agent-assist-client');
const { createTryConnect } = require('./failover');

let sdpStore;

module.exports = (logger) => {
  sdpStore = createSdpStore(logger);
  return handler;
};

const handler = (req, res) => {
  const callid = req.get('Call-ID');
  const logger = req.srf.locals.logger.child({ callid });
  const opts = { req, res, logger };
  const ctype = req.get('Content-Type') || '';

  if (ctype.includes('multipart/mixed')) {
    logger.info(`received SIPREC invite: ${req.uri}`);
    handleIncomingSiprecInvite(req, res, opts);
  } else if (isFreeswitchSource(req)) {
    logger.info(`received leg2 invite from freeswitch: ${req.source_address} sessionID: ${req.get('X-Return-Token')}`);
    handleLeg2SiprecInvite(req, res, opts);
  } else {
    logger.info(`rejecting INVITE from ${req.source_address} because it is not a siprec INVITE`);
    res.send(488);
  }
};

async function createSdpForResponse(opts, sdp) {
  const result = await sdpStore.get(opts.sessionId);
  return payloadCombiner(sdp, result, opts.sdp1, opts.sdp2);
}

function handleIncomingSiprecInvite(req, res, opts) {
  const srf = req.srf;
  return payloadParser(opts)
    .then(async (opts) => {
      debug(`sessionId: ${opts.sessionId}: storing sdp ${opts.sdp2}`);
      await sdpStore.store(opts.sessionId, opts.sdp2);
      return opts;
    })
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
        passFailure: false
      };

      const tryConnect = createTryConnect(srf, req, res, callOpts, opts.logger);

      return tryConnect()
        .then((dialogs) => {
          if (!dialogs) {
            if (!res.finalResponseSent) res.send(603);
            return;
          }
          return setDialogHandlers(opts.logger, dialogs);
        });
    })
    .catch((err) => {
      opts.logger.error(err, 'Error connecting incoming SIPREC call to freeswitch');
      if (!res.finalResponseSent) res.send(603);
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
      res.send(200, { body: uas.local.sdp });
    })
    .on('update', async (req, res) => {
      logger.info('Received SIPREC UPDATE from SRC');
      try {
        const opts = await updatePayloadParser({ req, res, logger });

        if (
          !opts?.updateData ||
          !opts.updateData.session_id ||
          !opts.updateData.participant_1 ||
          !opts.updateData.participant_2
        ) {
          logger.error('Invalid SIPREC UPDATE payload: missing required fields');
          return res.send(500);
        }

        await callAgentAssist(opts.updateData, uac?.res?.source_address, logger);
        return res.send(200, { body: uas.local.sdp });
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

function handleLeg2SiprecInvite(req, res, opts) {
  const logger = opts.logger;
  const sessionId = req.get('X-Return-Token');
  debug(`handleLeg2SiprecInvite: sessionId is ${sessionId}`);

  let sdp = transform.parse(req.body);
  if (sdp.media && sdp.media.length > 0) sdp.media[0].direction = 'recvonly';
  sdp = transform.write(sdp);

  sdpStore.exchange(sessionId, sdp)
    .then((sdp) => req.srf.createUAS(req, res, { localSdp: sdp }))
    .catch((err) => {
      logger.error(err, 'Error replying to leg2 INVITE from Freeswitch');
      res.send(480);
    });
}
