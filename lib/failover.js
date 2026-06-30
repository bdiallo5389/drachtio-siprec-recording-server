const config = require('config');
const Srf = require('drachtio-srf');
const { getAvailableFreeswitch } = require('./utils');
const debug = require('debug')('drachtio:siprec-recording-server');

const CALL_TIMEOUT_MS = 1350;

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error('MEDIA_TIMEOUT'));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise
  ]);
}

function createTryConnect(srf, req, res, callOpts, logger) {
  const servers = config.get('freeswitch');
  const maxAttempts = servers.length;
  const tried = new Set();
  let attempt = 0;

  function tryConnect() {
    const candidates = servers.filter((s) => !tried.has(s));
    if (candidates.length === 0) return Promise.resolve(null);

    const fsUri = candidates[0];
    tried.add(fsUri);
    attempt++;

    debug(`tryConnect ATTEMPT: ${attempt}/${maxAttempts} -> ${fsUri}`);

    let inviteSent;
    let cancelRequested = false;

    const b2buaPromise = srf.createB2BUA(req, res, fsUri, callOpts, {
      cbRequest: (error, reqSent) => {
        inviteSent = reqSent;
        if (cancelRequested && inviteSent) inviteSent.cancel();
      }
    });

    return withTimeout(b2buaPromise, CALL_TIMEOUT_MS, () => {
      debug(`Timeout waiting media server ${fsUri}`);
      cancelRequested = true;
      if (inviteSent) inviteSent.cancel();
    })
      .catch((err) => {
        if (err.message === 'MEDIA_TIMEOUT') {
          logger.warn(`Media server ${fsUri} did not respond in time`);
        } else if (err instanceof Srf.SipError && err.status === 487) {
          logger.warn('Caller cancelled');
          return;
        } else {
          logger.warn({ err }, `Connection to ${fsUri} failed`);
        }

        if (attempt < maxAttempts && tried.size < maxAttempts) return tryConnect();
        throw err;
      });
  }

  return tryConnect;
}

module.exports = { createTryConnect, withTimeout };
