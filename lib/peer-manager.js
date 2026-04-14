const fs = require('fs');
const chokidar = require('chokidar');
const EventEmitter = require('events');

class PeerManager extends EventEmitter {

  constructor(file, logger) {

    super();

    this.file = file;
    this.logger = logger;
    this.peers = [];

    this.load();
    this.watch();

  }

  load() {

    try {

      const data = fs.readFileSync(this.file);

      const newPeers = JSON.parse(data);

      this.peers = newPeers;

      this.logger.info(
        { count: this.peers.length },
        "SIP peers loaded"
      );

      // change notify to the monitor
      this.emit('update', this.peers);

    }
    catch(err) {

      this.logger.error(err, "Failed loading peers file");

    }
  }

  watch() {

    chokidar.watch(this.file)
      .on("change", () => {

        this.logger.info("Peers file updated");

        this.load();

      });

  }

  getPeers() {

    return this.peers;

  }

}

module.exports = PeerManager;