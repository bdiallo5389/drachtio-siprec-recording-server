const xmlParser = require('xml2js').parseString;
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');
const {
  getRecordingRoot,
  resolveParticipantsSimple,
  extractCsInfo,
  extractSessionRecordingAssoc,
  extractParticipantAssoc,
  resolveParticipantLabels,
} = require('./siprec-metadata-utils');

// 'connection' intentionally excluded: on a re-INVITE the SRC often sends a stale
// x_event=connection from the initial INVITE; treating it as a business event would mask hold/resume.
const BUSINESS_EVENTS = ['transfer', 'conference'];

/**
 * Resolve the business event of a re-INVITE from SDP direction and x_event, per two
 * independent sources with the following priority:
 *   1. hold is dominant: x_event=hold on either side, OR either SDP line is a=inactive.
 *   2. transfer/conference: x_event wins outright when both sides agree.
 *   3. resume requires bilateral confirmation: x_event=resume on BOTH sides AND
 *      a=sendonly on BOTH SDP lines. When x_event is entirely absent (SDP-only
 *      re-INVITE, no RS-metadata part), falls back to SDP alone (both sendonly).
 *      A single-sided or contradictory signal yields 'unknown'.
 *   4. otherwise 'unknown' (never rejected — the SIP response does not depend on this).
 */
function resolveEvent({ sdp1Dir, sdp2Dir, callerXEvent, calleeXEvent }) {
  let result;

  if (callerXEvent === 'hold' || calleeXEvent === 'hold' || sdp1Dir === 'inactive' || sdp2Dir === 'inactive') {
    result = { event: 'hold' };
  } else {
    const xEvents = [callerXEvent, calleeXEvent].filter(Boolean);
    const bothSendonly = sdp1Dir === 'sendonly' && sdp2Dir === 'sendonly';

    if (xEvents.length > 0 && xEvents.every((e) => e === xEvents[0]) && BUSINESS_EVENTS.includes(xEvents[0])) {
      result = { event: xEvents[0] };
    } else if (callerXEvent === undefined && calleeXEvent === undefined) {
      // No RS-metadata at all — SDP is the only available signal.
      result = bothSendonly
        ? { event: 'resume' }
        : { event: 'unknown', warning: `no x_event available, SDP directions inconclusive (${sdp1Dir},${sdp2Dir})` };
    } else if (callerXEvent === 'resume' && calleeXEvent === 'resume' && bothSendonly) {
      result = { event: 'resume' };
    } else if (xEvents.includes('resume') || bothSendonly) {
      // Single-sided or contradictory resume signal: never force a resume classification.
      result = { event: 'unknown', warning: `resume not confirmed on both sides (x_event=${callerXEvent}/${calleeXEvent}, sdp=${sdp1Dir}/${sdp2Dir})` };
    } else {
      result = { event: 'unknown', warning: `unrecognised combination (x_event=${callerXEvent}/${calleeXEvent}, sdp=${sdp1Dir}/${sdp2Dir})` };
    }
  }

  debug('[refresh-parser] resolveEvent(sdp1Dir=%s, sdp2Dir=%s, callerXEvent=%s, calleeXEvent=%s) -> %j',
    sdp1Dir, sdp2Dir, callerXEvent, calleeXEvent, result);
  return result;
}

/**
 * The event actually observed for a single participant: their own x_event when present
 * (hold/resume/transfer/conference/connection, taken verbatim), otherwise derived from
 * their own SDP media-line direction (a=inactive -> hold, a=sendonly -> resume).
 * Distinct from the global event resolved by resolveEvent(), which may say 'hold' overall
 * because of the OTHER participant even though this one, taken alone, shows something else.
 */
function resolvePartEvent(xEvent, sdpDirection) {
  let result;
  if (xEvent) result = xEvent;
  else if (sdpDirection === 'inactive') result = 'hold';
  else if (sdpDirection === 'sendonly') result = 'resume';
  else result = undefined;

  debug('[refresh-parser] resolvePartEvent(xEvent=%s, sdpDirection=%s) -> %s', xEvent, sdpDirection, result);
  return result;
}

/**
 * Parse the SDP body of a re-INVITE: overall (positional) direction of the first two media
 * lines, used by resolveEvent(), plus a label -> direction map used to resolve each
 * participant's own media line via resolveParticipantLabels().
 *
 * For in-dialog re-INVITEs drachtio does not always populate req.payload, so sdpContent
 * may be the raw multipart body. sdp-transform is tried first; if it yields no media (or
 * throws), a regex pass on the raw text extracts direction lines directly.
 */
function parseSdpMedia(sdpContent) {
  let result = { sdp1Dir: undefined, sdp2Dir: undefined, directionByLabel: new Map() };
  if (!sdpContent) {
    debug('[refresh-parser] parseSdpMedia -> no SDP content');
    return result;
  }
  try {
    const sdp = transform.parse(sdpContent);
    if (sdp.media && sdp.media.length > 0) {
      const directionByLabel = new Map();
      sdp.media.forEach((m) => {
        if (m.label !== undefined) directionByLabel.set(String(m.label), m.direction);
      });
      result = {
        sdp1Dir: sdp.media[0].direction,
        sdp2Dir: sdp.media[1] ? sdp.media[1].direction : undefined,
        directionByLabel,
      };
      debug('[refresh-parser] parseSdpMedia (sdp-transform) -> sdp1Dir=%s sdp2Dir=%s', result.sdp1Dir, result.sdp2Dir);
      return result;
    }
  } catch (_) {}

  // Fallback: regex on raw content — handles multipart bodies where sdp-transform fails.
  const dirs = (sdpContent.match(/^a=(inactive|sendonly|sendrecv|recvonly)$/mg) || []).map((m) => m.slice(2));
  result = { sdp1Dir: dirs[0], sdp2Dir: dirs[1], directionByLabel: new Map() };
  debug('[refresh-parser] parseSdpMedia (regex fallback) -> sdp1Dir=%s sdp2Dir=%s', result.sdp1Dir, result.sdp2Dir);
  return result;
}

/**
 * Resolve a participant's own SDP direction via their stream label (obj/prefix from the
 * RS-metadata). Falls back to the positional direction (sdp1Dir for caller, sdp2Dir for
 * callee) when the label cannot be resolved (e.g. no <stream>/<participantstreamassoc>
 * in the payload), so the field stays populated even on a minimal message.
 */
function resolveOwnSdpDirection(participantId, positionalDir, obj, prefix, directionByLabel) {
  const label = participantId ? resolveParticipantLabels(obj, prefix).get(participantId) : undefined;
  const direction = label !== undefined ? directionByLabel.get(String(label)) : undefined;
  const result = direction !== undefined ? direction : positionalDir;
  debug('[refresh-parser] resolveOwnSdpDirection(participantId=%s) -> label=%s direction=%s (positional fallback=%s) => %s',
    participantId, label, direction, positionalDir, result);
  return result;
}

/**
 * Parse a SIPREC re-INVITE (hold, resume, transfer, conference, connection).
 * Always resolves — never rejects — a parsing shortfall must not block the SIP response.
 * @param {object} req - drachtio request from dialog .on('modify', ...)
 * @returns {Promise<object>} {event, associate_time, dissociate_time, session_id, group_id,
 *                             call_id_1, call_id_2, caller, callee}
 */
module.exports = function parseRefreshPayload(req) {
  return new Promise((resolve) => {
    let sdpContent = null;
    let metaContent = null;

    if (Array.isArray(req.payload) && req.payload.length > 0) {
      // Initial path: drachtio parsed the multipart body into req.payload (initial INVITE style)
      for (const part of req.payload) {
        if (part.type === 'application/sdp') sdpContent = part.content;
        else if (part.type === 'application/rs-metadata+xml' || part.type === 'application/rs-metadata') metaContent = part.content;
      }
    }

    // For in-dialog re-INVITEs drachtio may not populate req.payload — parse the raw body manually.
    if ((!sdpContent || !metaContent) && req.body) {
      const ct = (req.get && req.get('Content-Type')) ||
        (req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '';
      const boundaryMatch = ct.match(/boundary=([^\s;]+)/i);
      if (boundaryMatch) {
        const boundary = '--' + boundaryMatch[1];
        for (const part of req.body.split(boundary)) {
          if (!part || part.startsWith('--')) continue;
          const sepIdx = part.indexOf('\r\n\r\n');
          if (sepIdx === -1) continue;
          const hdrs = part.slice(0, sepIdx).toLowerCase();
          const body = part.slice(sepIdx + 4).replace(/\r\n$/, '');
          if (!sdpContent && hdrs.includes('application/sdp')) sdpContent = body;
          else if (!metaContent && hdrs.includes('application/rs-metadata')) metaContent = body;
        }
      }
      // Last resort: pass the raw body to parseSdpMedia — its regex fallback handles it.
      if (!sdpContent) sdpContent = req.body;
    }

    const { sdp1Dir, sdp2Dir, directionByLabel } = parseSdpMedia(sdpContent);

    const finish = (result) => {
      result.sdp1Dir = sdp1Dir;
      result.sdp2Dir = sdp2Dir;
      debug('[refresh-parser] final result -> %j', result);
      resolve(result);
    };

    const fallback = () => {
      const { event } = resolveEvent({ sdp1Dir, sdp2Dir, callerXEvent: undefined, calleeXEvent: undefined });
      finish({
        event, associate_time: undefined, dissociate_time: undefined, session_id: undefined, group_id: undefined,
        call_id_1: undefined, call_id_2: undefined, caller: {}, callee: {},
      });
    };

    if (!metaContent) return fallback();

    xmlParser(metaContent, (err, result) => {
      if (err) {
        debug('[refresh-parser] XML parse failed: %s — falling back to SDP-only resolution', err.message);
        return fallback();
      }

      const root = getRecordingRoot(result);
      if (!root) return fallback();
      const { obj, prefix } = root;

      try {
        const session_id = obj[`${prefix}session`]?.[0]?.$?.session_id || undefined;
        const group_id   = obj[`${prefix}group`]?.[0]?.$?.group_id     || undefined;
        const { associate_time, dissociate_time } = extractSessionRecordingAssoc(obj, prefix);
        const { call_id_1, call_id_2 } = extractCsInfo(obj, prefix);
        const { caller, callee } = resolveParticipantsSimple(obj, prefix);
        const assocMap = extractParticipantAssoc(obj, prefix);

        const callerAssoc = caller.participantId ? assocMap.get(caller.participantId) : undefined;
        const calleeAssoc = callee.participantId ? assocMap.get(callee.participantId) : undefined;

        caller.callId         = call_id_1;
        caller.associateTime  = callerAssoc?.associate_time;
        caller.dissociateTime = callerAssoc?.dissociate_time;
        caller.xEvent         = callerAssoc?.x_event;

        callee.callId         = call_id_2;
        callee.associateTime  = calleeAssoc?.associate_time;
        callee.dissociateTime = calleeAssoc?.dissociate_time;
        callee.xEvent         = calleeAssoc?.x_event;

        const callerOwnDirection = resolveOwnSdpDirection(caller.participantId, sdp1Dir, obj, prefix, directionByLabel);
        const calleeOwnDirection = resolveOwnSdpDirection(callee.participantId, sdp2Dir, obj, prefix, directionByLabel);
        caller.partEvent = resolvePartEvent(caller.xEvent, callerOwnDirection);
        callee.partEvent = resolvePartEvent(callee.xEvent, calleeOwnDirection);

        const { event } = resolveEvent({
          sdp1Dir, sdp2Dir,
          callerXEvent: caller.xEvent,
          calleeXEvent: callee.xEvent,
        });

        finish({ event, associate_time, dissociate_time, session_id, group_id, call_id_1, call_id_2, caller, callee });
      } catch (ex) {
        debug('[refresh-parser] unexpected error extracting metadata: %s — falling back to SDP-only event', ex.message);
        fallback();
      }
    });
  });
};

module.exports.resolveEvent = resolveEvent;
module.exports.resolvePartEvent = resolvePartEvent;
