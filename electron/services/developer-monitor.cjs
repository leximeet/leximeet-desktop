const { performance, monitorEventLoopDelay } = require("node:perf_hooks");

// 只保留本进程数值聚合。默认不创建采集器；关闭即释放采集器和历史计数。
class DeveloperMonitor {
  constructor({ processes = () => [], now = () => performance.now() } = {}) {
    this.processes = processes;
    this.now = now;
    this.started = now();
    this.enabled = false;
    this.startup = {
      mainReadyMs: null,
      windowReadyMs: null,
      coreReadyMs: null,
      firstSnapshotMs: null,
    };
    this.operations = new Map();
  }
  mark(name) {
    // 仅四个启动时刻，固定空间、无轮询；即使监控默认关闭也可用于启动故障定位。
    if (Object.hasOwn(this.startup, name) && this.startup[name] === null)
      this.startup[name] = this.now() - this.started;
  }
  setEnabled(value) {
    const enabled = value === true;
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation = (this.generation || 0) + 1;
    this.operations.clear();
    if (enabled) {
      this.cpu = process.cpuUsage();
      this.cpuAt = this.now();
      this.delay = monitorEventLoopDelay({ resolution: 20 });
      this.delay.enable();
    } else {
      this.delay?.disable();
      this.delay = null;
      this.cpu = null;
    }
  }
  measure(method, operation) {
    if (!this.enabled) return operation();
    const start = this.now(),
      generation = this.generation;
    const finish = (failed) => {
      if (!this.enabled || generation !== this.generation) return;
      // method 必须来自主进程固定白名单，不接收 payload、URL、词条 ID 或错误正文。
      if (!this.operations.has(method) && this.operations.size >= 32) return;
      const item = this.operations.get(method) || {
        method,
        count: 0,
        errorCount: 0,
        totalMs: 0,
        maxMs: 0,
      };
      const elapsed = Math.max(0, this.now() - start);
      item.count++;
      item.errorCount += failed ? 1 : 0;
      item.totalMs += elapsed;
      item.maxMs = Math.max(item.maxMs, elapsed);
      this.operations.set(method, item);
    };
    try {
      const value = operation();
      // 保留已有同步校验错误的语义，不把所有 bridge 方法强行改成 Promise。
      if (value?.then)
        return value.then(
          (result) => {
            finish(false);
            return result;
          },
          (error) => {
            finish(true);
            throw error;
          },
        );
      finish(false);
      return value;
    } catch (error) {
      finish(true);
      throw error;
    }
  }
  snapshot() {
    if (!this.enabled) return { enabled: false };
    const memory = process.memoryUsage(),
      cpu = process.cpuUsage(),
      at = this.now();
    const cpuPercent = Math.max(
      0,
      ((cpu.user - this.cpu.user + (cpu.system - this.cpu.system)) /
        Math.max(1, (at - this.cpuAt) * 1000)) *
        100,
    );
    this.cpu = cpu;
    this.cpuAt = at;
    const finite = (value) => (Number.isFinite(value) ? value : 0);
    const result = {
      enabled: true,
      collectedAt: new Date().toISOString(),
      startup: { ...this.startup },
      main: {
        uptimeMs: process.uptime() * 1000,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        cpuPercent,
        eventLoopMeanMs: finite(this.delay.mean / 1e6),
        eventLoopMaxMs: finite(this.delay.max / 1e6),
      },
      processes: this.processes()
        .slice(0, 32)
        .map((item) => ({
          type: String(item.type),
          cpuPercent: finite(item.cpu?.percentCPUUsage),
          workingSetBytes: finite(item.memory?.workingSetSize) * 1024,
        })),
      operations: [...this.operations.values()].map(({ totalMs, ...item }) => ({
        ...item,
        averageMs: totalMs / item.count,
      })),
    };
    this.delay.reset();
    return result;
  }
  close() {
    this.setEnabled(false);
  }
}
module.exports = { DeveloperMonitor };
