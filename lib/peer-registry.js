let ipToName = new Map();

module.exports = {
  update(peers) {
    ipToName = new Map(peers.map(p => [p.host, p.name]));
  },
  resolve(ip) {
    return ipToName.get(ip) || ip;
  }
};
