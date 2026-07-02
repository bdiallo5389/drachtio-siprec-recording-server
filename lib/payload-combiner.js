const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');

module.exports = function(sdp1, sdp2, originalSdp1, originalSdp2) {
  const sdpObj = [];
  sdpObj.push(transform.parse(sdp1));
  sdpObj.push(transform.parse(sdp2));
  const originalParsedSdp1 = transform.parse(originalSdp1);
  const originalParsedSdp2 = transform.parse(originalSdp2);

  debug(`sdp1:      ${sdp1}`);
  debug(`objSdp[0]: ${JSON.stringify(sdpObj[0])}`);
  debug(`sdp2:      ${sdp2}`);
  debug(`objSdp[1]: ${JSON.stringify(sdpObj[1])}`);

  if (!sdpObj[0] || !sdpObj[0].media.length) {
    throw new Error(`Error parsing sdp1 into component parts: ${sdp1}`);
  }
  else if (!sdpObj[1] || !sdpObj[1].media.length)  {
    throw new Error(`Error parsing sdp2 into component parts: ${sdp2}`);
  }

  if (!sdpObj[0].media[0].label) sdpObj[0].media[0].label = originalParsedSdp1.media[0].label;
  if (!sdpObj[1].media[0].label) sdpObj[1].media[0].label = originalParsedSdp2.media[0].label;
  // Update SDP Direction
  if (originalParsedSdp1.media[0].direction === 'inactive') {
    sdpObj[0].media[0].direction = 'inactive';
  } else {
    sdpObj[0].media[0].direction = 'recvonly';
  }
  if (originalParsedSdp2.media[0].direction === 'inactive') {
    sdpObj[1].media[0].direction = 'inactive';
  } else {
    sdpObj[1].media[0].direction = 'recvonly';
  }

  sdpObj[0].media = sdpObj[0].media.concat(sdpObj[1].media);
  const combinedSdp = transform.write(sdpObj[0])
    .replace(/a=direction:both\r\n/g, '');

  debug(`combined ${combinedSdp}`);
  return combinedSdp;
};

