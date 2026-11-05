import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

export class ResourceSampler {
  constructor({ intervalMs = 100, eventLoopResolutionMs = 10 } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid sampling interval');
    this.intervalMs = intervalMs;
    this.eventLoopResolutionMs = eventLoopResolutionMs;
    this.running = false;
  }

  start() {
    if (this.running) throw new Error('Resource sampler is already running');
    this.running = true;
    this.started = performance.now();
    this.cpuStart = process.cpuUsage();
    this.rssStartBytes = process.memoryUsage.rss();
    this.rssPeakBytes = this.rssStartBytes;
    this.sampleCount = 0;
    this.gcCount = 0;
    this.gcDurationMs = 0;
    this.gcAvailable = PerformanceObserver.supportedEntryTypes.includes('gc');
    if (this.gcAvailable) {
      this.observer = new PerformanceObserver(list => this.recordGC(list.getEntries()));
      this.observer.observe({ entryTypes: ['gc'] });
    }
    this.histogram = monitorEventLoopDelay({ resolution: this.eventLoopResolutionMs });
    this.histogram.enable();
    this.timer = setInterval(() => {
      this.sampleCount++;
      this.rssPeakBytes = Math.max(this.rssPeakBytes, process.memoryUsage.rss());
    }, this.intervalMs);
    this.timer.unref();
    return this;
  }

  recordGC(entries) {
    for (const entry of entries) {
      if (entry.startTime < this.started) continue;
      this.gcCount++;
      this.gcDurationMs += entry.duration;
    }
  }

  stop() {
    if (!this.running) throw new Error('Resource sampler is not running');
    clearInterval(this.timer);
    const elapsedSeconds = (performance.now() - this.started) / 1000;
    const cpu = process.cpuUsage(this.cpuStart);
    const rssEndBytes = process.memoryUsage.rss();
    this.rssPeakBytes = Math.max(this.rssPeakBytes, rssEndBytes);
    this.histogram.disable();
    if (this.observer) {
      this.recordGC(this.observer.takeRecords());
      this.observer.disconnect();
    }
    this.running = false;
    const delayAvailable = this.histogram.count > 0;
    return { elapsedSeconds, samplingIntervalMs: this.intervalMs, rssSampleCount: this.sampleCount + 2,
      rssStartBytes: this.rssStartBytes, rssEndBytes, rssPeakBytes: this.rssPeakBytes,
      rssPeakMiB: this.rssPeakBytes / 1048576,
      cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      cpuPercent: elapsedSeconds ? (cpu.user + cpu.system) / (elapsedSeconds * 10000) : null,
      eventLoopMeanMs: delayAvailable ? this.histogram.mean / 1000000 : null,
      eventLoopP95Ms: delayAvailable ? this.histogram.percentile(95) / 1000000 : null,
      eventLoopP99Ms: delayAvailable ? this.histogram.percentile(99) / 1000000 : null,
      eventLoopMaxMs: delayAvailable ? this.histogram.max / 1000000 : null,
      gcCount: this.gcAvailable && this.sampleCount > 0 ? this.gcCount : null, gcDurationMs: this.gcAvailable && this.sampleCount > 0 ? this.gcDurationMs : null,
      gcMs: this.gcAvailable && this.sampleCount > 0 ? this.gcDurationMs : null, clientCpuPercent: null };
  }
}
