const xmlParser = require('xml2js').parseString;
const { v4 } = require('uuid');
const debug = require('debug')('drachtio:siprec-recording-server');

/**
 * parse a SIPREC multiparty body
 * @param  {object} opts - options
 * @return {Promise}
 */
module.exports = function parsePartialSiprec(opts) {
  const req = opts.req;
  const logger = opts.logger;

  return new Promise((resolve, reject) => {
    let meta, sdp;

    // SDP and metadata extraction
    for (const part of req.payload) {
      if (part.type === 'application/rs-metadata+xml' || part.type === 'application/rs-metadata') {
        meta = part.content;
      } else if (part.type === 'application/sdp') {
        sdp = part.content;
      }
    }

    if (!meta) {
      logger.info({ payload: req.payload }, 'Missing metadata for partial SIPREC');
      return reject(new Error('Expected multipart SIPREC metadata for partial data'));
    }

    // SDP parsing 
    if (sdp) {
      const arr = /^([^]+)(m=[^]+?)(m=[^]+?)$/.exec(sdp);
      if (arr) {
        opts.sdp1 = `${arr[1]}${arr[2]}`;
        opts.sdp2 = `${arr[1]}${arr[3]}\r\n`;
      }
      opts.sessionId = v4();
    }

    // SIPREC metadata parsing
    xmlParser(meta, (err, result) => {
      if (err) return reject(err);

      try {
        const participantsRaw = {};
        const recording = result.recording || {};
        const datamode = recording.datamode?.[0];

        if (datamode !== 'partial') {
          return reject(new Error('Not a partial SIPREC message'));
        }

        // group-ref and session extraction
        const sessionXml = recording.session?.[0];
        if (!sessionXml || !sessionXml.$?.session_id) {
          return reject(new Error('Missing session_id in <session>'));
        }

        const sessionId = sessionXml.$.session_id;
        const groupRef = sessionXml['group-ref']?.[0] || null;

        if (!groupRef) {
          logger.warn(`Missing group-ref in session ${sessionId}, continuing`);
        }

        const partSessAssoc = recording.participantsessionassoc || [];
        const partStreamAssoc = recording.participantstreamassoc || [];

        // Collecte participants data
        partSessAssoc.forEach((p) => {
          const id = p.$.participant_id;
          const participantSessionId = p.$.session_id;
          if (participantSessionId !== sessionId) {
            return reject(new Error(`Participant ${id} session_id mismatch with <session>`));
          }

          participantsRaw[id] = {
            participant_id: id,
            session_id: participantSessionId,
            event: p.x_event?.[0] || null,
            associate_time: p['associate-time']?.[0] || null,
            dissociate_time: p['dissociate-time']?.[0] || null,
            send: null,
            recv: null
          };
        });

        // Add streams
        partStreamAssoc.forEach((s) => {
          const id = s.$.participant_id;
          if (!participantsRaw[id]) participantsRaw[id] = { participant_id: id, session_id };
          participantsRaw[id].send = s.send?.[0] || null;
          participantsRaw[id].recv = s.recv?.[0] || null;
        });

        const participantIds = Object.keys(participantsRaw);
        if (participantIds.length !== 2) {
          return reject(new Error('Expected exactly 2 participants for this partial SIPREC'));
        }

        // Constructing updateData
        opts['updateData'] = {
          'group_ref': groupRef,
          session_id: sessionId,
          'participant_1': participantsRaw[participantIds[0]],
          'participant_2': participantsRaw[participantIds[1]]
        };

        logger.debug({ 'updateData': opts['updateData'] }, 'Parsed partial SIPREC with group-ref');
        resolve(opts);

      } catch (ex) {
        reject(ex);
      }
    });
  });
};