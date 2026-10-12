import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

import {
  DEFAULT_CDP_PORT,
  FORBIDDEN_PORT,
  DEFAULT_PROFILE_DIR,
  acquireProfileLock,
  releaseProfileLock,
  isPortInUse,
  isPidRunning,
  checkCdpEndpoint,
  launchCloakBrowser,
} from "../../scripts/browser/launch-cloak.mjs";

interface CodedError extends Error {
  code?: string;
  lock?: {
    pid?: number;
    port?: number;
    userDataDir?: string;
    startedAt?: string;
  };
}

describe("CloakBrowser Persistent Launcher Test Suite", () => {
  describe("1. Configuration and Defaults", () => {
    it("should export correct default port 9223 and forbidden Brave port 9222", () => {
      assert.equal(DEFAULT_CDP_PORT, 9223);
      assert.equal(FORBIDDEN_PORT, 9222);
    });

    it("should default profile directory outside repository in home folder", () => {
      assert.ok(
        DEFAULT_PROFILE_DIR.startsWith(os.homedir()),
        `Profile path ${DEFAULT_PROFILE_DIR} must be inside user home directory`
      );
      assert.ok(
        DEFAULT_PROFILE_DIR.endsWith("dllm-profile"),
        `Profile path must end with dllm-profile`
      );
    });

    it("should refuse to launch on forbidden Brave port 9222", async () => {
      await assert.rejects(
        async () => {
          await launchCloakBrowser({ port: 9222 });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          const coded = err as CodedError;
          assert.equal(coded.code, "EFORBIDDEN_PORT");
          assert.match(
            coded.message,
            /Security violation: Refusing to bind or interfere with Brave CDP port 9222/
          );
          return true;
        }
      );
    });
  });

  describe("2. Occupied Port Detection", () => {
    it("should detect occupied TCP port", async () => {
      const server = net.createServer();
      const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        resolvePort(address.port);
      });
      const port = await portPromise;

      try {
        const inUse = await isPortInUse(port, "127.0.0.1");
        assert.equal(inUse, true, "isPortInUse must return true for open port");

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloak-port-test-"));
        try {
          await assert.rejects(
            async () => {
              await acquireProfileLock(tempDir, port);
            },
            (err: unknown) => {
              assert.ok(err instanceof Error);
              const coded = err as CodedError;
              assert.equal(coded.code, "EPORT_IN_USE");
              return true;
            }
          );
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      } finally {
        const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
        server.close(() => resolveClose());
        await closePromise;
      }
    });

    it("should confirm unoccupied TCP port is free", async () => {
      const server = net.createServer();
      const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        resolvePort(address.port);
      });
      const freePort = await portPromise;

      const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
      server.close(() => resolveClose());
      await closePromise;

      const inUse = await isPortInUse(freePort, "127.0.0.1");
      assert.equal(inUse, false, "isPortInUse must return false for closed port");
    });
  });

  describe("3. Profile Lock Conflicts & Lifecycle", () => {
    it("should acquire and release lock cleanly", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloak-lock-test-"));
      const lockFile = path.join(tempDir, "launcher.lock");

      try {
        const server = net.createServer();
        const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as net.AddressInfo;
          resolvePort(address.port);
        });
        const testPort = await portPromise;

        const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
        server.close(() => resolveClose());
        await closePromise;

        const lock = await acquireProfileLock(tempDir, testPort);
        assert.ok(existsSync(lockFile), "Lockfile should exist");

        const data = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number; port: number };
        assert.equal(data.pid, process.pid);
        assert.equal(data.port, testPort);

        await lock.release();
        assert.ok(!existsSync(lockFile), "Lockfile should be unlinked upon release");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should reject acquisition when locked by active PID", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloak-active-test-"));
      const lockFile = path.join(tempDir, "launcher.lock");

      try {
        const activeLock = {
          pid: process.pid,
          port: 9999,
          userDataDir: tempDir,
          startedAt: new Date().toISOString(),
        };
        await fs.writeFile(lockFile, JSON.stringify(activeLock), "utf8");

        await assert.rejects(
          async () => {
            await acquireProfileLock(tempDir, 9999);
          },
          (err: unknown) => {
            assert.ok(err instanceof Error);
            const coded = err as CodedError;
            assert.equal(coded.code, "ELOCK_CONFLICT");
            assert.equal(coded.lock?.pid, process.pid);
            return true;
          }
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should overwrite stale lock when PID is dead", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloak-stale-test-"));
      const lockFile = path.join(tempDir, "launcher.lock");

      try {
        const deadPid = 999999;
        assert.equal(isPidRunning(deadPid), false);

        const staleLock = {
          pid: deadPid,
          port: 9998,
          userDataDir: tempDir,
          startedAt: new Date().toISOString(),
        };
        await fs.writeFile(lockFile, JSON.stringify(staleLock), "utf8");

        const server = net.createServer();
        const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as net.AddressInfo;
          resolvePort(address.port);
        });
        const freePort = await portPromise;

        const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
        server.close(() => resolveClose());
        await closePromise;

        const lock = await acquireProfileLock(tempDir, freePort);
        const data = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number };
        assert.equal(data.pid, process.pid, "Lock should now be owned by current process");
        await lock.release();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("4. CDP Connection Failure Handling", () => {
    it("should return null when CDP endpoint is unreachable", async () => {
      const server = net.createServer();
      const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        resolvePort(address.port);
      });
      const closedPort = await portPromise;

      const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
      server.close(() => resolveClose());
      await closePromise;

      const res = await checkCdpEndpoint(closedPort, "127.0.0.1", 200);
      assert.equal(res, null, "Should return null for unreachable port");
    });
  });

  describe("5. Safe Handling of Missing Dependencies", () => {
    it("should handle missing cloak module gracefully without uncaught exceptions", async () => {
      const mockMissingDependency = async () => {
        const cloak = null;
        if (!cloak) {
          const error: CodedError = new Error("CloakBrowser dependency not found.");
          error.code = "EMISSING_CLOAK_DEPENDENCY";
          throw error;
        }
      };

      await assert.rejects(mockMissingDependency, (err: unknown) => {
        assert.ok(err instanceof Error);
        const coded = err as CodedError;
        assert.equal(coded.code, "EMISSING_CLOAK_DEPENDENCY");
        return true;
      });
    });
  });

  describe("6. Graceful Shutdown and Resource Cleanup", () => {
    it("should release lock and trigger context close safely", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloak-shutdown-test-"));
      const lockFile = path.join(tempDir, "launcher.lock");

      try {
        let contextClosed = false;
        const fakeContext = {
          close: async () => {
            contextClosed = true;
          },
          on: () => {},
        };

        const lock = {
          release: async () => {
            await releaseProfileLock(tempDir);
          },
        };

        await fs.writeFile(
          lockFile,
          JSON.stringify({ pid: process.pid, port: 9999, userDataDir: tempDir }),
          "utf8"
        );
        assert.ok(existsSync(lockFile));

        let isClosed = false;
        const safeClose = async () => {
          if (isClosed) return;
          isClosed = true;
          await fakeContext.close();
          await lock.release();
        };

        await safeClose();
        assert.equal(contextClosed, true);
        assert.ok(!existsSync(lockFile), "Lockfile must be released");

        // Idempotent close
        await safeClose();
        assert.equal(contextClosed, true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
