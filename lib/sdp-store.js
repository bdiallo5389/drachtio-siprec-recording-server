const redis = require('redis');
const config = require('config');

function createSdpStore(logger) {
  const isTest = process.env.NODE_ENV === 'test';
  const redisOpts = isTest ? { reconnectStrategy: () => false } : {};

  const clientPromise = redis.createClient({
    socket: {
      port: config.get('redis.port'),
      host: config.get('redis.host'),
      ...redisOpts
    }
  }).connect();

  clientPromise.then((client) => {
    logger.info(`successfully connected to redis at ${config.get('redis.host')}:${config.get('redis.port')}`);
    client.on('error', (err) => {
      if (isTest && err.constructor.name === 'SocketClosedUnexpectedlyError') return;
      logger.error(err, 'redis error');
    });
  }, (err) => {
    logger.error(err, 'redis connection error');
  });

  return {
    async store(sessionId, sdp) {
      const client = await clientPromise;
      await client.set(sessionId, sdp, { EX: 10 });
    },

    async get(sessionId) {
      const client = await clientPromise;
      return client.get(sessionId);
    },

    async exchange(sessionId, sdp) {
      const client = await clientPromise;
      const [oldSdp] = await client.multi()
        .get(sessionId)
        .set(sessionId, sdp, { EX: 10 })
        .exec();
      return oldSdp;
    }
  };
}

module.exports = createSdpStore;
