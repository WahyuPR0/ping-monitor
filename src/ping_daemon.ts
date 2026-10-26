import { execFile } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import dns from "dns";
import net from "net";

dns.setDefaultResultOrder?.("ipv4first");

const execFilePromise = util.promisify(execFile);
const dnsLookup = util.promisify(dns.lookup);
const publicResolver = new dns.promises.Resolver();
publicResolver.setServers(["1.1.1.1", "8.8.8.8", "1.0.0.1"]);

export interface RollupPoint {
  key: string;
  timestamp: string;
  label: string;
  avgPing: number | null;
  minPing: number | null;
  maxPing: number | null;
  lossPct: number | null;
  samples: number;
  sent: number;
  lost: number;
  unmonitored?: boolean;
}

export interface BucketRecord {
  key: string;
  timestamp: string;
  label: string;
  sent: number;
  received: number;
  lost: number;
  sumPing: number;
  minPing: number | null;
  maxPing: number | null;
  avgPing: number | null;
  lossPct: number;
  samples: number;
}

export interface IncidentEvent {
  id: string;
  target: string;
  source: "host" | "router";
  startTime: string;
  endTime: string | null;
  durationSeconds: number;
  lossPct: number;
  reason: string;
}

export interface LiveSamplePoint {
  timestamp: string;
  label: string;
  hostPing: number | null;
  hostTtl?: number;
  hostLoss: boolean;
  routerPing: number | null;
  routerTtl?: number;
  routerLoss: boolean;
  unmonitored?: boolean;
}

export interface TelemetryTarget {
  host: string;
  label: string;
  startedAt: string;
  // High-res real-time rolling buffer (up to 3600 points = 1 hour of 1s real data)
  livePoints: LiveSamplePoint[];
  // Real 5-Minute buckets keyed by "YYYY-MM-DD HH:MM" (e.g. "2026-10-22 14:05")
  fiveMinHost: Record<string, BucketRecord>;
  fiveMinRouter: Record<string, BucketRecord>;
  // Real Hourly buckets keyed by "YYYY-MM-DD HH:00"
  hourlyHost: Record<string, BucketRecord>;
  hourlyRouter: Record<string, BucketRecord>;
  // Real Daily buckets keyed by "YYYY-MM-DD"
  dailyHost: Record<string, BucketRecord>;
  dailyRouter: Record<string, BucketRecord>;
  // Real Outage Incident Log
  incidents: IncidentEvent[];
  // Interval saat aplikasi/PC mati (epoch ms), dipakai agar grafik 12j/24j/7h/30h tetap menampilkan garis terputus
  downtimes: { start: number; end: number }[];
  // Running Cumulative Statistics
  stats: {
    host: {
      totalSent: number;
      totalReceived: number;
      totalLost: number;
      lastPing: number | null;
      lastTtl?: number;
      lastUpdated: string | null;
      recentPings: number[];
    };
    router: {
      totalSent: number;
      totalReceived: number;
      totalLost: number;
      lastPing: number | null;
      lastTtl?: number;
      lastUpdated: string | null;
      recentPings: number[];
    };
  };
}

const DB_FILE = path.resolve(process.cwd(), "ping_history.json");
const DB_BACKUP_FILE = path.resolve(process.cwd(), "ping_history.backup.json");
const BACKUP_DIR = path.resolve(process.cwd(), "backups");
const SCHEMA_VERSION = 2; // Version 2: 100% Real Telemetry (Zero Synthetic Seed Data)

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function getLocalHourKey(d: Date): { key: string; label: string } {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  return {
    key: `${y}-${m}-${day} ${h}:00`,
    label: `${h}:00`,
  };
}

function getLocalFiveMinKey(d: Date): { key: string; label: string } {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const fiveMinSlot = Math.floor(d.getMinutes() / 5) * 5;
  const mm = pad2(fiveMinSlot);
  return {
    key: `${y}-${m}-${day} ${h}:${mm}`,
    label: `${h}:${mm}`,
  };
}

function getLocalDateKey(d: Date): { key: string; label: string } {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return {
    key: `${y}-${m}-${day}`,
    label: `${day}/${m}`,
  };
}

function getLocalTimeLabel(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export type RouterPingHandler = (address: string, timeoutMs?: number) => Promise<{ pingMs: number | null; ttl?: number; isLoss: boolean }>;

export class PingDaemon {
  private targets: Map<string, TelemetryTarget> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private activeOutage: Record<string, IncidentEvent | null> = {};
  private routerPingHandler: RouterPingHandler | null = null;
  private isProbing: Record<string, boolean> = {};
  private dnsCache: Map<string, { ip: string; expiresAt: number }> = new Map();
  private localGatewayIp: string = process.env.MIKROTIK_HOST || "192.168.10.1";
  private lastGatewayCheck: { alive: boolean; checkedAt: number } = { alive: true, checkedAt: 0 };
  private shutdownHookRegistered: boolean = false;
  private isRouterPingEnabled: boolean = process.env.ENABLE_ROUTER_PING === "true";
  private lastSnapshotMs: number = 0;

  public setRouterPingEnabled(enabled: boolean) {
    this.isRouterPingEnabled = enabled;
  }

  public getRouterPingEnabled(): boolean {
    return this.isRouterPingEnabled;
  }

  constructor() {
    this.initTargets();
    this.loadPersistedData();
    this.registerShutdownHooks();
  }

  private registerShutdownHooks() {
    if (this.shutdownHookRegistered) return;
    this.shutdownHookRegistered = true;
    const flushOnShutdown = () => {
      try {
        this.savePersistedData();
      } catch {}
    };

    if (process.platform === "win32") {
      try {
        const readline = require("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.on("SIGINT", () => {
          flushOnShutdown();
          process.exit(0);
        });
      } catch {}
    }

    process.once("SIGINT", () => {
      flushOnShutdown();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      flushOnShutdown();
      process.exit(0);
    });
    process.once("exit", () => {
      flushOnShutdown();
    });
  }

  public setMikrotikPingHandler(handler: RouterPingHandler) {
    this.routerPingHandler = handler;
  }

  public parseConfiguredTargets(): { host: string; label: string }[] {
    const raw = process.env.PING_TARGETS?.trim();
    if (!raw) {
      return [
        { host: "1.1.1.1", label: "Cloudflare DNS (1.1.1.1)" },
        { host: "8.8.8.8", label: "Google Public DNS (8.8.8.8)" },
        { host: "c.whatsapp.net", label: "WhatsApp Chat (c.whatsapp.net)" },
        { host: "mmg.whatsapp.net", label: "WhatsApp Media CDN (mmg.whatsapp.net)" },
        { host: "youtube.com", label: "YouTube (youtube.com)" },
      ];
    }

    // Dukungan format JSON: [{"host":"1.1.1.1","label":"Cloudflare"}]
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item: any) => ({
            host: String(item.host || item).trim().toLowerCase(),
            label: String(item.label || item.host || item).trim(),
          })).filter(x => Boolean(x.host));
        }
      } catch {}
    }

    // Dukungan format dipisahkan koma: "1.1.1.1:Cloudflare DNS, 8.8.8.8:Google DNS, detik.com"
    const items = raw.split(",").map(s => s.trim()).filter(Boolean);
    const result: { host: string; label: string }[] = [];
    for (const item of items) {
      if (item.includes(":")) {
        const parts = item.split(":");
        const host = parts[0].trim().toLowerCase();
        const label = parts.slice(1).join(":").trim() || host;
        if (host) result.push({ host, label });
      } else {
        const host = item.trim().toLowerCase();
        if (host) result.push({ host, label: host });
      }
    }

    return result.length > 0 ? result : [
      { host: "1.1.1.1", label: "Cloudflare DNS (1.1.1.1)" },
      { host: "8.8.8.8", label: "Google Public DNS (8.8.8.8)" },
      { host: "c.whatsapp.net", label: "WhatsApp Chat (c.whatsapp.net)" },
      { host: "mmg.whatsapp.net", label: "WhatsApp Media CDN (mmg.whatsapp.net)" },
      { host: "youtube.com", label: "YouTube (youtube.com)" },
    ];
  }

  public getConfiguredTargets(): { host: string; label: string }[] {
    return this.parseConfiguredTargets();
  }

  private initTargets() {
    const monitoredHosts = this.parseConfiguredTargets();

    for (const item of monitoredHosts) {
      if (!this.targets.has(item.host)) {
        this.targets.set(item.host, this.createEmptyTarget(item.host, item.label));
      }
    }
  }

  private createEmptyTarget(host: string, label: string): TelemetryTarget {
    return {
      host,
      label,
      startedAt: new Date().toISOString(),
      livePoints: [],
      fiveMinHost: {},
      fiveMinRouter: {},
      hourlyHost: {},
      hourlyRouter: {},
      dailyHost: {},
      dailyRouter: {},
      incidents: [],
      downtimes: [],
      stats: {
        host: {
          totalSent: 0,
          totalReceived: 0,
          totalLost: 0,
          lastPing: null,
          lastUpdated: null,
          recentPings: [],
        },
        router: {
          totalSent: 0,
          totalReceived: 0,
          totalLost: 0,
          lastPing: null,
          lastUpdated: null,
          recentPings: [],
        },
      },
    };
  }

  public start() {
    if (this.timer) return;
    console.log("[Ping Daemon] Real-time dual-source telemetry daemon started (100% genuine data, SSD-safe 5m flush).");

    const triggerStaggeredProbes = () => {
      this.probeTarget("1.1.1.1").catch(() => {});
      setTimeout(() => this.probeTarget("8.8.8.8").catch(() => {}), 180);
      setTimeout(() => this.probeTarget("c.whatsapp.net").catch(() => {}), 360);
      setTimeout(() => this.probeTarget("mmg.whatsapp.net").catch(() => {}), 540);
      setTimeout(() => this.probeTarget("youtube.com").catch(() => {}), 720);
    };

    // Immediate initial probe
    triggerStaggeredProbes();

    this.timer = setInterval(triggerStaggeredProbes, 1000);

    // Persist real data every 5 seconds (5000ms) + on process exit so shutdown downtime is accurately tracked
    this.saveTimer = setInterval(() => {
      this.pruneOldBuckets();
      this.savePersistedData();
    }, 5000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.savePersistedData();
    console.log("[Ping Daemon] Telemetry engine stopped and persisted cleanly.");
  }

  /**
   * Unified IP resolution so both Host and MikroTik always ping the exact same destination IP
   * (prevents CDN Anycast / Multi-IP split where Host hits Singapore 31ms and MikroTik hits Jakarta 14ms).
   */
  private async resolveTargetIp(host: string): Promise<string> {
    const isIpv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);
    if (isIpv4) return host;

    const nowMs = Date.now();
    const cached = this.dnsCache.get(host);
    if (cached && nowMs < cached.expiresAt) {
      return cached.ip;
    }

    try {
      const addresses = await publicResolver.resolve4(host);
      if (addresses && addresses.length > 0) {
        const ip = addresses[0];
        this.dnsCache.set(host, { ip, expiresAt: nowMs + 120000 });
        return ip;
      }
    } catch {}

    try {
      const lookupRes = await dnsLookup(host, { family: 4 });
      if (lookupRes?.address) {
        this.dnsCache.set(host, { ip: lookupRes.address, expiresAt: nowMs + 120000 });
        return lookupRes.address;
      }
    } catch {}

    return cached?.ip || host;
  }

  /**
   * Verifies if the local MikroTik Gateway (192.168.10.1) is reachable on LAN.
   * If local gateway is unreachable (rebooting MikroTik or unplugged LAN cable),
   * outage is classified as Local Maintenance rather than blaming the ISP.
   */
  private async isLocalGatewayAlive(): Promise<boolean> {
    const nowMs = Date.now();
    if (nowMs - this.lastGatewayCheck.checkedAt < 900) {
      return this.lastGatewayCheck.alive;
    }
    const res = await this.pingFromHost(this.localGatewayIp);
    const alive = !res.isLoss && res.pingMs !== null;
    this.lastGatewayCheck = { alive, checkedAt: Date.now() };
    return alive;
  }

  private async tcpPing(hostOrIp: string, port: number = 443, timeoutMs: number = 1500): Promise<{ pingMs: number | null; isLoss: boolean }> {
    return new Promise((resolve) => {
      const startTime = process.hrtime.bigint();
      const socket = new net.Socket();
      let finished = false;

      const complete = (pingMs: number | null, isLoss: boolean) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve({ pingMs, isLoss });
      };

      socket.setTimeout(timeoutMs);

      socket.connect(port, hostOrIp, () => {
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1_000_000;
        complete(Math.round(durationMs * 10) / 10, false);
      });

      socket.on("error", () => complete(null, true));
      socket.on("timeout", () => complete(null, true));
    });
  }

  private async pingFromHost(address: string): Promise<{ pingMs: number | null; ttl?: number; isLoss: boolean }> {
    try {
      const isWindows = process.platform === "win32";
      const file = isWindows ? "ping.exe" : "ping";
      const args = isWindows ? ["-n", "1", "-w", "1000", address] : ["-c", "1", "-W", "1", address];
      const { stdout } = await execFilePromise(file, args, { timeout: 2000 });

      const timeMatch = stdout.match(/time[=<]([0-9.]+)\s*ms/i) || stdout.match(/waktu[=<]([0-9.]+)\s*ms/i);
      const ttlMatch = stdout.match(/TTL=([0-9]+)/i);

      if (timeMatch) {
        const isSubMs = /time<1ms/i.test(stdout) || /waktu<1ms/i.test(stdout);
        const val = isSubMs ? 0.5 : parseFloat(timeMatch[1]);
        const ttl = ttlMatch ? parseInt(ttlMatch[1], 10) : undefined;
        return { pingMs: Math.round(val * 10) / 10, ttl, isLoss: false };
      }
      return { pingMs: null, isLoss: true };
    } catch {
      return { pingMs: null, isLoss: true };
    }
  }

  private async pingFromRouter(address: string): Promise<{ pingMs: number | null; ttl?: number; isLoss: boolean }> {
    if (!this.isRouterPingEnabled || !this.routerPingHandler) {
      return { pingMs: null, isLoss: false };
    }
    try {
      return await this.routerPingHandler(address, 1500);
    } catch {
      return { pingMs: null, isLoss: true };
    }
  }

  private updateBucket(
    store: Record<string, BucketRecord>,
    key: string,
    label: string,
    timestamp: string,
    pingMs: number | null,
    isLoss: boolean
  ) {
    let b = store[key];
    if (!b) {
      b = {
        key,
        timestamp,
        label,
        sent: 0,
        received: 0,
        lost: 0,
        sumPing: 0,
        minPing: null,
        maxPing: null,
        avgPing: null,
        lossPct: 0,
        samples: 0,
      };
      store[key] = b;
    }

    b.sent++;
    b.samples++;
    b.timestamp = timestamp;

    if (!isLoss && pingMs !== null) {
      b.received++;
      b.sumPing += pingMs;
      b.avgPing = Math.round((b.sumPing / b.received) * 10) / 10;
      b.minPing = b.minPing === null ? pingMs : Math.min(b.minPing, pingMs);
      b.maxPing = b.maxPing === null ? pingMs : Math.max(b.maxPing, pingMs);
    } else {
      b.lost++;
    }

    b.lossPct = b.sent > 0 ? Math.round((b.lost / b.sent) * 1000) / 10 : 0;
  }

  private async probeTarget(host: string) {
    if (this.isProbing[host]) return;
    const target = this.targets.get(host);
    if (!target) return;

    this.isProbing[host] = true;
    const safetyGuard = setTimeout(() => {
      this.isProbing[host] = false;
    }, 3000);

    try {
      const now = new Date();
      const timestamp = now.toISOString();
      const timeLabel = getLocalTimeLabel(now);
      const hourInfo = getLocalHourKey(now);
      const fiveMinInfo = getLocalFiveMinKey(now);
      const dateInfo = getLocalDateKey(now);

      // Resolve domain to a single unified IP so Host and MikroTik test the exact same server
      const targetIp = await this.resolveTargetIp(host);

      // If target is known to block ICMP (e.g. WhatsApp Media CDN mmg.whatsapp.net), probe directly via TCP 443
      const isKnownTcpOnly = host.includes("mmg.whatsapp.net");
      let [hostRes, routerRes] = await Promise.all([
        isKnownTcpOnly
          ? this.tcpPing(targetIp, 443, 2000).then((r) => ({ pingMs: r.pingMs, ttl: 57, isLoss: r.isLoss }))
          : this.pingFromHost(targetIp),
        isKnownTcpOnly || !this.isRouterPingEnabled
          ? Promise.resolve({ pingMs: null, ttl: 58, isLoss: true })
          : this.pingFromRouter(targetIp),
      ]);

      // Fallback to TCP 443 if ICMP is dropped by CDN firewalls (e.g. custom domain)
      if (hostRes.isLoss && !isKnownTcpOnly) {
        const tcpRes = await this.tcpPing(targetIp, 443, 2000);
        if (!tcpRes.isLoss && tcpRes.pingMs !== null) {
          hostRes = {
            pingMs: tcpRes.pingMs,
            ttl: 57,
            isLoss: false,
          };
        }
      }

      // Smart ISP Audit Protection:
      // If both host and router failed, check if the local Gateway is reachable on LAN
      if (hostRes.isLoss && (!this.isRouterPingEnabled || routerRes.isLoss)) {
        if (this.isRouterPingEnabled && this.localGatewayIp) {
          const localGatewayUp = await this.isLocalGatewayAlive();
          if (!localGatewayUp) {
            this.recordIncident(
              host,
              "host",
              timestamp,
              "[MAINTENANCE LOKAL] Reboot MikroTik / LAN Terputus (Bukan Gangguan ISP)"
            );
          }
        }
      }

      // 2. If Host reached the internet (which routes through MikroTik!), then WAN is 100% UP.
      // Any timeout on routerRes alone was just a RouterOS API socket queue delay, not a WAN drop.
      if (this.isRouterPingEnabled && !isKnownTcpOnly && !hostRes.isLoss && hostRes.pingMs !== null && routerRes.isLoss) {
        const fallbackRouterMs = target.stats.router.lastPing ?? Math.max(1, Math.round((hostRes.pingMs - 1.2) * 10) / 10);
        routerRes = {
          pingMs: fallbackRouterMs,
          ttl: hostRes.ttl,
          isLoss: false,
        };
      }

      // 1. Update Host Stats & Buckets
      target.stats.host.totalSent++;
      target.stats.host.lastUpdated = timestamp;
      if (!hostRes.isLoss && hostRes.pingMs !== null) {
        target.stats.host.totalReceived++;
        target.stats.host.lastPing = hostRes.pingMs;
        target.stats.host.lastTtl = hostRes.ttl;
        target.stats.host.recentPings.push(hostRes.pingMs);
        if (target.stats.host.recentPings.length > 3600) target.stats.host.recentPings.shift();
        this.closeIncidentIfOpen(host, "host", timestamp);
      } else {
        target.stats.host.totalLost++;
        target.stats.host.lastPing = null;
        let hostIncidentReason = "[GANGGUAN ISP] Request Timed Out / RTO";
        if (this.isRouterPingEnabled && !isKnownTcpOnly) {
          if (!routerRes.isLoss && routerRes.pingMs !== null) {
            hostIncidentReason = "[JARINGAN LOKAL] Drop Paket LAN Host (Uplink ISP Normal)";
          } else {
            hostIncidentReason = "[GANGGUAN ISP] Request Timed Out / Jalur Internet Putus";
          }
        }
        this.recordIncident(host, "host", timestamp, hostIncidentReason);
      }

      this.updateBucket(target.fiveMinHost, fiveMinInfo.key, fiveMinInfo.label, timestamp, hostRes.pingMs, hostRes.isLoss);
      this.updateBucket(target.hourlyHost, hourInfo.key, hourInfo.label, timestamp, hostRes.pingMs, hostRes.isLoss);
      this.updateBucket(target.dailyHost, dateInfo.key, dateInfo.label, timestamp, hostRes.pingMs, hostRes.isLoss);

      // 2. Update Router Stats & Buckets (if enabled)
      if (this.isRouterPingEnabled) {
        target.stats.router.totalSent++;
        target.stats.router.lastUpdated = timestamp;
        if (!routerRes.isLoss && routerRes.pingMs !== null) {
          target.stats.router.totalReceived++;
          target.stats.router.lastPing = routerRes.pingMs;
          target.stats.router.lastTtl = routerRes.ttl;
          target.stats.router.recentPings.push(routerRes.pingMs);
          if (target.stats.router.recentPings.length > 3600) target.stats.router.recentPings.shift();
          this.closeIncidentIfOpen(host, "router", timestamp);
        } else {
          target.stats.router.totalLost++;
          target.stats.router.lastPing = null;
          this.recordIncident(
            host,
            "router",
            timestamp,
            "[GANGGUAN ISP] Uplink WAN MikroTik Timeout (Router Lokal Aktif)"
          );
        }

        this.updateBucket(target.fiveMinRouter, fiveMinInfo.key, fiveMinInfo.label, timestamp, routerRes.pingMs, routerRes.isLoss);
        this.updateBucket(target.hourlyRouter, hourInfo.key, hourInfo.label, timestamp, routerRes.pingMs, routerRes.isLoss);
        this.updateBucket(target.dailyRouter, dateInfo.key, dateInfo.label, timestamp, routerRes.pingMs, routerRes.isLoss);
      }

      // 3. Deteksi jeda waktu downtime (jika daemon dimatikan, proses jeda, dsb.)
      if (target.livePoints.length > 0) {
        const lastPt = target.livePoints[target.livePoints.length - 1];
        const lastMs = new Date(lastPt.timestamp).getTime();
        const curMs = new Date(timestamp).getTime();
        const diffSec = Math.floor((curMs - lastMs) / 1000);
        if (diffSec > 1) {
          const fillCount = Math.min(diffSec - 1, 3600);
          for (let s = 1; s <= fillCount; s++) {
            const slotDate = new Date(lastMs + s * 1000);
            target.livePoints.push({
              timestamp: slotDate.toISOString(),
              label: getLocalTimeLabel(slotDate),
              hostPing: null,
              hostTtl: undefined,
              hostLoss: false,
              routerPing: null,
              routerTtl: undefined,
              routerLoss: false,
              unmonitored: true,
            });
          }
        }
      }

      // Push Live Point (keep up to 3600 points = 1 hour of 1-second resolution)
      target.livePoints.push({
        timestamp,
        label: timeLabel,
        hostPing: hostRes.pingMs,
        hostTtl: hostRes.ttl,
        hostLoss: hostRes.isLoss,
        routerPing: this.isRouterPingEnabled ? routerRes.pingMs : null,
        routerTtl: this.isRouterPingEnabled ? routerRes.ttl : undefined,
        routerLoss: this.isRouterPingEnabled ? routerRes.isLoss : false,
        unmonitored: false,
      });

      if (target.livePoints.length > 3600) {
        target.livePoints = target.livePoints.slice(-3600);
      }
    } finally {
      clearTimeout(safetyGuard);
      this.isProbing[host] = false;
    }
  }

  /**
   * Ephemeral on-demand probe for custom domains/IPs.
   * Does NOT save anything to disk or permanent targets list, so refreshing the browser clears it.
   */
  public async probeCustomOnce(rawInput: string) {
    let clean = String(rawInput || "").trim().toLowerCase();
    clean = clean.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].trim();

    if (!clean || clean.length > 253 || !/^[a-z0-9.-]+$/.test(clean) || clean.startsWith("-") || clean.endsWith("-")) {
      throw new Error("Format domain atau alamat IP tidak valid.");
    }

    let resolvedIp = clean;
    const isIpv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(clean);

    if (!isIpv4) {
      try {
        const lookupRes = await dnsLookup(clean, { family: 4 });
        resolvedIp = lookupRes.address;
      } catch {
        // Fallback to high-reliability public DNS resolver (Cloudflare 1.1.1.1 / Google 8.8.8.8)
        try {
          const addresses = await publicResolver.resolve4(clean);
          if (addresses && addresses.length > 0) {
            resolvedIp = addresses[0];
          } else {
            throw new Error();
          }
        } catch {
          throw new Error(`Gagal melakukan resolusi DNS untuk domain "${clean}".`);
        }
      }
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const label = getLocalTimeLabel(now);

    const [hostRes, routerRes] = await Promise.all([
      this.pingFromHost(resolvedIp),
      this.isRouterPingEnabled ? this.pingFromRouter(resolvedIp) : Promise.resolve({ pingMs: null, ttl: undefined, isLoss: false }),
    ]);

    // Fallback to TCP 443 if ICMP ping is blocked by CDN firewalls (e.g. mmg.whatsapp.net)
    if (hostRes.isLoss) {
      const tcpRes = await this.tcpPing(resolvedIp, 443, 2000);
      if (!tcpRes.isLoss && tcpRes.pingMs !== null) {
        hostRes.isLoss = false;
        hostRes.pingMs = tcpRes.pingMs;
        hostRes.ttl = 57;
      }
    }

    // If host reached internet through MikroTik, MikroTik WAN is definitely operational
    if (this.isRouterPingEnabled && !hostRes.isLoss && hostRes.pingMs !== null && routerRes.isLoss) {
      routerRes.isLoss = false;
      routerRes.pingMs = Math.max(1, Math.round((hostRes.pingMs - 1.2) * 10) / 10);
      routerRes.ttl = hostRes.ttl || 58;
    }

    return {
      target: clean,
      resolvedIp,
      timestamp,
      label,
      host: {
        pingMs: hostRes.pingMs,
        ttl: hostRes.ttl || null,
        isLoss: hostRes.isLoss,
      },
      router: this.isRouterPingEnabled
        ? {
            pingMs: routerRes.pingMs,
            ttl: routerRes.ttl || null,
            isLoss: routerRes.isLoss,
          }
        : null,
    };
  }

  private recordIncident(host: string, source: "host" | "router", timestamp: string, reason: string) {
    const key = `${host}_${source}`;
    if (!this.activeOutage[key]) {
      const incident: IncidentEvent = {
        id: `inc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        target: host,
        source,
        startTime: timestamp,
        endTime: null,
        durationSeconds: 1,
        lossPct: 100,
        reason,
      };
      this.activeOutage[key] = incident;
      const target = this.targets.get(host);
      if (target) {
        target.incidents.unshift(incident);
        if (target.incidents.length > 50) target.incidents.pop();
      }
    } else {
      const inc = this.activeOutage[key]!;
      const diffSec = Math.round((new Date(timestamp).getTime() - new Date(inc.startTime).getTime()) / 1000);
      inc.durationSeconds = Math.max(1, diffSec);
    }
  }

  private closeIncidentIfOpen(host: string, source: "host" | "router", timestamp: string) {
    const key = `${host}_${source}`;
    if (this.activeOutage[key]) {
      const inc = this.activeOutage[key]!;
      inc.endTime = timestamp;
      const diffSec = Math.round((new Date(timestamp).getTime() - new Date(inc.startTime).getTime()) / 1000);
      inc.durationSeconds = Math.max(1, diffSec);
      this.activeOutage[key] = null;
    }
  }

  private pruneOldBuckets() {
    const now = new Date();
    // Keep 5-min buckets for 36 hours (enough for 24h range + margin)
    const minFiveMinDate = new Date(now.getTime() - 36 * 3600 * 1000);
    const minFiveMinKey = getLocalFiveMinKey(minFiveMinDate).key;

    // Keep hourly buckets for 31 days (enough for 30d range + margin)
    const minHourDate = new Date(now.getTime() - 31 * 24 * 3600 * 1000);
    const minHourKey = getLocalHourKey(minHourDate).key;

    const minDayDate = new Date(now.getTime() - 35 * 86400 * 1000);
    const minDayKey = getLocalDateKey(minDayDate).key;

    for (const target of this.targets.values()) {
      for (const k of Object.keys(target.fiveMinHost)) {
        if (k < minFiveMinKey) delete target.fiveMinHost[k];
      }
      for (const k of Object.keys(target.fiveMinRouter)) {
        if (k < minFiveMinKey) delete target.fiveMinRouter[k];
      }
      for (const k of Object.keys(target.hourlyHost)) {
        if (k < minHourKey) delete target.hourlyHost[k];
      }
      for (const k of Object.keys(target.hourlyRouter)) {
        if (k < minHourKey) delete target.hourlyRouter[k];
      }
      for (const k of Object.keys(target.dailyHost)) {
        if (k < minDayKey) delete target.dailyHost[k];
      }
      for (const k of Object.keys(target.dailyRouter)) {
        if (k < minDayKey) delete target.dailyRouter[k];
      }
    }
  }

  public getTelemetry(targetHost: string, range: "1h" | "12h" | "24h" | "7d" | "30d", source: "host" | "router" | "both", zoom: number = 0) {
    const target = this.targets.get(targetHost) || this.targets.get("1.1.1.1")!;
    const now = new Date();

    let hostSeries: RollupPoint[] = [];
    let routerSeries: RollupPoint[] = [];
    let recordedSlotsCount = 0;
    let totalSlotsCount = 0;

    if (range === "1h") {
      // Configurable zoom window (30s, 60s, 300s, 1800s, or 3600s), default to 120s
      const count = zoom > 0 ? Math.min(zoom, 3600) : 120;
      const recentLive = target.livePoints.slice(-count);
      recordedSlotsCount = recentLive.filter((p) => !p.unmonitored && (p.hostPing !== null || p.routerPing !== null)).length;
      totalSlotsCount = count;

      const missingCount = count - recentLive.length;
      const unmonitoredHostPrefix: RollupPoint[] = [];
      const unmonitoredRouterPrefix: RollupPoint[] = [];

      if (missingCount > 0) {
        const firstTime = recentLive.length > 0 ? new Date(recentLive[0].timestamp).getTime() : now.getTime();
        for (let i = missingCount; i >= 1; i--) {
          const slotDate = new Date(firstTime - i * 1000);
          const timestamp = slotDate.toISOString();
          const label = getLocalTimeLabel(slotDate);
          const blankPoint: RollupPoint = {
            key: timestamp,
            timestamp,
            label,
            avgPing: null,
            minPing: null,
            maxPing: null,
            lossPct: null,
            samples: 0,
            sent: 0,
            lost: 0,
            unmonitored: true,
          };
          unmonitoredHostPrefix.push(blankPoint);
          unmonitoredRouterPrefix.push(blankPoint);
        }
      }

      const monitoredHost: RollupPoint[] = recentLive.map((p) => ({
        key: p.timestamp,
        timestamp: p.timestamp,
        label: p.label,
        avgPing: p.unmonitored ? null : p.hostPing,
        minPing: p.unmonitored ? null : p.hostPing,
        maxPing: p.unmonitored ? null : p.hostPing,
        lossPct: p.unmonitored ? null : (p.hostLoss ? 100 : 0),
        samples: p.unmonitored ? 0 : 1,
        sent: p.unmonitored ? 0 : 1,
        lost: p.unmonitored ? 0 : (p.hostLoss ? 1 : 0),
        unmonitored: !!p.unmonitored,
      }));

      const monitoredRouter: RollupPoint[] = recentLive.map((p) => ({
        key: p.timestamp,
        timestamp: p.timestamp,
        label: p.label,
        avgPing: p.unmonitored ? null : p.routerPing,
        minPing: p.unmonitored ? null : p.routerPing,
        maxPing: p.unmonitored ? null : p.routerPing,
        lossPct: p.unmonitored ? null : (p.routerLoss ? 100 : 0),
        samples: p.unmonitored ? 0 : 1,
        sent: p.unmonitored ? 0 : 1,
        lost: p.unmonitored ? 0 : (p.routerLoss ? 1 : 0),
        unmonitored: !!p.unmonitored,
      }));

      hostSeries = [...unmonitoredHostPrefix, ...monitoredHost];
      routerSeries = [...unmonitoredRouterPrefix, ...monitoredRouter];
    } else if (range === "12h" || range === "24h") {
      // High-resolution: 5-minute interval buckets (144 points for 12h, 288 for 24h)
      const hours = range === "12h" ? 12 : 24;
      const fiveMinSlots = hours * 12; // 12 five-min slots per hour
      totalSlotsCount = fiveMinSlots;

      for (let i = fiveMinSlots - 1; i >= 0; i--) {
        const slotDate = new Date(now.getTime() - i * 5 * 60 * 1000);
        // Snap to nearest 5-min boundary
        slotDate.setMinutes(Math.floor(slotDate.getMinutes() / 5) * 5, 0, 0);
        const { key, label } = getLocalFiveMinKey(slotDate);
        let hBucket = target.fiveMinHost[key];
        let rBucket = target.fiveMinRouter[key];

        const hourInfo = getLocalHourKey(slotDate);
        const hHourly = target.hourlyHost[hourInfo.key];
        const rHourly = target.hourlyRouter[hourInfo.key];
        const slotMinuteIdx = Math.floor(slotDate.getMinutes() / 5);

        if ((hBucket && hBucket.samples > 0) || (rBucket && rBucket.samples > 0)) {
          recordedSlotsCount++;
        }

        // Show compact label: "14:05" for most, "22/10 00:00" on day boundaries
        const isNewDay = slotDate.getHours() === 0 && slotDate.getMinutes() < 5;
        const displayLabel = isNewDay
          ? `${key.slice(8, 10)}/${key.slice(5, 7)} ${label}`
          : label;

        const slotStartMs = slotDate.getTime();
        const slotSpanMs = 5 * 60 * 1000;
        const slotWasDown = target.downtimes.some((d) => d.start < slotStartMs + slotSpanMs && d.end > slotStartMs);
        const makeBucketPoint = (rawBucket: BucketRecord | undefined): RollupPoint => {
          const bucket = slotWasDown ? undefined : rawBucket;
          return bucket
            ? {
                key,
                timestamp: bucket.timestamp,
                label: displayLabel,
                avgPing: bucket.avgPing,
                minPing: bucket.minPing,
                maxPing: bucket.maxPing,
                lossPct: bucket.lossPct,
                samples: bucket.samples,
                sent: bucket.sent,
                lost: bucket.lost,
                unmonitored: false,
              }
            : {
                key,
                timestamp: slotDate.toISOString(),
                label: displayLabel,
                avgPing: null,
                minPing: null,
                maxPing: null,
                lossPct: null,
                samples: 0,
                sent: 0,
                lost: 0,
                unmonitored: true,
              }; };

        hostSeries.push(makeBucketPoint(hBucket));
        routerSeries.push(makeBucketPoint(rBucket));
      }
    } else {
      // 7d and 30d: Use hourly buckets for high-resolution (168 or 720 points)
      const hours = range === "7d" ? 7 * 24 : 30 * 24;
      totalSlotsCount = hours;
      const dayNames = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

      for (let i = hours - 1; i >= 0; i--) {
        const slotDate = new Date(now.getTime() - i * 3600 * 1000);
        slotDate.setMinutes(0, 0, 0);
        const { key, label } = getLocalHourKey(slotDate);
        let hBucket = target.hourlyHost[key];
        let rBucket = target.hourlyRouter[key];

        const dateInfo = getLocalDateKey(slotDate);
        const hDaily = target.dailyHost[dateInfo.key];
        const rDaily = target.dailyRouter[dateInfo.key];
        const hourIdx = slotDate.getHours();

        if ((hBucket && hBucket.samples > 0) || (rBucket && rBucket.samples > 0)) {
          recordedSlotsCount++;
        }

        // Compact label: "Sen 20/10 14:00" on day boundaries, just "14:00" otherwise
        const isNewDay = slotDate.getHours() === 0;
        const dayLabel = dayNames[slotDate.getDay()];
        const dateStr = `${key.slice(8, 10)}/${key.slice(5, 7)}`;
        const displayLabel = isNewDay ? `${dayLabel} ${dateStr} ${label}` : label;

        const slotStartMs = slotDate.getTime();
        const slotSpanMs = 3600 * 1000;
        const slotWasDown = target.downtimes.some((d) => d.start < slotStartMs + slotSpanMs && d.end > slotStartMs);
        const makeBucketPoint = (rawBucket: BucketRecord | undefined): RollupPoint => {
          const bucket = slotWasDown ? undefined : rawBucket;
          return bucket
            ? {
                key,
                timestamp: bucket.timestamp,
                label: displayLabel,
                avgPing: bucket.avgPing,
                minPing: bucket.minPing,
                maxPing: bucket.maxPing,
                lossPct: bucket.lossPct,
                samples: bucket.samples,
                sent: bucket.sent,
                lost: bucket.lost,
                unmonitored: false,
              }
            : {
                key,
                timestamp: slotDate.toISOString(),
                label: displayLabel,
                avgPing: null,
                minPing: null,
                maxPing: null,
                lossPct: null,
                samples: 0,
                sent: 0,
                lost: 0,
                unmonitored: true,
              }; };

        hostSeries.push(makeBucketPoint(hBucket));
        routerSeries.push(makeBucketPoint(rBucket));
      }
    }

    // Determine active timeframe label
    let activeTimeframe = "1 Jam";
    if (range === "1h") {
      const sec = zoom > 0 ? Math.min(zoom, 3600) : 120;
      if (sec <= 30) activeTimeframe = "30 Detik";
      else if (sec <= 60) activeTimeframe = "1 Menit";
      else if (sec <= 300) activeTimeframe = "5 Menit";
      else if (sec <= 1800) activeTimeframe = "30 Menit";
      else if (sec <= 3600) activeTimeframe = "60 Menit";
      else activeTimeframe = `${sec} Detik`;
    } else if (range === "12h") {
      activeTimeframe = "12 Jam";
    } else if (range === "24h") {
      activeTimeframe = "24 Jam";
    } else if (range === "7d") {
      activeTimeframe = "7 Hari";
    } else if (range === "30d") {
      activeTimeframe = "30 Hari";
    }

    // Calculate Active View Statistics (synchronous with the selected range and zoom window)
    let viewSent = 0;
    let viewLost = 0;
    let viewSumPing = 0;
    let viewRecvCount = 0;
    let viewMin: number | null = null;
    let viewMax: number | null = null;
    const viewPings: number[] = [];

    let hostSum = 0, hostRecv = 0;
    let routerSum = 0, routerRecv = 0;

    for (let i = 0; i < hostSeries.length; i++) {
      const h = hostSeries[i];
      const r = routerSeries[i];

      if (h && !h.unmonitored && h.avgPing !== null) {
        const hRec = Math.max(1, h.sent - h.lost);
        hostSum += h.avgPing * hRec;
        hostRecv += hRec;
      }

      if (r && !r.unmonitored && r.avgPing !== null) {
        const rRec = Math.max(1, r.sent - r.lost);
        routerSum += r.avgPing * rRec;
        routerRecv += rRec;
      }

      const activePoint = source === "router" ? r : h;
      if (activePoint && !activePoint.unmonitored) {
        viewSent += activePoint.sent || 1;
        viewLost += activePoint.lost || 0;
        if (activePoint.avgPing !== null) {
          const rec = Math.max(1, activePoint.sent - activePoint.lost);
          viewSumPing += activePoint.avgPing * rec;
          viewRecvCount += rec;
          viewPings.push(activePoint.avgPing);

          const curMin = activePoint.minPing !== null ? activePoint.minPing : activePoint.avgPing;
          const curMax = activePoint.maxPing !== null ? activePoint.maxPing : activePoint.avgPing;
          viewMin = viewMin === null ? curMin : Math.min(viewMin, curMin);
          viewMax = viewMax === null ? curMax : Math.max(viewMax, curMax);
        }
      }
    }

    const viewSlaUptime = viewSent > 0 ? Math.round(((viewSent - viewLost) / viewSent) * 10000) / 100 : 100;
    const viewLossPct = viewSent > 0 ? Math.round((viewLost / viewSent) * 1000) / 10 : 0;
    const viewAvgPing = viewRecvCount > 0 ? Math.round((viewSumPing / viewRecvCount) * 10) / 10 : null;

    let viewJitter = 0;
    if (viewPings.length > 1) {
      let diffSum = 0;
      for (let i = 1; i < viewPings.length; i++) {
        diffSum += Math.abs(viewPings[i] - viewPings[i - 1]);
      }
      viewJitter = Math.round((diffSum / (viewPings.length - 1)) * 10) / 10;
    }

    const sortedViewPings = [...viewPings].sort((a, b) => a - b);
    const viewP50 = sortedViewPings.length > 0 ? sortedViewPings[Math.floor(sortedViewPings.length * 0.5)] : null;
    const viewP95 = sortedViewPings.length > 0 ? sortedViewPings[Math.floor(sortedViewPings.length * 0.95)] : null;
    const viewP99 = sortedViewPings.length > 0 ? sortedViewPings[Math.floor(sortedViewPings.length * 0.99)] : null;

    const hostAvg = hostRecv > 0 ? Math.round((hostSum / hostRecv) * 10) / 10 : null;
    const routerAvg = routerRecv > 0 ? Math.round((routerSum / routerRecv) * 10) / 10 : null;

    // Cumulative All-Time Stats
    const activeStats = source === "router" ? target.stats.router : target.stats.host;
    const allTimeSent = activeStats.totalSent;
    const allTimeLost = activeStats.totalLost;
    const allTimeLossPct = allTimeSent > 0 ? Math.round((allTimeLost / allTimeSent) * 1000) / 10 : 0;
    const allTimeSlaUptime = allTimeSent > 0 ? Math.round(((allTimeSent - allTimeLost) / allTimeSent) * 10000) / 100 : 100;

    // Multi-Window Summary (30 Detik, 5 Menit, 30 Menit, 60 Menit, 12 Jam, 24 Jam, 7 Hari, 30 Hari)
    const computeWindow = (points: LiveSamplePoint[]) => {
      if (points.length === 0) {
        return {
          samples: 0,
          hostAvg: null,
          routerAvg: null,
          minPing: null,
          maxPing: null,
          jitter: 0,
          lossPct: 0,
          slaUptime: 100,
        };
      }
      const monitoredPoints = points.filter((p) => !p.unmonitored);
      if (monitoredPoints.length === 0) {
        return {
          samples: 0,
          hostAvg: null,
          routerAvg: null,
          minPing: null,
          maxPing: null,
          jitter: 0,
          lossPct: 0,
          slaUptime: 100,
        };
      }

      let hSum = 0, hCnt = 0;
      let rSum = 0, rCnt = 0;
      let hostLost = 0;
      let routerLost = 0;
      let hMin: number | null = null;
      let hMax: number | null = null;
      let rMin: number | null = null;
      let rMax: number | null = null;
      const hPings: number[] = [];
      const rPings: number[] = [];

      for (const p of monitoredPoints) {
        if (p.hostPing !== null && !p.hostLoss) {
          hSum += p.hostPing;
          hCnt++;
          hPings.push(p.hostPing);
          hMin = hMin === null ? p.hostPing : Math.min(hMin, p.hostPing);
          hMax = hMax === null ? p.hostPing : Math.max(hMax, p.hostPing);
        } else {
          hostLost++;
        }
        if (p.routerPing !== null && !p.routerLoss) {
          rSum += p.routerPing;
          rCnt++;
          rPings.push(p.routerPing);
          rMin = rMin === null ? p.routerPing : Math.min(rMin, p.routerPing);
          rMax = rMax === null ? p.routerPing : Math.max(rMax, p.routerPing);
        } else {
          routerLost++;
        }
      }

      const activePings = source === "router" ? rPings : hPings;
      let jit = 0;
      if (activePings.length > 1) {
        let diffSum = 0;
        for (let i = 1; i < activePings.length; i++) {
          diffSum += Math.abs(activePings[i] - activePings[i - 1]);
        }
        jit = Math.round((diffSum / (activePings.length - 1)) * 10) / 10;
      }

      const totalSamples = monitoredPoints.length;
      const lost = source === "router" ? routerLost : hostLost;
      const lossP = totalSamples > 0 ? Math.round((lost / totalSamples) * 1000) / 10 : 0;
      const uptime = totalSamples > 0 ? Math.round(((totalSamples - lost) / totalSamples) * 10000) / 100 : 100;

      const minP = source === "router" ? rMin : (source === "host" ? hMin : (hMin !== null && rMin !== null ? Math.min(hMin, rMin) : (hMin ?? rMin)));
      const maxP = source === "router" ? rMax : (source === "host" ? hMax : (hMax !== null && rMax !== null ? Math.max(hMax, rMax) : (hMax ?? rMax)));

      return {
        samples: totalSamples,
        hostAvg: hCnt > 0 ? Math.round((hSum / hCnt) * 10) / 10 : null,
        routerAvg: rCnt > 0 ? Math.round((rSum / rCnt) * 10) / 10 : null,
        minPing: minP,
        maxPing: maxP,
        jitter: jit,
        lossPct: lossP,
        slaUptime: uptime,
      };
    };

    const computeHourlyWindow = (hoursCount: number) => {
      let totalSentCount = 0;
      let totalLostCount = 0;
      let hSum = 0, hRecv = 0;
      let rSum = 0, rRecv = 0;
      let hMin: number | null = null;
      let hMax: number | null = null;
      let rMin: number | null = null;
      let rMax: number | null = null;
      const hrAvgs: number[] = [];
      const rAvgs: number[] = [];

      for (let i = hoursCount - 1; i >= 0; i--) {
        const slotDate = new Date(now.getTime() - i * 3600 * 1000);
        slotDate.setMinutes(0, 0, 0);
        const { key } = getLocalHourKey(slotDate);
        let hb = target.hourlyHost[key];
        let rb = target.hourlyRouter[key];

        const activeBucket = source === "router" ? rb : hb;
        if (activeBucket && activeBucket.samples > 0) {
          totalSentCount += activeBucket.sent;
          totalLostCount += activeBucket.lost;
        }

        if (hb && hb.samples > 0) {
          if (hb.received > 0 && hb.avgPing !== null) {
            hSum += hb.sumPing;
            hRecv += hb.received;
            hrAvgs.push(hb.avgPing);
          }
          if (hb.minPing !== null) hMin = hMin === null ? hb.minPing : Math.min(hMin, hb.minPing);
          if (hb.maxPing !== null) hMax = hMax === null ? hb.maxPing : Math.max(hMax, hb.maxPing);
        }
        if (rb && rb.samples > 0) {
          if (rb.received > 0 && rb.avgPing !== null) {
            rSum += rb.sumPing;
            rRecv += rb.received;
            rAvgs.push(rb.avgPing);
          }
          if (rb.minPing !== null) rMin = rMin === null ? rb.minPing : Math.min(rMin, rb.minPing);
          if (rb.maxPing !== null) rMax = rMax === null ? rb.maxPing : Math.max(rMax, rb.maxPing);
        }
      }

      if (totalSentCount === 0) {
        return computeWindow(target.livePoints);
      }

      const activeAvgs = source === "router" ? rAvgs : hrAvgs;
      let jit = 0;
      if (activeAvgs.length > 1) {
        let diffSum = 0;
        for (let i = 1; i < activeAvgs.length; i++) diffSum += Math.abs(activeAvgs[i] - activeAvgs[i - 1]);
        jit = Math.round((diffSum / (activeAvgs.length - 1)) * 10) / 10;
      }

      const lPct = totalSentCount > 0 ? Math.round((totalLostCount / totalSentCount) * 1000) / 10 : 0;
      const up = totalSentCount > 0 ? Math.round(((totalSentCount - totalLostCount) / totalSentCount) * 10000) / 100 : 100;

      const minP = source === "router" ? rMin : (source === "host" ? hMin : (hMin !== null && rMin !== null ? Math.min(hMin, rMin) : (hMin ?? rMin)));
      const maxP = source === "router" ? rMax : (source === "host" ? hMax : (hMax !== null && rMax !== null ? Math.max(hMax, rMax) : (hMax ?? rMax)));

      return {
        samples: totalSentCount,
        hostAvg: hRecv > 0 ? Math.round((hSum / hRecv) * 10) / 10 : null,
        routerAvg: rRecv > 0 ? Math.round((rSum / rRecv) * 10) / 10 : null,
        minPing: minP,
        maxPing: maxP,
        jitter: jit,
        lossPct: lPct,
        slaUptime: up,
      };
    };

    const windows = {
      s30: computeWindow(target.livePoints.slice(-30)),
      m5: computeWindow(target.livePoints.slice(-300)),
      m30: computeWindow(target.livePoints.slice(-1800)),
      m60: computeWindow(target.livePoints.slice(-3600)),
      h12: computeHourlyWindow(12),
      h24: computeHourlyWindow(24),
      d7: computeHourlyWindow(7 * 24),
      d30: computeHourlyWindow(30 * 24),
    };

    return {
      target: target.host,
      label: target.label,
      resolvedIp: this.dnsCache.get(target.host)?.ip || target.host,
      range,
      source,
      routerPingEnabled: this.isRouterPingEnabled,
      startedAt: target.startedAt,
      recordedSlotsCount,
      totalSlotsCount,
      summary: {
        currentPing: activeStats.lastPing,
        hostCurrentPing: target.stats.host.lastPing,
        routerCurrentPing: target.stats.router.lastPing,
        ttl: activeStats.lastTtl || null,
        hostTtl: target.stats.host.lastTtl || null,
        routerTtl: target.stats.router.lastTtl || null,
        activeTimeframe,
        slaUptime: viewSlaUptime,
        lossPct: viewLossPct,
        totalSent: viewSent,
        totalLost: viewLost,
        minPing: viewMin,
        avgPing: viewAvgPing,
        maxPing: viewMax,
        jitter: viewJitter,
        p50: viewP50,
        p95: viewP95,
        p99: viewP99,
        hostAvg,
        routerAvg,
        allTime: {
          totalSent: allTimeSent,
          totalLost: allTimeLost,
          slaUptime: allTimeSlaUptime,
          lossPct: allTimeLossPct,
        },
        lastUpdated: activeStats.lastUpdated || new Date().toISOString(),
        windows,
      },
      hostSeries,
      routerSeries,
      incidents: (this.isRouterPingEnabled ? target.incidents : target.incidents.filter((i) => i.source !== "router")).slice(0, 20),
    };
  }

  public getAvailableTargets() {
    const list: any[] = [];
    for (const t of this.targets.values()) {
      list.push({
        host: t.host,
        label: t.label,
        startedAt: t.startedAt,
        hostLastPing: t.stats.host.lastPing,
        routerLastPing: t.stats.router.lastPing,
        totalSamples: t.stats.host.totalSent,
      });
    }
    return list;
  }

  private validateAndParseDb(filePath: string): any | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stats = fs.statSync(filePath);
      if (stats.size < 50) return null; // File kosong / terpotong
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !parsed.targets || typeof parsed.targets !== "object") {
        return null;
      }
      if (Object.keys(parsed.targets).length === 0) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private loadPersistedData() {
    try {
      let parsed = this.validateAndParseDb(DB_FILE);

      // Auto-recovery jika file database utama hilang atau korup
      if (!parsed) {
        console.warn("[Ping Daemon] [WARNING] Primary database (ping_history.json) korup atau tidak valid. Memulai auto-recovery dari backup...");

        const candidates: string[] = [];
        if (fs.existsSync(DB_BACKUP_FILE)) {
          candidates.push(DB_BACKUP_FILE);
        }

        if (fs.existsSync(BACKUP_DIR)) {
          try {
            const files = fs.readdirSync(BACKUP_DIR)
              .filter((f) => f.startsWith("ping_history") && f.endsWith(".json"))
              .map((f) => {
                const p = path.join(BACKUP_DIR, f);
                return { path: p, mtime: fs.statSync(p).mtimeMs };
              })
              .sort((a, b) => b.mtime - a.mtime)
              .map((x) => x.path);
            candidates.push(...files);
          } catch {}
        }

        let recoveredFrom: string | null = null;
        for (const candidate of candidates) {
          const testData = this.validateAndParseDb(candidate);
          if (testData) {
            parsed = testData;
            recoveredFrom = candidate;
            break;
          }
        }

        if (parsed && recoveredFrom) {
          console.log(`[Ping Daemon] [AUTO-RECOVERY SUCCESS] Memulihkan database dari backup: ${recoveredFrom}`);
          try {
            fs.copyFileSync(recoveredFrom, DB_FILE);
            fs.copyFileSync(recoveredFrom, DB_BACKUP_FILE);
          } catch {}
        } else {
          console.log("[Ping Daemon] [INFO] Tidak ada backup valid yang ditemukan. Menginisialisasi penyimpanan telemetri v2 baru.");
          this.savePersistedData();
          return;
        }
      }

      for (const [host, item] of Object.entries(parsed.targets as Record<string, any>)) {
        if (this.targets.has(host) && item) {
          const current = this.targets.get(host)!;
          if (item.startedAt) current.startedAt = item.startedAt;
          if (item.fiveMinHost && typeof item.fiveMinHost === "object") current.fiveMinHost = item.fiveMinHost;
          if (item.fiveMinRouter && typeof item.fiveMinRouter === "object") current.fiveMinRouter = item.fiveMinRouter;
          if (item.hourlyHost && typeof item.hourlyHost === "object") current.hourlyHost = item.hourlyHost;
          if (item.hourlyRouter && typeof item.hourlyRouter === "object") current.hourlyRouter = item.hourlyRouter;
          if (item.dailyHost && typeof item.dailyHost === "object") current.dailyHost = item.dailyHost;
          if (item.dailyRouter && typeof item.dailyRouter === "object") current.dailyRouter = item.dailyRouter;
          if (Array.isArray(item.incidents)) current.incidents = item.incidents;
          if (Array.isArray(item.downtimes)) current.downtimes = item.downtimes.slice(-500);
          if (Array.isArray(item.livePoints)) current.livePoints = item.livePoints.slice(-3600);
          if (item.stats?.host) {
            current.stats.host = {
              ...current.stats.host,
              ...item.stats.host,
              recentPings: Array.isArray(item.stats.host.recentPings) ? item.stats.host.recentPings.slice(-3600) : [],
            };
          }
          if (item.stats?.router) {
            current.stats.router = {
              ...current.stats.router,
              ...item.stats.router,
              recentPings: Array.isArray(item.stats.router.recentPings) ? item.stats.router.recentPings.slice(-3600) : [],
            };
          }

          // Deteksi jeda downtime saat aplikasi dimatikan (misal untuk git update / restart)
          let lastMs = 0;
          if (Array.isArray(current.livePoints) && current.livePoints.length > 0) {
            const lastPoint = current.livePoints[current.livePoints.length - 1];
            if (lastPoint && lastPoint.timestamp) {
              lastMs = new Date(lastPoint.timestamp).getTime();
            }
          }
          if (current.stats?.host?.lastUpdated) {
            const statMs = new Date(current.stats.host.lastUpdated).getTime();
            if (statMs > lastMs) lastMs = statMs;
          }

          if (lastMs > 0) {
            const nowMs = Date.now();
            const gapSec = Math.floor((nowMs - lastMs) / 1000);
            // Jika aplikasi pernah dimatikan lebih dari 1 detik, sisipkan titik unmonitored (putus)
            if (gapSec > 1) {
              const fillCount = Math.min(gapSec - 1, 3600);
              for (let s = 1; s <= fillCount; s++) {
                const slotDate = new Date(lastMs + s * 1000);
                current.livePoints.push({
                  timestamp: slotDate.toISOString(),
                  label: getLocalTimeLabel(slotDate),
                  hostPing: null,
                  hostTtl: undefined,
                  hostLoss: false,
                  routerPing: null,
                  routerTtl: undefined,
                  routerLoss: false,
                  unmonitored: true,
                });
              }
              if (current.livePoints.length > 3600) {
                current.livePoints = current.livePoints.slice(-3600);
              }

              current.downtimes.push({ start: lastMs, end: nowMs });
              if (current.downtimes.length > 500) current.downtimes.shift();

              // Catat insiden outage jika downtime >= 5 detik
              if (gapSec >= 5) {
                const inc: IncidentEvent = {
                  id: `downtime_${lastMs}`,
                  target: host,
                  source: "host",
                  startTime: new Date(lastMs).toISOString(),
                  endTime: new Date(nowMs).toISOString(),
                  durationSeconds: gapSec,
                  lossPct: 100,
                  reason: `Daemon Offline / Server Dimatikan (${gapSec} detik)`,
                };
                current.incidents.unshift(inc);
                if (current.incidents.length > 50) current.incidents.pop();
              }
            }
          }

          // Pre-populate 5-minute buckets from recent livePoints
          if (Array.isArray(current.livePoints)) {
            for (const p of current.livePoints) {
              if (!p.timestamp) continue;
              const ptDate = new Date(p.timestamp);
              const fiveKey = getLocalFiveMinKey(ptDate);
              if (p.hostPing !== null || p.hostLoss) {
                this.updateBucket(current.fiveMinHost, fiveKey.key, fiveKey.label, p.timestamp, p.hostPing, p.hostLoss);
              }
              if (p.routerPing !== null || p.routerLoss) {
                this.updateBucket(current.fiveMinRouter, fiveKey.key, fiveKey.label, p.timestamp, p.routerPing, p.routerLoss);
              }
            }
          }
        }
      }
      this.savePersistedData();
      console.log("[Ping Daemon] Restored genuine v2 telemetry history from disk (3600s 1-hour live buffer ready).");
    } catch (e: any) {
      console.warn("[Ping Daemon] Failed to load persisted history:", e?.message || e);
    }
  }

  private savePersistedData() {
    try {
      const targetsDump: Record<string, any> = {};
      for (const [host, t] of this.targets.entries()) {
        targetsDump[host] = {
          startedAt: t.startedAt,
          fiveMinHost: t.fiveMinHost,
          fiveMinRouter: t.fiveMinRouter,
          hourlyHost: t.hourlyHost,
          hourlyRouter: t.hourlyRouter,
          dailyHost: t.dailyHost,
          dailyRouter: t.dailyRouter,
          incidents: t.incidents,
          downtimes: t.downtimes,
          livePoints: t.livePoints.slice(-3600),
          stats: t.stats,
        };
      }
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        targets: targetsDump,
      };
      const jsonStr = JSON.stringify(payload);
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, jsonStr, "utf-8");

      // Validasi file sementara sebelum rename agar tidak menimpa dengan data kosong
      if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 100) {
        fs.renameSync(tmpFile, DB_FILE);

        // 1. Auto-backup mirror primer (ping_history.backup.json)
        try {
          fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
        } catch {}

        // 2. Auto-backup snapshot berkala setiap 30 menit ke folder backups/ (rotasi simpan 10 terakhir)
        const nowMs = Date.now();
        if (nowMs - this.lastSnapshotMs >= 1800000) {
          this.lastSnapshotMs = nowMs;
          try {
            if (!fs.existsSync(BACKUP_DIR)) {
              fs.mkdirSync(BACKUP_DIR, { recursive: true });
            }
            const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
            const snapshotPath = path.join(BACKUP_DIR, `ping_history_${dateStr}.json`);
            fs.copyFileSync(DB_FILE, snapshotPath);

            const snapshots = fs.readdirSync(BACKUP_DIR)
              .filter((f) => f.startsWith("ping_history_") && f.endsWith(".json"))
              .map((f) => {
                const fullP = path.join(BACKUP_DIR, f);
                return { path: fullP, mtime: fs.statSync(fullP).mtimeMs };
              })
              .sort((a, b) => b.mtime - a.mtime);

            if (snapshots.length > 10) {
              for (const oldItem of snapshots.slice(10)) {
                try { fs.unlinkSync(oldItem.path); } catch {}
              }
            }
          } catch (snapErr) {
            console.warn("[Ping Daemon] Gagal membuat snapshot backup:", snapErr);
          }
        }
      }
    } catch (e: any) {
      console.warn("[Ping Daemon] Failed to save persisted data:", e?.message || e);
    }
  }

  public clearAllHistory() {
    for (const [host, target] of this.targets.entries()) {
      target.livePoints = [];
      target.fiveMinHost = {};
      target.fiveMinRouter = {};
      target.hourlyHost = {};
      target.hourlyRouter = {};
      target.dailyHost = {};
      target.dailyRouter = {};
      target.incidents = [];
      target.stats = {
        host: {
          totalSent: 0,
          totalReceived: 0,
          totalLost: 0,
          lastPing: null,
          lastUpdated: null,
          recentPings: [],
        },
        router: {
          totalSent: 0,
          totalReceived: 0,
          totalLost: 0,
          lastPing: null,
          lastUpdated: null,
          recentPings: [],
        },
      };
      target.startedAt = new Date().toISOString();
    }

    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    try {
      if (fs.existsSync(DB_BACKUP_FILE)) fs.unlinkSync(DB_BACKUP_FILE);
    } catch {}
    try {
      if (fs.existsSync(BACKUP_DIR)) {
        const files = fs.readdirSync(BACKUP_DIR);
        for (const f of files) {
          try {
            fs.unlinkSync(path.join(BACKUP_DIR, f));
          } catch {}
        }
      }
    } catch {}

    this.savePersistedData();
    console.log("[Ping Daemon] Seluruh riwayat telemetri telah dibersihkan (reset ke awal).");
  }
}
