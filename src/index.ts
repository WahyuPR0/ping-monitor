import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { RouterOSAPI } from "routeros-client";
import { PingDaemon } from "./ping_daemon.js";

dotenv.config();

const PORT = parseInt(process.env.PORT || "80", 10);
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || "";
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT || "8728", 10);
const MIKROTIK_USER = process.env.MIKROTIK_USER || "admin";
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD || "";

export class PingMonitorServer {
  private app: express.Express;
  private api: RouterOSAPI | null = null;
  private pingDaemon: PingDaemon;
  private connectingPromise: Promise<void> | null = null;

  constructor() {
    this.app = express();
    this.pingDaemon = new PingDaemon();

    this.setupProcessHandlers();
    this.setupRoutes();
  }

  private setupProcessHandlers() {
    process.on("SIGINT", () => {
      console.log("\n[Ping Monitor] Shutting down gracefully...");
      this.pingDaemon.stop();
      this.closeApi();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\n[Ping Monitor] Received SIGTERM. Shutting down...");
      this.pingDaemon.stop();
      this.closeApi();
      process.exit(0);
    });

    process.on("uncaughtException", (err: any) => {
      console.error("[Uncaught Exception]", err?.message || err);
    });

    process.on("unhandledRejection", (reason: any) => {
      console.error("[Unhandled Rejection]", reason?.message || reason);
    });
  }

  private createRouterApi(): RouterOSAPI {
    const api = new RouterOSAPI({
      host: MIKROTIK_HOST,
      user: MIKROTIK_USER,
      password: MIKROTIK_PASSWORD,
      port: MIKROTIK_PORT,
      timeout: 3,
      keepalive: true,
    });

    api.on("error", (error: any) => {
      console.warn("[RouterOS Socket Event]", error?.message || error);
    });

    return api;
  }

  private closeApi() {
    try {
      if (this.api && this.api.connected) {
        this.api.close();
      }
    } catch {}
  }

  public async verifyRouterConnection(): Promise<{ valid: boolean; error?: string }> {
    if (!MIKROTIK_HOST || !MIKROTIK_HOST.trim()) {
      return { valid: false, error: "MIKROTIK_HOST di file .env belum diisi." };
    }
    if (!MIKROTIK_PASSWORD || !MIKROTIK_PASSWORD.trim()) {
      return { valid: false, error: "MIKROTIK_PASSWORD di file .env belum diisi." };
    }

    let testApi: RouterOSAPI | null = null;
    try {
      testApi = new RouterOSAPI({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER || "admin",
        password: MIKROTIK_PASSWORD,
        port: MIKROTIK_PORT || 8728,
        timeout: 3,
        keepalive: false,
      });

      testApi.on("error", () => {}); // Mencegah unhandled socket exception

      await Promise.race([
        testApi.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (3 detik) tidak ada respon dari " + MIKROTIK_HOST)), 3000)),
      ]);

      try {
        testApi.close();
      } catch {}

      return { valid: true };
    } catch (err: any) {
      try {
        if (testApi && testApi.connected) testApi.close();
      } catch {}
      return {
        valid: false,
        error: `Gagal terhubung ke MikroTik (${MIKROTIK_HOST}:${MIKROTIK_PORT}): ${err?.message || "Koneksi ditolak atau timeout"}`,
      };
    }
  }

  public async connectApi(): Promise<void> {
    if (!this.pingDaemon.getRouterPingEnabled() || !MIKROTIK_HOST || !MIKROTIK_PASSWORD) return;
    if (this.api && this.api.connected) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = (async () => {
      try {
        if (!this.api) {
          this.api = this.createRouterApi();
        }
        await this.api.connect();
      } catch (err: any) {
        console.warn("[RouterOS] Re-establishing connection:", err?.message || err);
        this.closeApi();
        this.api = this.createRouterApi();
        try {
          await this.api.connect();
        } catch {}
      } finally {
        this.connectingPromise = null;
      }
    })();

    return this.connectingPromise;
  }

  public async runMikrotikPing(address: string, timeoutMs: number = 900): Promise<{ pingMs: number | null; ttl?: number; isLoss: boolean }> {
    if (!this.pingDaemon.getRouterPingEnabled() || !MIKROTIK_HOST || !MIKROTIK_PASSWORD) {
      return { pingMs: null, isLoss: true };
    }

    const timeoutPromise = new Promise<{ pingMs: number | null; ttl?: number; isLoss: boolean }>((resolve) => {
      setTimeout(() => resolve({ pingMs: null, isLoss: true }), timeoutMs);
    });

    const pingPromise = (async () => {
      try {
        await this.connectApi();
        if (!this.api || !this.api.connected) {
          return { pingMs: null, isLoss: true };
        }
        const res = await (this.api as any).write("/ping", [`=address=${address}`, "=count=1", "=interval=100ms"]);
        const entry = Array.isArray(res) ? res[0] : res;
        if (entry && String(entry.received) === "1") {
          let calculatedMs = 0;
          const timeStr = String(entry.time || entry["avg-rtt"] || "");
          const msMatch = timeStr.match(/([0-9]+)ms/);
          const usMatch = timeStr.match(/([0-9]+)us/);
          if (msMatch) calculatedMs += parseInt(msMatch[1], 10);
          if (usMatch) calculatedMs += parseInt(usMatch[1], 10) / 1000;
          if (!msMatch && !usMatch && timeStr) {
            calculatedMs = parseFloat(timeStr) || 1;
          }
          const timeMs = Math.round(calculatedMs * 10) / 10;
          const ttl = entry.ttl ? parseInt(String(entry.ttl), 10) : undefined;
          return { pingMs: timeMs, ttl, isLoss: false };
        }
        return { pingMs: null, isLoss: true };
      } catch {
        return { pingMs: null, isLoss: true };
      }
    })();

    return Promise.race([pingPromise, timeoutPromise]);
  }

  private setupRoutes() {
    this.app.use(cors({ origin: "*" }));
    this.app.use(express.json());

    // Static assets directory
    const publicDir = path.resolve(process.cwd(), "public");
    this.app.use(express.static(publicDir));

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        app: "ping-monitor",
        version: "1.0.0",
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    });

    // Time-series Network Telemetry API (1h, 12h, 24h, 7d, 30d)
    this.app.get("/api/ping/telemetry", (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      const target = String(req.query.target || "1.1.1.1").trim();
      const range = (String(req.query.range || "1h").toLowerCase() as "1h" | "12h" | "24h" | "7d" | "30d");
      const source = (String(req.query.source || "both").toLowerCase() as "host" | "router" | "both");
      const zoom = parseInt(String(req.query.zoom || "0"), 10) || 0;

      const validRanges = ["1h", "12h", "24h", "7d", "30d"];
      const selectedRange = validRanges.includes(range) ? range : "1h";

      const telemetry = this.pingDaemon.getTelemetry(target, selectedRange, source, zoom);
      res.json(telemetry);
    });

    // Ephemeral On-Demand Custom Domain/IP Probe
    this.app.get("/api/ping/probe", async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      const target = String(req.query.target || "").trim();
      if (!target) {
        return res.status(400).json({ error: "Parameter target wajib diisi." });
      }
      try {
        const result = await this.pingDaemon.probeCustomOnce(target);
        res.json(result);
      } catch (err: any) {
        res.status(400).json({ error: err?.message || "Gagal melakukan uji ping." });
      }
    });

    // Configuration & MikroTik Router Ping Toggle Endpoint
    this.app.get("/api/ping/config", (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      res.json({
        routerPingEnabled: this.pingDaemon.getRouterPingEnabled(),
        mikrotikConfigured: Boolean(MIKROTIK_HOST && MIKROTIK_PASSWORD),
        mikrotikHost: MIKROTIK_HOST || null,
        targets: this.pingDaemon.getConfiguredTargets(),
      });
    });

    this.app.post("/api/ping/toggle-router", async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      const current = this.pingDaemon.getRouterPingEnabled();
      const next = typeof req.body?.enabled === "boolean" ? req.body.enabled : !current;

      if (!next) {
        this.pingDaemon.setRouterPingEnabled(false);
        this.closeApi();
        return res.json({
          success: true,
          routerPingEnabled: false,
          valid: true,
          message: "Ping MikroTik dinonaktifkan.",
        });
      }

      // Verifikasi koneksi dan kelayakan .env sebelum mengaktifkan
      const verification = await this.verifyRouterConnection();
      if (!verification.valid) {
        this.pingDaemon.setRouterPingEnabled(false);
        this.closeApi();
        return res.status(200).json({
          success: false,
          routerPingEnabled: false,
          valid: false,
          error: verification.error || "Konfigurasi MikroTik di .env tidak valid atau router tidak merespon.",
        });
      }

      // Jika terverifikasi sukses, aktifkan
      this.pingDaemon.setRouterPingEnabled(true);
      try {
        await this.connectApi();
      } catch (err: any) {
        console.warn("[RouterOS] Post-verification connect attempt:", err?.message || err);
      }

      return res.json({
        success: true,
        routerPingEnabled: true,
        valid: true,
        message: `Koneksi MikroTik (${MIKROTIK_HOST}) berhasil diverifikasi dan aktif!`,
      });
    });

    // Reset / Clear all telemetry history
    this.app.post("/api/ping/reset-history", (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      try {
        this.pingDaemon.clearAllHistory();
        res.json({ ok: true, success: true, message: "Seluruh riwayat telemetri berhasil dibersihkan." });
      } catch (err: any) {
        res.status(500).json({ ok: false, success: false, error: err?.message || "Gagal mereset data" });
      }
    });

    // Available permanent targets
    this.app.get("/api/ping/targets", (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      res.json(this.pingDaemon.getAvailableTargets());
    });

    // Real-time Ping Monitor Dashboard (served on root, /monitor, /ping, /status)
    const renderDashboard = (req: express.Request, res: express.Response) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "text/html; charset=utf-8");
      const monitorFilePath = path.resolve(publicDir, "monitor.html");
      if (fs.existsSync(monitorFilePath)) {
        res.sendFile(monitorFilePath);
      } else {
        res.status(404).send("Dashboard HTML file not found.");
      }
    };

    this.app.get("/", renderDashboard);
    this.app.get(["/monitor", "/ping", "/status"], renderDashboard);
  }

  public async start() {
    this.pingDaemon.setMikrotikPingHandler(this.runMikrotikPing.bind(this));
    this.pingDaemon.start();

    const tryListen = (portToTry: number) => {
      const server = this.app.listen(portToTry, "0.0.0.0", () => {
        const interfaces = os.networkInterfaces();
        const localIps: string[] = [];
        for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name] || []) {
            if (iface.family === "IPv4" && !iface.internal) {
              localIps.push(iface.address);
            }
          }
        }

        console.log("===============================================================");
        console.log("   NETWORK TELEMETRY & REAL-TIME PING MONITOR                  ");
        console.log("===============================================================");
        console.log(`Port           : ${portToTry}`);
        console.log(`Local Access   : http://localhost${portToTry === 80 ? "" : ":" + portToTry}`);
        for (const ip of localIps) {
          console.log(`Network Access : http://${ip}${portToTry === 80 ? "" : ":" + portToTry}`);
        }
        console.log(`MikroTik Router: ${this.pingDaemon.getRouterPingEnabled() && MIKROTIK_HOST ? `${MIKROTIK_HOST}:${MIKROTIK_PORT}` : "Disabled (Host Ping Only)"}`);
        console.log("===============================================================");
      });

      server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE" && portToTry === 80) {
          console.warn(`[Ping Monitor] Port 80 in use, falling back to port 8080...`);
          tryListen(8080);
        } else {
          console.error(`[Ping Monitor] Server failed to start on port ${portToTry}:`, err);
        }
      });
    };

    tryListen(PORT);
  }
}

const monitorServer = new PingMonitorServer();
monitorServer.start();
