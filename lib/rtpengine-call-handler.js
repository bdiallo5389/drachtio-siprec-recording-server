const config = require('config');
const { URL } = require('url');
const net = require('net');
const parseSiprecPayload = require('./payload-parser');
const constructSiprecPayload = require('./payload-combiner');
const updatePayloadParser = require('./update-payload-parser');
const {getAvailableRtpengine} = require('./utils');
const { v4 } = require('uuid');
const debug = require('debug')('drachtio:siprec-recording-server');

module.exports = (req, res) => {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const totag = v4();
  const logger = req.srf.locals.logger.child({callid});
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag
    }
  };

  logger.info(`received SIPREC invite: ${req.uri}`);
  const rtpEngine = getAvailableRtpengine();

  parseSiprecPayload(opts)
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
    .then(respondToInvite)
    .then((dlg) => {
      logger.info(`call connected successfully, using rtpengine at ${JSON.stringify(rtpEngine.remote)}`);
      dlg.on('modify', _onReinvite.bind(null, rtpEngine, logger, totag));
      dlg.on('update', _onUpdate.bind(null, logger));
      return dlg.on('destroy', onCallEnd.bind(null, rtpEngine, opts));
    })
    .catch((err) => {
      logger.error(`Error connecting call: ${err}`);
    });
};

function _onReinvite(rtpEngine, logger, totag, req, res) {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag,
    }
  };

  parseSiprecPayload(opts)
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
    .then((opts) => {
      const body = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
      return opts.res.send(200, {body});
    })
    .catch((err) => {
      logger.error(`Error connecting call: ${err}`);
    });

  logger.info(`received SIPREC Re-invite: ${req.uri}`);
}

async function _onUpdate(logger, req, res) {
  logger.info('received SIPREC UPDATE from SRC');

  const aaConfig = config.get('aa');
  const { apiCallIP, port, route, apiCallTimeout } = aaConfig;

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

    const sourceIp = apiCallIP || req.source_address;

    if (!sourceIp || net.isIP(sourceIp) === 0) {
      logger.error(`Invalid or missing source IP: ${sourceIp}`);
      return res.send(500);
    }

    const apiUrl = new URL(`http://${sourceIp}`);
    apiUrl.port = port;
    apiUrl.pathname = `/${route.replace(/^\/+/, '')}`;

    logger.info(`Calling Agent Assist API: ${apiUrl.href}`);

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

    if (!apiResponse.ok) {
      logger.error(`Agent Assist API responded with status ${apiResponse.status}`);
      return res.send(500);
    }

    logger.info('Agent Assist API call successful');
    return res.send(200);

  } catch (err) {
    logger.error(`Unexpected error during SIPREC UPDATE handling: ${err.message}`);
    return res.send(500);
  }
}

function allocateEndpoint(which, rtpEngine, totag, opts) {
  // If audio is inactive, rtpengine will stop recording and there is no blank audio in record file.
  const sdp = (which === 'caller' ? opts.sdp1 : opts.sdp2).replace(/a=inactive\r\n/g, 'a=sendonly\r\n');
  const args = Object.assign({}, opts.callDetails, {
    sdp,
    'replace': ['origin', 'session-connection'],
    'transport protocol': 'RTP/AVP',
    'record call': 'yes',
    'DTLS': 'off',
    'ICE': 'remove',
    'SDES': 'off',
    'flags': ['media handover', 'port latching'],
    'rtcp-mux': ['accept'],
    'direction':  ['public', 'public'],
  });
  if (which === 'callee') Object.assign(args, {'to-tag': totag});

  debug(`callDetails: ${JSON.stringify(opts.callDetails)}`);
  debug(`rtpengine args for ${which}: ${JSON.stringify(args)}, sending to ${JSON.stringify(rtpEngine.remote)}`);
  return rtpEngine[which === 'caller' ? 'offer' : 'answer'](rtpEngine.remote, args)
    .then((response) => {
      if (response.result !== 'ok') {
        throw new Error('error connecting to rtpengine');
      }
      opts[which === 'caller' ? 'rtpengineCallerSdp' : 'rtpengineCalleeSdp'] = response.sdp;
      return opts;
    });
}

function respondToInvite(opts) {
  const srf = opts.req.srf;
  const payload = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
  return srf.createUAS(opts.req, opts.res, {localSdp: payload});
}

function onCallEnd(rtpEngine, opts) {
  opts.logger.info('call ended');
  return rtpEngine.delete(rtpEngine.remote, opts.callDetails)
    .then((response) => {
      return debug(`response to rtpengine delete: ${JSON.stringify(response)}`);
    });
}
