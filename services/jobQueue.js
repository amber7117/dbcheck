const CONCURRENCY = Math.max(1, parseInt(process.env.CRAWLER_CONCURRENCY || '1', 10));

class JobQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  push(jobFn) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const res = await jobFn();
          resolve(res);
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
          this._drain();
        }
      };

      this.queue.push(task);
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      this.active++;
      next();
    }
  }
}

const globalQueue = new JobQueue(CONCURRENCY);
module.exports = globalQueue;
