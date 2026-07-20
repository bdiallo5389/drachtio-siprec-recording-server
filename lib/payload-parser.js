const xmlParser = require('xml2js').parseString;
const { v4 } = require('uuid');
const parseUri = require('drachtio-srf').parseUri;
const debug = require('debug')('drachtio:siprec-recording-server');

const VALID_PART_LEG  = ['caller', 'callee'];
const VALID_PART_TYPE = ['client', 'agent', 'other'];
const VALID_CS_DIREC  = ['incoming', 'outgoing', 'local'];

const parseCallData = (prefix, obj) => {
  const ret = {};
  const group = obj[`${prefix}group`];
  if (group) {
    const key = Object.keys(group[0]).find((k) => /:?callData$/.test(k));
    //const o = _.find(group[0], (value, key) => /:?callData$/.test(key));
    if (key) {
      //const callData = o[0];
      const callData = group[0][key][0];
      for (const key of Object.keys(callData)) {
        if (['fromhdr', 'tohdr', 'callid'].includes(key)) ret[key] = callData[key][0];
      }
    }
  }
  debug('parseCallData %s %s', prefix, JSON.stringify(obj, null, 2));
  return ret;
};

/**
 * parse a SIPREC multiparty body
 * @param  {object} opts - options
 * @return {Promise}
 */
module.exports = function parseSiprecPayload(opts) {
  const req = opts.req;
  const logger = opts.logger;
  return new Promise((resolve, reject) => {
    let sdp, meta ;
    for (let i = 0; i < req.payload.length; i++) {
      switch (req.payload[i].type) {
        case 'application/sdp':
          sdp = req.payload[i].content ;
          break ;

        case 'application/rs-metadata+xml':
        case 'application/rs-metadata':
          meta = opts.xml = req.payload[i].content ;
          break ;

        default:
          break ;
      }
    }


    if (!meta && sdp) {
      const arr = /^([^]+)(m=[^]+?)(m=[^]+?)$/.exec(sdp);
      if (!arr) return reject(new Error('SDP does not contain two media sections'));
      opts.sdp1 = `${arr[1]}${arr[2]}`;
      opts.sdp2 = `${arr[1]}${arr[3]}\r\n`;
      opts.sessionId = v4();
      logger.info({ payload: req.payload }, 'SIPREC payload with no metadata (e.g. Cisco NBR)');
      resolve(opts);
    } else if (!sdp || !meta) {
      logger.info({ payload: req.payload }, 'invalid SIPREC payload');
      return reject(new Error('expected multipart SIPREC body'));
    }

    xmlParser(meta, (err, result) => {
      if (err) { throw err; }

      opts.recordingData = result ;
      opts.sessionId = v4() ;

      const arr = /^([^]+)(m=[^]+?)(m=[^]+?)$/.exec(sdp) ;
      if (!arr) return reject(new Error('SDP does not contain two media sections'));
      opts.sdp1 = `${arr[1]}${arr[2]}` ;
      opts.sdp2 = `${arr[1]}${arr[3]}\r\n` ;

      try {
        if (typeof result === 'object' && Object.keys(result).length === 1) {
          const key = Object.keys(result)[0] ;
          const arr = /^(.*:)recording/.exec(key) ;
          const prefix = !arr ? '' : (arr[1]) ;
          const obj = opts.recordingData[`${prefix}recording`];

          // 1. collect participant data
          const participants = {} ;
          const participantList = obj[`${prefix}participant`];
          if (!Array.isArray(participantList) || participantList.length === 0) {
            return reject(new Error('RS-metadata contains no <participant> elements'));
          }
          participantList.forEach((p) => {
            const partDetails = {} ;
            participants[p.$.participant_id] = partDetails;
            partDetails.participantId = p.$.participant_id;
            if ((`${prefix}nameID` in p) && Array.isArray(p[`${prefix}nameID`])) {
              partDetails.aor = p[`${prefix}nameID`][0]?.$?.aor;
              if ('name' in p[`${prefix}nameID`][0] && Array.isArray(p[`${prefix}nameID`][0].name)) {
                const name = p[`${prefix}nameID`][0].name[0];
                if (typeof name === 'string') partDetails.name = name ;
                else if (typeof name === 'object') partDetails.name = name._ ;
              }
            }
            // Extract participant role fields from x_part_info (standard SIPREC extension)
            const xpi = p.x_part_info?.[0] || {};
            const rawPartLeg  = xpi.x_part_leg?.[0];
            const rawPartType = xpi.x_part_type?.[0];
            partDetails.partLeg  = VALID_PART_LEG.includes(rawPartLeg)   ? rawPartLeg  : null;
            partDetails.partType = VALID_PART_TYPE.includes(rawPartType)  ? rawPartType : null;
            partDetails.partId   = xpi.x_part_id?.[0] || null;
            debug('[parser] [SRC] participant: id=%s aor=%s partLeg=%s partType=%s partId=%s',
              partDetails.participantId, partDetails.aor,
              partDetails.partLeg, partDetails.partType, partDetails.partId);
          });

          // 2. find the associated streams for each participant
          if (`${prefix}participantstreamassoc` in obj) {
            obj[`${prefix}participantstreamassoc`].forEach((ps) => {
              const part = participants[ps.$.participant_id];
              if (part) {
                if (Object.prototype.hasOwnProperty.call(ps, `${prefix}send`)) {
                  part.send = ps[`${prefix}send`][0];
                }
                if (Object.prototype.hasOwnProperty.call(ps, `${prefix}recv`)) {
                  part.recv = ps[`${prefix}recv`][0];
                }
              }
            });
          }

          // 3. Retrieve stream data
          opts.caller = {} ;
          opts.callee = {} ;
          let streamCallerPid = null, streamCalleePid = null;
          obj[`${prefix}stream`].forEach((s) => {
            const streamId = s.$.stream_id;
            let senderPid;
            for (const [pid, v] of Object.entries(participants)) {
              if (v.send === streamId) { senderPid = pid; break; }
            }

            if (!senderPid) return;

            participants[senderPid].label = s[`${prefix}label`][0];
            const isCallerLabel = -1 !== ['1', '10', 'a_leg', 'inbound'].indexOf(participants[senderPid].label);

            if (isCallerLabel) {
              opts.caller.aor = participants[senderPid].aor ;
              if (participants[senderPid].name) opts.caller.name = participants[senderPid].name;
              streamCallerPid = senderPid;
            } else {
              opts.callee.aor = participants[senderPid].aor ;
              if (participants[senderPid].name) opts.callee.name = participants[senderPid].name;
              streamCalleePid = senderPid;
            }
            debug('[parser] [SRC] stream label=%s → %s aor=%s',
              participants[senderPid].label, isCallerLabel ? 'caller' : 'callee', participants[senderPid].aor);
          });

          // if we dont have a participantstreamassoc then assume the first participant is the caller
          if (!opts.caller.aor && !opts.callee.aor) {
            let i = 0;
            for (const [pid, p] of Object.entries(participants)) {
              if (0 === i && p.aor) {
                opts.caller.aor = p.aor;
                opts.caller.name = p.name;
                streamCallerPid = pid;
              }
              else if (1 === i && p.aor) {
                opts.callee.aor = p.aor;
                opts.callee.name = p.name;
                streamCalleePid = pid;
              }
              i++;
            }
            debug('[parser] [SRC] no stream assoc — fallback: caller aor=%s callee aor=%s',
              opts.caller.aor, opts.callee.aor);
          }

          // Caller/callee determination: x_part_leg (explicit, preferred); stream label (fallback)
          // If only one participant has x_part_leg, the other role is deduced from remaining participants
          {
            let legCallerPid = null, legCalleePid = null;
            for (const [pid, p] of Object.entries(participants)) {
              if (p.partLeg === 'caller') legCallerPid = pid;
              else if (p.partLeg === 'callee') legCalleePid = pid;
            }

            let finalCallerPid, finalCalleePid;

            if (legCallerPid && legCalleePid) {
              // Both roles explicit via x_part_leg
              finalCallerPid = legCallerPid;
              finalCalleePid = legCalleePid;
              opts.caller.aor  = participants[legCallerPid].aor  || opts.caller.aor;
              opts.callee.aor  = participants[legCalleePid].aor  || opts.callee.aor;
              opts.caller.name = participants[legCallerPid].name || opts.caller.name;
              opts.callee.name = participants[legCalleePid].name || opts.callee.name;
              debug('[parser] [SRC] caller/callee rule: x_part_leg (both) — caller aor=%s callee aor=%s',
                opts.caller.aor, opts.callee.aor);
            } else if (legCallerPid) {
              // Caller explicit — callee deduced as the other participant
              finalCallerPid = legCallerPid;
              finalCalleePid = Object.keys(participants).find((pid) => pid !== legCallerPid) || null;
              opts.caller.aor  = participants[legCallerPid].aor  || opts.caller.aor;
              opts.caller.name = participants[legCallerPid].name || opts.caller.name;
              if (finalCalleePid) {
                opts.callee.aor  = participants[finalCalleePid].aor  || opts.callee.aor;
                opts.callee.name = participants[finalCalleePid].name || opts.callee.name;
              }
              debug('[parser] [SRC] caller/callee rule: x_part_leg (caller only) — caller aor=%s callee aor=%s (deduced)',
                opts.caller.aor, opts.callee.aor);
            } else if (legCalleePid) {
              // Callee explicit — caller deduced as the other participant
              finalCalleePid = legCalleePid;
              finalCallerPid = Object.keys(participants).find((pid) => pid !== legCalleePid) || null;
              opts.callee.aor  = participants[legCalleePid].aor  || opts.callee.aor;
              opts.callee.name = participants[legCalleePid].name || opts.callee.name;
              if (finalCallerPid) {
                opts.caller.aor  = participants[finalCallerPid].aor  || opts.caller.aor;
                opts.caller.name = participants[finalCallerPid].name || opts.caller.name;
              }
              debug('[parser] [SRC] caller/callee rule: x_part_leg (callee only) — caller aor=%s (deduced) callee aor=%s',
                opts.caller.aor, opts.callee.aor);
            } else {
              // No x_part_leg — stream label
              if (!streamCallerPid) debug('[parser] [SRC] WARNING: caller participant_id undetermined');
              if (!streamCalleePid) debug('[parser] [SRC] WARNING: callee participant_id undetermined');
              finalCallerPid = streamCallerPid;
              finalCalleePid = streamCalleePid;
              debug('[parser] [SRC] caller/callee rule: stream label — caller aor=%s callee aor=%s',
                opts.caller.aor, opts.callee.aor);
            }

            if (finalCallerPid) {
              const cp = participants[finalCallerPid];
              opts.caller.participantId = cp.participantId;
              opts.caller.partLeg       = cp.partLeg;
              opts.caller.partType      = cp.partType;
              opts.caller.partId        = cp.partId;
              debug('[parser] [SRC] caller enriched: participantId=%s partLeg=%s partType=%s partId=%s',
                cp.participantId, cp.partLeg, cp.partType, cp.partId);
            }
            if (finalCalleePid) {
              const ep = participants[finalCalleePid];
              opts.callee.participantId = ep.participantId;
              opts.callee.partLeg       = ep.partLeg;
              opts.callee.partType      = ep.partType;
              opts.callee.partId        = ep.partId;
              debug('[parser] [SRC] callee enriched: participantId=%s partLeg=%s partType=%s partId=%s',
                ep.participantId, ep.partLeg, ep.partType, ep.partId);
            }
          }

          // now for Sonus (at least) we get the original from, to and call-id headers in a <callData/> element
          // if so, this should take preference
          const callData = parseCallData(prefix, obj);
          if (callData) {
            debug(`callData: ${JSON.stringify(callData)}`);
            opts.originalCallId = callData.callid;

            // caller
            let r1 = /^(.*)(<sip.*)$/.exec(callData.fromhdr);
            if (r1) {
              const arr = /<(.*)>/.exec(r1[2]);
              if (arr) {
                const uri = parseUri(arr[1]);
                const user = uri.user || 'anonymous';
                opts.caller.aor = `sip:${user}@${uri.host}`;
              }
              const dname = r1[1].trim();
              const arr2 = /"(.*)"/.exec(dname);
              if (arr2) opts.caller.name = arr2[1];
              else opts.caller.name = dname;
            }
            // callee
            r1 = /^(.*)(<sip.*)$/.exec(callData.tohdr);
            if (r1) {
              const arr = /<(.*)>/.exec(r1[2]);
              if (arr) {
                const uri = parseUri(arr[1]);
                opts.callee.aor = `sip:${uri.user}@${uri.host}`;
              }
              const dname = r1[1].trim();
              const arr2 = /"(.*)"/.exec(dname);
              if (arr2) opts.callee.name = arr2[1];
              else opts.callee.name = dname;
            }
            debug(`opts.caller from callData: ${JSON.stringify(opts.caller)}`);
            debug(`opts.callee from callData: ${JSON.stringify(opts.callee)}`);
          }

          if (opts.caller.aor && 0 !== opts.caller.aor.indexOf('sip:')) {
            opts.caller.aor = 'sip:' + opts.caller.aor;
          }
          if (opts.callee.aor && 0 !== opts.callee.aor.indexOf('sip:')) {
            opts.callee.aor = 'sip:' + opts.callee.aor;
          }

          if (opts.caller.aor) {
            const uri = parseUri(opts.caller.aor);
            if (uri) opts.caller.number = uri.user;
            else {
              const arr = /sip:(.*)@/.exec(opts.caller.aor);
              opts.caller.number = arr[1];
            }
          }
          if (opts.callee.aor) {
            const uri = parseUri(opts.callee.aor);
            if (uri) opts.callee.number = uri.user;
            else {
              const arr = /sip:(.*)@/.exec(opts.callee.aor);
              opts.callee.number = arr[1];
            }
          }
          opts.recordingSessionId = opts.recordingData[`${prefix}recording`]?.[`${prefix}session`]?.[0]?.$?.session_id;

          const rawMetaCsDirec = obj[`${prefix}session`]?.[0]?.x_cs_info?.[0]?.x_cs_direc?.[0];
          const rawSipCsDirec  = opts.req?.get?.('X-cs-direc');
          let cs_direc;
          if (rawMetaCsDirec) {
            cs_direc = VALID_CS_DIREC.includes(rawMetaCsDirec) ? rawMetaCsDirec : null;
          } else if (rawSipCsDirec) {
            cs_direc = VALID_CS_DIREC.includes(rawSipCsDirec) ? rawSipCsDirec : null;
          } else {
            cs_direc = 'incoming';
          }
          opts.siprec = {
            group_id:       obj[`${prefix}group`]?.[0]?.$?.group_id || null,
            session_id:     opts.recordingSessionId,
            cs_direc,
            associate_time: obj[`${prefix}group`]?.[0]?.[`${prefix}associate-time`]?.[0] || null,
          };
          debug('[parser] [SRC] siprec: group_id=%s session_id=%s cs_direc=%s',
            opts.siprec.group_id, opts.siprec.session_id, opts.siprec.cs_direc);
        }
      }
      catch (err) {
        reject(err);
      }
      debug('payload parser results %s', JSON.stringify({ caller: opts.caller, callee: opts.callee, recordingSessionId: opts.recordingSessionId, recordingData: opts.recordingData }, null, 2));
      resolve(opts) ;
    }) ;
  }) ;
};
