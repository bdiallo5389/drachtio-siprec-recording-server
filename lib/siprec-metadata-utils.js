const debug = require('debug')('drachtio:siprec-recording-server');

const VALID_PART_LEG  = ['caller', 'callee'];
const VALID_PART_TYPE = ['client', 'agent', 'other'];

/**
 * Resolve the (possibly namespace-prefixed) <recording> root of a parsed SIPREC XML document,
 * mirroring the prefix-detection already used for the initial INVITE in payload-parser.js.
 * @param {object} result - output of xml2js.parseString
 * @returns {{prefix: string, obj: object}|null}
 */
function getRecordingRoot(result) {
  if (typeof result !== 'object' || result === null || Object.keys(result).length !== 1) {
    debug('[siprec-metadata-utils] getRecordingRoot: not a single-root XML document -> null');
    return null;
  }
  const key = Object.keys(result)[0];
  const arr = /^(.*:)recording/.exec(key);
  const prefix = !arr ? '' : arr[1];
  const obj = result[`${prefix}recording`];
  if (!obj) {
    debug('[siprec-metadata-utils] getRecordingRoot: no <%s> element under key "%s" -> null', `${prefix}recording`, key);
    return null;
  }
  debug('[siprec-metadata-utils] getRecordingRoot -> prefix="%s"', prefix);
  return { prefix, obj };
}

/**
 * Resolve caller/callee from a <participant> list using x_part_leg (preferred), falling back to
 * document order (first participant = caller, second = callee) when x_part_leg is absent or only
 * partially present. Simplified relative to payload-parser.js's initial-INVITE resolution (no
 * stream-label deduction, no Sonus callData fallback): re-INVITE/UPDATE payloads reliably carry
 * x_part_info.
 * @returns {{caller: object, callee: object}} each with {participantId, aor, name, partLeg, partType, partId}
 */
function resolveParticipantsSimple(obj, prefix) {
  const list = obj[`${prefix}participant`];
  const participants = {};
  const order = [];

  if (Array.isArray(list)) {
    list.forEach((p) => {
      const id = p?.$?.participant_id;
      if (!id) return;
      order.push(id);
      const details = { participantId: id };
      if (Array.isArray(p[`${prefix}nameID`])) {
        details.aor = p[`${prefix}nameID`][0]?.$?.aor;
        const name = p[`${prefix}nameID`][0]?.name?.[0];
        if (typeof name === 'string') details.name = name;
        else if (typeof name === 'object' && name) details.name = name._;
      }
      const xpi = p.x_part_info?.[0] || {};
      const rawPartLeg  = xpi.x_part_leg?.[0];
      const rawPartType = xpi.x_part_type?.[0];
      details.partLeg  = VALID_PART_LEG.includes(rawPartLeg)   ? rawPartLeg  : null;
      details.partType = VALID_PART_TYPE.includes(rawPartType) ? rawPartType : null;
      details.partId   = xpi.x_part_id?.[0] || null;
      participants[id] = details;
    });
  }

  let callerId = order.find((id) => participants[id].partLeg === 'caller');
  let calleeId = order.find((id) => participants[id].partLeg === 'callee');

  if (!callerId && !calleeId) {
    // No explicit x_part_leg anywhere — fall back to document order
    callerId = order[0];
    calleeId = order[1];
  } else if (!callerId) {
    callerId = order.find((id) => id !== calleeId);
  } else if (!calleeId) {
    calleeId = order.find((id) => id !== callerId);
  }

  const result = {
    caller: callerId ? { ...participants[callerId] } : {},
    callee: calleeId ? { ...participants[calleeId] } : {},
  };
  debug('[siprec-metadata-utils] resolveParticipantsSimple -> %j', result);
  return result;
}

/**
 * Extract x_call_id_1 / x_call_id_2 / x_cs_direc from <session><x_cs_info>.
 * x_ elements are custom Zaion extensions and, consistently with x_part_info elsewhere
 * in this codebase, are not namespace-prefixed even when the surrounding RS-metadata is.
 */
function extractCsInfo(obj, prefix) {
  const csInfo = obj[`${prefix}session`]?.[0]?.x_cs_info?.[0] || {};
  const result = {
    call_id_1: csInfo.x_call_id_1?.[0] || undefined,
    call_id_2: csInfo.x_call_id_2?.[0] || undefined,
    cs_direc:  csInfo.x_cs_direc?.[0]  || undefined,
  };
  debug('[siprec-metadata-utils] extractCsInfo -> %j', result);
  return result;
}

/**
 * Session-level association/dissociation time, from <sessionrecordingassoc>.
 */
function extractSessionRecordingAssoc(obj, prefix) {
  const assoc = obj[`${prefix}sessionrecordingassoc`]?.[0] || {};
  const result = {
    associate_time:  assoc[`${prefix}associate-time`]?.[0]  || undefined,
    dissociate_time: assoc[`${prefix}dissociate-time`]?.[0] || undefined,
  };
  debug('[siprec-metadata-utils] extractSessionRecordingAssoc -> %j', result);
  return result;
}

/**
 * Per-participant association/dissociation time and x_event, from <participantsessionassoc>.
 * @returns {Map<string, {associate_time: string|undefined, dissociate_time: string|undefined, x_event: string|undefined}>}
 */
function extractParticipantAssoc(obj, prefix) {
  const list = obj[`${prefix}participantsessionassoc`];
  const map = new Map();
  if (!Array.isArray(list)) {
    debug('[siprec-metadata-utils] extractParticipantAssoc -> no participantsessionassoc elements');
    return map;
  }

  list.forEach((p) => {
    const id = p?.$?.participant_id;
    if (!id) return;
    map.set(id, {
      associate_time:  p[`${prefix}associate-time`]?.[0]  || undefined,
      dissociate_time: p[`${prefix}dissociate-time`]?.[0] || undefined,
      x_event:         p.x_event?.[0] || undefined,
    });
  });

  debug('[siprec-metadata-utils] extractParticipantAssoc -> %j', [...map.entries()]);
  return map;
}

/**
 * Map each participant_id to the SDP media-line label carrying their own (sent) audio, via
 * <participantstreamassoc> (participant -> send stream_id) and <stream> (stream_id -> label).
 * Used to resolve, for a given participant, their actual SDP direction rather than assuming
 * a fixed line-1/line-2 position.
 * @returns {Map<string, string>} participant_id -> label
 */
function resolveParticipantLabels(obj, prefix) {
  const streamAssocList = obj[`${prefix}participantstreamassoc`];
  const streamList      = obj[`${prefix}stream`];

  const labelByStreamId = new Map();
  if (Array.isArray(streamList)) {
    streamList.forEach((s) => {
      const streamId = s?.$?.stream_id;
      const label = s?.[`${prefix}label`]?.[0];
      if (streamId && label !== undefined) labelByStreamId.set(streamId, label);
    });
  }

  const labelByParticipantId = new Map();
  if (Array.isArray(streamAssocList)) {
    streamAssocList.forEach((p) => {
      const id = p?.$?.participant_id;
      const sendStreamId = p[`${prefix}send`]?.[0];
      if (id && sendStreamId && labelByStreamId.has(sendStreamId)) {
        labelByParticipantId.set(id, labelByStreamId.get(sendStreamId));
      }
    });
  }

  debug('[siprec-metadata-utils] resolveParticipantLabels -> %j', [...labelByParticipantId.entries()]);
  return labelByParticipantId;
}

module.exports = {
  VALID_PART_LEG,
  VALID_PART_TYPE,
  getRecordingRoot,
  resolveParticipantsSimple,
  extractCsInfo,
  extractSessionRecordingAssoc,
  extractParticipantAssoc,
  resolveParticipantLabels,
};
