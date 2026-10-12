#!/usr/bin/env node
/**
 * CloakBrowser Persistent Launcher with CDP connectivity for DLLM.
 *
 * Dedicated to port 9223 (default).
 * Never uses or interferes with Brave on port 9222.
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, "../..");

export const DEFAULT_CDP_PORT = 9223;
export const DEFAULT_CLOAK_CDP_URL = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
export const FORBIDDEN_PORT = 9222; // Legacy Brave port (strictly forbidden)

export function resolveCloakCdpUrl(customUrl = null) {
  const raw =
    customUrl?.trim() ||
    process.env.CLOAK_CDP_URL?.trim() ||
    process.env.FABRIQ_CDP_URL?.trim() ||
    process.env.LPAGENT_CDP_URL?.trim() ||
    (process.env.CLOAK_CDP_PORT ? `http://127.0.0.1:${process.env.CLOAK_CDP_PORT.trim()}` : null) ||
    DEFAULT_CLOAK_CDP_URL;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error(`Invalid CloakBrowser CDP URL: "${raw}"`);
    err.code = "EINVALID_CDP_URL";
    throw err;
  }

  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  if (port === FORBIDDEN_PORT) {
    const err = new Error(
      `Security violation: Refusing to connect to Brave CDP port ${FORBIDDEN_PORT}. Use CloakBrowser on port ${DEFAULT_CDP_PORT}. Silent fallback to Brave is strictly forbidden.`
    );
    err.code = "EFORBIDDEN_PORT";
    throw err;
  }

  return raw.replace(/\/+$/, "");
}
export const DEFAULT_PROFILE_DIR = path.join(
  os.homedir(),
  ".cloakbrowser",
  "profiles",
  "dllm-profile"
);

/**
 * Resolve CloakBrowser module from standard node_modules or isolated environment.
 */
export async function getCloakBrowserModule() {
  try {
    return await import("cloakbrowser");
  } catch {
    const isolatedPath = path.resolve(
      ROOT_DIR,
      "data/bench/cloak-env/node_modules/cloakbrowser/dist/index.js"
    );
    try {
      return await import(pathToFileURL(isolatedPath).href);
    } catch {
      return null;
    }
  }
}

/**
 * Check if a TCP port is in use on loopback.
 */
export function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Check if a process ID is currently running.
 */
export function isPidRunning(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // Process exists but owned by another user
  }
}

/**
 * Acquire process and profile lock to prevent duplicate launcher instances.
 */
export async function acquireProfileLock(userDataDir, port) {
  await fs.mkdir(userDataDir, { recursive: true });
  const lockFilePath = path.join(userDataDir, "launcher.lock");

  if (existsSync(lockFilePath)) {
    try {
      const lockContent = JSON.parse(readFileSync(lockFilePath, "utf8"));
      if (lockContent.pid && isPidRunning(lockContent.pid)) {
        const error = new Error(
          `Profile lock conflict: CloakBrowser is already running (PID: ${lockContent.pid}, port: ${lockContent.port || port}) at ${userDataDir}`
        );
        error.code = "ELOCK_CONFLICT";
        error.lock = lockContent;
        throw error;
      } else {
        // Stale lock file
        await fs.unlink(lockFilePath).catch(() => {});
      }
    } catch (err) {
      if (err.code === "ELOCK_CONFLICT") throw err;
      // Stale or corrupted lock
      await fs.unlink(lockFilePath).catch(() => {});
    }
  }

  // Check if port is already occupied
  const portActive = await isPortInUse(port);
  if (portActive) {
    const error = new Error(
      `Port conflict: Port ${port} is already in use by another process.`
    );
    error.code = "EPORT_IN_USE";
    throw error;
  }

  const lockData = {
    pid: process.pid,
    port,
    userDataDir,
    startedAt: new Date().toISOString(),
  };

  await fs.writeFile(lockFilePath, JSON.stringify(lockData, null, 2), "utf8");
  return {
    lockFilePath,
    release: async () => {
      try {
        if (existsSync(lockFilePath)) {
          const current = JSON.parse(readFileSync(lockFilePath, "utf8"));
          if (current.pid === process.pid) {
            await fs.unlink(lockFilePath);
          }
        }
      } catch {
        // Ignore during shutdown
      }
    },
  };
}

/**
 * Release profile lock.
 */
export async function releaseProfileLock(userDataDir) {
  const lockFilePath = path.join(userDataDir, "launcher.lock");
  try {
    if (existsSync(lockFilePath)) {
      await fs.unlink(lockFilePath);
    }
  } catch {
    // Ignore error
  }
}

/**
 * Check CDP endpoint readiness by fetching /json/version.
 */
export async function checkCdpEndpoint(port = DEFAULT_CDP_PORT, host = "127.0.0.1", timeoutMs = 2000) {
  const url = `http://${host}:${port}/json/version`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Launch CloakBrowser with persistent context and exposed loopback CDP endpoint.
 */
export async function launchCloakBrowser(options = {}) {
  const port = options.port ?? (process.env.CLOAK_CDP_PORT ? Number(process.env.CLOAK_CDP_PORT) : DEFAULT_CDP_PORT);
  const host = options.host ?? "127.0.0.1";
  const headless = options.headless ?? (process.env.CLOAK_HEADLESS === "true");
  const userDataDir = options.userDataDir ?? (process.env.CLOAK_USER_DATA_DIR || DEFAULT_PROFILE_DIR);

  if (port === FORBIDDEN_PORT) {
    const error = new Error(
      `Security violation: Refusing to bind or interfere with Brave CDP port ${FORBIDDEN_PORT}. Use port ${DEFAULT_CDP_PORT} instead.`
    );
    error.code = "EFORBIDDEN_PORT";
    throw error;
  }

  // Profile location safety check: warn/prevent committing profile to git
  const resolvedUserData = path.resolve(userDataDir);
  const resolvedRoot = path.resolve(ROOT_DIR);
  if (
    resolvedUserData.startsWith(resolvedRoot) &&
    !resolvedUserData.includes("/tmp") &&
    !resolvedUserData.includes("/data/bench/") &&
    process.env.NODE_ENV !== "test"
  ) {
    console.warn(
      `[CloakLauncher] WARNING: Profile path (${resolvedUserData}) is inside repo directory. Preferred location is outside repo: ${DEFAULT_PROFILE_DIR}`
    );
  }

  const cloak = await getCloakBrowserModule();
  if (!cloak) {
    const error = new Error(
      "CloakBrowser dependency not found. Ensure 'cloakbrowser' is installed."
    );
    error.code = "EMISSING_CLOAK_DEPENDENCY";
    throw error;
  }

  // Acquire lock
  const lock = await acquireProfileLock(userDataDir, port);

  try {
    const context = await cloak.launchPersistentContext({
      userDataDir,
      headless,
      args: [
        `--remote-debugging-port=${port}`,
        `--remote-debugging-address=${host}`,
      ],
      ...(options.cloakOptions || {}),
    });

    // Poll for CDP endpoint readiness
    let cdpReady = false;
    let versionInfo = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      versionInfo = await checkCdpEndpoint(port, host, 1000);
      if (versionInfo) {
        cdpReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!cdpReady) {
      await context.close().catch(() => {});
      await lock.release().catch(() => {});
      const error = new Error(
        `Failed to reach CloakBrowser CDP endpoint at http://${host}:${port}/json/version within 15s.`
      );
      error.code = "ECDP_TIMEOUT";
      throw error;
    }

    const cdpUrl = `http://${host}:${port}`;

    let isClosed = false;
    const safeClose = async () => {
      if (isClosed) return;
      isClosed = true;
      try {
        await context.close();
      } catch {
        // Ignore error on close
      } finally {
        await lock.release();
      }
    };

    context.on("close", () => {
      isClosed = true;
      lock.release().catch(() => {});
    });

    return {
      context,
      cdpUrl,
      versionInfo,
      userDataDir,
      port,
      host,
      close: safeClose,
    };
  } catch (err) {
    await lock.release().catch(() => {});
    throw err;
  }
}

// -----------------------------------------------------------------------------
// CLI Handler
// -----------------------------------------------------------------------------

export function parseLauncherCliArgs(args = process.argv.slice(2)) {
  let port = process.env.CLOAK_CDP_PORT ? Number(process.env.CLOAK_CDP_PORT) : DEFAULT_CDP_PORT;
  let userDataDir = process.env.CLOAK_USER_DATA_DIR || DEFAULT_PROFILE_DIR;
  const headless = args.includes("--headless") || process.env.CLOAK_HEADLESS === "true";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--profile" && args[i + 1]) {
      userDataDir = args[i + 1];
      i++;
    }
  }

  return { port, userDataDir, headless };
}

async function runCli() {
  const args = process.argv.slice(2);
  const { port, userDataDir, headless } = parseLauncherCliArgs(args);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
CloakBrowser Persistent Launcher

Usage:
  npm run browser:cloak           Start persistent headed CloakBrowser with CDP on :9223
  npm run browser:cloak -- --status   Check status of running CloakBrowser instance
  npm run browser:cloak -- --stop     Stop the running instance safely

Options:
  --status    Query CDP endpoint (:9223) and lockfile status
  --stop      Signal the running instance to stop
  --headless  Run CloakBrowser in headless mode (default: headed)
  --port <p>  Custom CDP port (default: 9223)
  --profile   Custom persistent profile directory (default: ~/.cloakbrowser/profiles/dllm-profile)
`);
    process.exit(0);
  }

  if (args.includes("--status")) {
    const version = await checkCdpEndpoint(port);
    const lockPath = path.join(userDataDir, "launcher.lock");
    let lockData = null;
    if (existsSync(lockPath)) {
      try {
        lockData = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {}
    }

    if (version) {
      console.log(`[CloakLauncher] Active on http://127.0.0.1:${port}`);
      console.log(`  Browser: ${version.Browser}`);
      console.log(`  User-Agent: ${version["User-Agent"]}`);
      console.log(`  WebSocket Debugger: ${version.webSocketDebuggerUrl}`);
      if (lockData) {
        console.log(`  Lock PID: ${lockData.pid} (running: ${isPidRunning(lockData.pid)})`);
        console.log(`  Profile Dir: ${lockData.userDataDir}`);
      }
      process.exit(0);
    } else {
      console.log(`[CloakLauncher] No active CloakBrowser found on port ${port}.`);
      if (lockData) {
        console.log(`  Stale lock file found for PID ${lockData.pid} (active: ${isPidRunning(lockData.pid)}).`);
      }
      process.exit(1);
    }
  }

  if (args.includes("--stop")) {
    const lockPath = path.join(userDataDir, "launcher.lock");
    if (!existsSync(lockPath)) {
      console.log(`[CloakLauncher] No lock file found at ${lockPath}. Browser does not appear to be running.`);
      process.exit(0);
    }

    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lockData.pid && isPidRunning(lockData.pid)) {
        console.log(`[CloakLauncher] Sending SIGTERM to PID ${lockData.pid}...`);
        process.kill(lockData.pid, "SIGTERM");
        let stopped = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (!isPidRunning(lockData.pid)) {
            stopped = true;
            break;
          }
        }
        if (stopped) {
          console.log("[CloakLauncher] Browser stopped successfully.");
        } else {
          console.log("[CloakLauncher] Process did not terminate after 4s; sending SIGKILL...");
          process.kill(lockData.pid, "SIGKILL");
        }
      } else {
        console.log(`[CloakLauncher] Stale lockfile detected (PID ${lockData.pid} is not running). Removing lock.`);
        await fs.unlink(lockPath);
      }
    } catch (err) {
      console.error(`[CloakLauncher] Error stopping browser: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // headless already parsed above

  console.log("==================================================");
  console.log(" CloakBrowser Persistent Launcher (DLLM)");
  console.log("==================================================");
  console.log(`CDP Port:       ${port} (loopback only)`);
  console.log(`Profile Dir:    ${userDataDir}`);
  console.log(`Display Mode:   ${headless ? "Headless" : "Headed"}`);
  console.log("--------------------------------------------------");

  let instance = null;

  const handleSignal = async (signal) => {
    console.log(`\n[CloakLauncher] Received ${signal}. Shutting down cleanly...`);
    if (instance) {
      await instance.close();
      instance = null;
    }
    console.log("[CloakLauncher] Browser closed. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    instance = await launchCloakBrowser({
      port,
      userDataDir,
      headless,
    });

    console.log(`[CloakLauncher] CloakBrowser successfully started!`);
    console.log(`  CDP URL:        ${instance.cdpUrl}`);
    console.log(`  Browser:        ${instance.versionInfo.Browser}`);
    console.log(`  PID:            ${process.pid}`);
    console.log(`\nReady for CDP connections. Press Ctrl+C or run 'npm run browser:cloak -- --stop' to shut down.\n`);

    instance.context.on("close", () => {
      console.log("[CloakLauncher] Browser window/context was closed.");
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
  } catch (err) {
    console.error(`\n[CloakLauncher] Failed to start CloakBrowser: ${err.message}`);
    if (err.code === "ELOCK_CONFLICT") {
      console.error(`  Hint: Another CloakBrowser instance is already running with this profile.`);
      console.error(`  Check status:  npm run browser:cloak -- --status`);
      console.error(`  Stop instance: npm run browser:cloak -- --stop`);
    } else if (err.code === "EPORT_IN_USE") {
      console.error(`  Hint: Port ${port} is currently bound by another process.`);
    } else if (err.code === "EMISSING_CLOAK_DEPENDENCY") {
      console.error(`  Hint: CloakBrowser package or binary is missing.`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli();
}
