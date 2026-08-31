const xmlParser = require('xml2js').parseString;
const debug = require('debug')('drachtio:siprec-recording-server');
const {
  getRecordingRoot,
  resolveParticipantsSimple,
  extractCsInfo,
  extractSessionRecordingAssoc,
  extractParticipantAssoc,
} = require('./siprec-metadata-utils');

/**
 * Parse a SIP UPDATE carrying SIPREC RS-metadata.
 *
 * Accepts datamode="complete" as well as datamode="partial" or any other/absent value —
 * datamode is informational only and never causes a rejection. Likewise, a message with 0 or 1
 * resolvable participants is not rejected: whatever is available is used, everything else is
 * left undefined. Rejection is reserved for a genuinely unprocessable payload — no RS-metadata
 * part at all, an XML parse error, or no <recording> root element.
 *
 * @param {object} opts - {req, res, logger}
 * @returns {Promise<object>} opts, with opts.updateData = {event, session_id, group_id,
 *   associate_time, dissociate_time, call_id_1, call_id_2, caller, callee}
 */
module.exports = function parseUpdatePayload(opts) {
  const req = opts.req;
  const logger = opts.logger;

  return new Promise((resolve, reject) => {
    let meta, sdpText;
    for (const part of req.payload || []) {
      if (part.type === 'application/rs-metadata+xml' || part.type === 'application/rs-metadata') {
        meta = part.content;
      } else if (part.type === 'application/sdp') {
        sdpText = part.content;
      }
    }

    if (!meta) {
      logger.info({ payload: req.payload }, 'SIPREC UPDATE with no RS-metadata part');
      return reject(new Error('Expected multipart SIPREC metadata for UPDATE'));
    }

    xmlParser(meta, (err, result) => {
      if (err) return reject(err);

      const root = getRecordingRoot(result);
      if (!root) return reject(new Error('SIPREC UPDATE: no <recording> root element found'));
      const { obj, prefix } = root;

      try {
        const datamode = obj[`${prefix}datamode`]?.[0];
        logger.info({ datamode: datamode || 'absent' }, 'SIPREC UPDATE datamode');

        const session_id = obj[`${prefix}session`]?.[0]?.$?.session_id || undefined;
        const group_id   = obj[`${prefix}group`]?.[0]?.$?.group_id     || undefined;
        debug('[update-parser] session_id=%s group_id=%s', session_id, group_id);

        const { associate_time, dissociate_time } = extractSessionRecordingAssoc(obj, prefix);
        const { call_id_1, call_id_2 } = extractCsInfo(obj, prefix);
        const { caller, callee } = resolveParticipantsSimple(obj, prefix);
        const assocMap = extractParticipantAssoc(obj, prefix);

        const callerAssoc = caller.participantId ? assocMap.get(caller.participantId) : undefined;
        const calleeAssoc = callee.participantId ? assocMap.get(callee.participantId) : undefined;
        debug('[update-parser] callerAssoc=%j calleeAssoc=%j', callerAssoc, calleeAssoc);

        caller.callId         = call_id_1;
        caller.associateTime  = callerAssoc?.associate_time;
        caller.dissociateTime = callerAssoc?.dissociate_time;
        caller.xEvent         = callerAssoc?.x_event;
        caller.partEvent      = caller.xEvent;

        callee.callId         = call_id_2;
        callee.associateTime  = calleeAssoc?.associate_time;
        callee.dissociateTime = calleeAssoc?.dissociate_time;
        callee.xEvent         = calleeAssoc?.x_event;
        callee.partEvent      = callee.xEvent;

        // Best-effort business event from XML: both participantsessionassoc entries normally carry
        // the same x_event. When they disagree, or when neither is present, fall back to 'unknown'.
        const xEvents = [caller.xEvent, callee.xEvent].filter(Boolean);
        let event = xEvents.length > 0 && xEvents.every((e) => e === xEvents[0]) ? xEvents[0] : 'unknown';
        debug('[update-parser] resolved event=%s from xEvents=%j', event, xEvents);

        // SIP UPDATE MAY carry an SDP (RFC 3311). Expose the directions so the caller can track
        // state transitions (e.g. inactive → sendonly = resume). Also use them to detect hold
        // when x_event was not updated by the SRC (still shows the initial value).
        if (sdpText) {
          const directions = (sdpText.match(/^a=(inactive|sendonly|sendrecv|recvonly)$/mg) || [])
            .map((m) => m.slice(2));
          opts.sdpDirections = directions;
          const allInactive = directions.length > 0 && directions.every((d) => d === 'inactive');
          const initialEvents = new Set(['connection', 'connexion', 'unknown']);
          if (allInactive && initialEvents.has(event)) {
            debug('[update-parser] SDP a=inactive overrides stale x_event "%s" → hold', event);
            event = 'hold';
          }
        }

        opts.updateData = { event, session_id, group_id, associate_time, dissociate_time, call_id_1, call_id_2, caller, callee };
        debug('[update-parser] final result -> %j', opts.updateData);
        resolve(opts);
      } catch (ex) {
        reject(ex);
      }
    });
  });
};
