const { URL } = require('url');
const net = require('net');
const debug = require('debug')('drachtio:siprec-recording-server');

/**
 * POST a notification payload to the AA API.
 * Shared by the SIPREC UPDATE handler and the hold/resume re-INVITE handler.
 * @param {object} logger
 * @param {object} opts - { ip, port, route, apiCallTimeout }
 * @param {object} payload - JSON body to POST
 * @returns {Promise<boolean>} true on success, false on any error
 */
async function notifyApi(logger, { ip, port, route, apiCallTimeout }, payload) {
  if (!ip || net.isIP(ip) === 0) {
    logger.error({ ip }, 'notifyApi: invalid or missing API server IP');
    return false;
  }

  const apiUrl = new URL(`http://${ip}`);
  apiUrl.port = port;
  apiUrl.pathname = `/${route.replace(/^\/+/, '')}`;

  debug('[notifier] POST %s event=%s', apiUrl.href, payload.event || 'n/a');
  logger.info({ url: apiUrl.href, event: payload.event || 'n/a' }, 'Calling AA API');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiCallTimeout);

  try {
    const response = await fetch(apiUrl.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      logger.error({ status: response.status, url: apiUrl.href }, 'notifyApi: API error response');
      return false;
    }
    logger.info({ url: apiUrl.href }, 'notifyApi: success');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.error({ url: apiUrl.href, apiCallTimeout }, 'notifyApi: request timed out');
    } else {
      logger.error({ err: err.message, url: apiUrl.href }, 'notifyApi: network error');
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = notifyApi;
