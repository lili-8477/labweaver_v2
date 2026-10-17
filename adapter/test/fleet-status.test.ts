import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FleetMonitor, PING_SUBJECT, STALE_MS, STATUS_SUBJECT, StatusReporter, readUsage,
  type ContainerStatus,
} from "../src/fleet-status.js";

/** An in-memory bus: publish delivers synchronously to subscribers. */
function fakeBus() {
  const subs = new Map<string, ((b: unknown) => void)[]>();
  const sent: { subject: string; body: Record<string, unknown> }[] = [];
  return {
    sent,
    publish: (subject: string, body: Record<string, unknown>) => {
      sent.push({ subject, body });
      for (const cb of subs.get(subject) ?? []) cb(body);
    },
    subscribe: (subject: string, cb: (b: unknown) => void) => {
      subs.set(subject, [...(subs.get(subject) ?? []), cb]);
    },
  };
}

function cgroup(memory: string, max: string, usageUsec: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-"));
  writeFileSync(path.join(dir, "memory.current"), memory);
  writeFileSync(path.join(dir, "memory.max"), max);
  writeFileSync(path.join(dir, "cpu.stat"), `usage_usec ${usageUsec}\nuser_usec 1\n`);
  return dir;
}

describe("readUsage", () => {
  it("reads cgroup v2 memory and cpu, treating 'max' as no limit", async () => {
    expect(await readUsage(cgroup("1024\n", "max\n", 500))).toEqual({
      memoryBytes: 1024, memoryLimitBytes: null, cpuUsageUsec: 500,
    });
    expect((await readUsage(cgroup("1", "4096", 0))).memoryLimitBytes).toBe(4096);
  });

  it("falls back to the process when there is no cgroup", async () => {
    const u = await readUsage("/nonexistent");
    expect(u.memoryBytes).toBeGreaterThan(0);
    expect(u.memoryLimitBytes).toBeNull();
  });
});

describe("StatusReporter + FleetMonitor", () => {
  it("reports on ping and the manager lists reporters and silent roster users", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => ["ghost", "user1"], pingWaitMs: 0 });
    monitor.start();
    const reporter = new StatusReporter({
      ...bus, username: "user1", role: "user",
      activity: () => ({ activeTurns: 2, kernels: 1 }),
      cgroupRoot: cgroup("2048", "max", 100),
    });
    bus.subscribe(PING_SUBJECT, () => {}); // the ping is broadcast
    reporter.start();
    reporter.stop();
    await new Promise((r) => setTimeout(r, 10)); // let the first report land

    const list = await monitor.list();
    expect(bus.sent.some((m) => m.subject === PING_SUBJECT)).toBe(true);
    expect(list.map((e) => [e.username, e.online])).toEqual([["ghost", false], ["user1", true]]);
    expect(list[1]!.status).toMatchObject({ username: "user1", role: "user", memoryBytes: 2048, activeTurns: 2, kernels: 1 });
  });

  it("marks a container offline once its last report is stale", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => [], pingWaitMs: 0 });
    monitor.start();
    bus.publish(STATUS_SUBJECT, { username: "u", reportedAt: 1000 } as Partial<ContainerStatus>);
    expect((await monitor.list(() => 1000 + STALE_MS - 1))[0]!.online).toBe(true);
    expect((await monitor.list(() => 1000 + STALE_MS))[0]!.online).toBe(false);
  });

  it("ignores malformed reports", async () => {
    const bus = fakeBus();
    const monitor = new FleetMonitor({ ...bus, roster: async () => [], pingWaitMs: 0 });
    monitor.record(null);
    monitor.record({ username: 5 });
    expect(await monitor.list()).toEqual([]);
  });
});
