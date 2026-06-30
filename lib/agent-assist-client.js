const config = require('config');
const { URL } = require('url');
const net = require('net');

async function callAgentAssist(updateData, sourceIp, logger) {
  const aaConfig = config.get('aa');
  const { apiCallIP, port, route, apiCallTimeout } = aaConfig;

  const ip = apiCallIP || sourceIp;
  if (!ip || net.isIP(ip) === 0) {
    throw new Error(`Invalid or missing source IP: ${ip}`);
  }

  const apiUrl = new URL(`http://${ip}`);
  apiUrl.port = port;
  apiUrl.pathname = `/${route.replace(/^\/+/, '')}`;

  logger.info(`Calling Agent Assist API: ${apiUrl.href}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiCallTimeout);

  try {
    const response = await fetch(apiUrl.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Agent Assist API responded with status ${response.status}`);
    }

    logger.info('Agent Assist API call successful');
    return response;
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      throw new Error(`Agent Assist API timeout after ${apiCallTimeout}ms`);
    }
    throw fetchErr;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = callAgentAssist;
