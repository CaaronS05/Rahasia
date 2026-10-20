/**
 * Shared Global Rate Limiter for Benchmark Workers.
 * Coordinates in-flight concurrency, dispatch interval pacing, and 429 backoff.
 */
export class RateLimiter {
  constructor({
    maxInFlight = 1,
    minIntervalMs = 250,
  } = {}) {
    this.maxInFlight = Math.max(1, maxInFlight);
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.activeRequests = 0;
    this.queue = [];
    this.lastDispatchTime = 0;
    this.pausedUntil = 0;
    this.timer = null;
  }

  async acquireSlot() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._drainQueue();
    });
  }

  releaseSlot() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this._drainQueue();
  }

  triggerBackoff(delayMs) {
    const pauseTime = Date.now() + Math.max(0, delayMs);
    if (pauseTime > this.pausedUntil) {
      this.pausedUntil = pauseTime;
    }
    this._scheduleDrain();
  }

  _scheduleDrain() {
    clearTimeout(this.timer);
    const now = Date.now();
    const waitMs = Math.max(
      0,
      this.pausedUntil - now,
      this.lastDispatchTime + this.minIntervalMs - now
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this._drainQueue();
    }, waitMs);
  }

  _drainQueue() {
    if (this.queue.length === 0) return;

    const now = Date.now();
    if (now < this.pausedUntil) {
      this._scheduleDrain();
      return;
    }

    if (now < this.lastDispatchTime + this.minIntervalMs) {
      this._scheduleDrain();
      return;
    }

    if (this.activeRequests >= this.maxInFlight) {
      return;
    }

    this.activeRequests++;
    this.lastDispatchTime = Date.now();
    const nextResolve = this.queue.shift();
    if (nextResolve) {
      nextResolve();
    }

    if (this.queue.length > 0 && this.activeRequests < this.maxInFlight) {
      this._scheduleDrain();
    }
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.activeRequests = 0;
  }
}
