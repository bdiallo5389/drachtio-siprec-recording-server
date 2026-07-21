const xmlParser = require('xml2js').parseString;
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');

/**
 * Parse a SIPREC re-INVITE (hold or resume).
 * Detects the event from SDP direction and extracts session metadata from RS-metadata XML.
 * @param {object} req - drachtio request from dialog .on('modify', ...)
 * @returns {Promise<{event: 'hold'|'resume', associate_time: string|null, session_id: string|null, group_id: string|null}>}
 */
module.exports = function parseRefreshPayload(req) {
  return new Promise((resolve, reject) => {
    let sdpContent  = null;
    let metaContent = null;

    if (Array.isArray(req.payload)) {
      for (const part of req.payload) {
        if (part.type === 'application/sdp') {
          sdpContent = part.content;
        } else if (part.type === 'application/rs-metadata+xml' || part.type === 'application/rs-metadata') {
          metaContent = part.content;
        }
      }
    }
    if (!sdpContent && req.body) sdpContent = req.body;

    if (!sdpContent) return reject(new Error('re-INVITE: no SDP found'));

    const sdp = transform.parse(sdpContent);
    if (!sdp.media || sdp.media.length === 0) {
      return reject(new Error('re-INVITE: SDP has no media sections'));
    }

    const allInactive = sdp.media.every((m) => m.direction === 'inactive');
    const allSendonly = sdp.media.every((m) => m.direction === 'sendonly');

    let event;
    if (allInactive)      event = 'hold';
    else if (allSendonly) event = 'resume';
    else {
      const dirs = sdp.media.map((m) => m.direction).join(',');
      return reject(new Error(`re-INVITE: unrecognised SDP directions (${dirs}) — not a hold/resume`));
    }

    debug('[refresh-parser] detected event=%s', event);

    if (!metaContent) {
      return resolve({ event, associate_time: null, session_id: null, group_id: null });
    }

    xmlParser(metaContent, (err, result) => {
      if (err) return reject(err);
      try {
        const recording     = result.recording || {};
        const session_id    = recording.session?.[0]?.$?.session_id          || null;
        const group_id      = recording.group?.[0]?.$?.group_id              || null;
        const associate_time  = recording.sessionrecordingassoc?.[0]?.['associate-time']?.[0]  || null;
        const dissociate_time = recording.sessionrecordingassoc?.[0]?.['dissociate-time']?.[0] || null;

        debug('[refresh-parser] event=%s session_id=%s group_id=%s associate_time=%s dissociate_time=%s',
          event, session_id, group_id, associate_time, dissociate_time);

        resolve({ event, associate_time, dissociate_time, session_id, group_id });
      } catch (ex) {
        reject(ex);
      }
    });
  });
};
