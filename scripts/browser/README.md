# CloakBrowser Persistent Launcher (DLLM Stage 1)

Dedicated persistent browser launcher providing loopback-only Chrome DevTools Protocol (CDP) connectivity on port `9223`.

> **Safety Notice**: Production scanners currently use Brave on port `9222`. CloakBrowser runs independently on port `9223` without interfering with Brave.

---

## 1. Quick Start

### Start CloakBrowser
Launches a persistent headed browser instance and exposes CDP on `http://127.0.0.1:9223`:

```bash
npm run browser:cloak
```

Profile data is persisted outside the Git repository at:
`~/.cloakbrowser/profiles/dllm-profile`

### Start in Headless Mode (Optional)
```bash
npm run browser:cloak -- --headless
```

---

## 2. Confirm CDP Readiness

### Via CLI:
```bash
npm run browser:cloak -- --status
```
Outputs active port, browser version, WebSocket debugger URL, and lock PID.

### Via HTTP:
```bash
curl -s http://127.0.0.1:9223/json/version
```
Expected response:
```json
{
  "Browser": "Chrome/145.0.7632.109",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/browser/..."
}
```

---

## 3. Connect with Playwright

Multiple scanner runs or scripts connect to the running browser without restarting it:

```javascript
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const context = browser.contexts()[0];

// Create and use page
const page = await context.newPage();
await page.goto("https://app.lpagent.io");

// Clean up client session (leaves CloakBrowser running)
await page.close();
await browser.close();
```

---

## 4. Stop the Browser Safely

### Option A: From another terminal
```bash
npm run browser:cloak -- --stop
```

### Option B: Terminal running the launcher
Press `Ctrl+C` (`SIGINT`).

Both options perform a graceful context closure, persist cookies and storage, and remove the lockfile.

---

## 5. Recover from a Disconnected Browser

If a script disconnects prematurely or loses WebSocket connectivity:
1. CloakBrowser remains running with all tabs and session data preserved.
2. The client script can immediately reconnect using `chromium.connectOverCDP("http://127.0.0.1:9223")`.
3. If the browser process became unresponsive:
   ```bash
   npm run browser:cloak -- --stop
   npm run browser:cloak
   ```

---

## 6. Identify & Resolve Profile-Lock Conflicts

The launcher prevents duplicate instances from corrupting the profile using `launcher.lock` located at `~/.cloakbrowser/profiles/dllm-profile/launcher.lock`.

### Identifying a Conflict
If you run `npm run browser:cloak` while another instance is already running:
```text
[CloakLauncher] Failed to start CloakBrowser: Profile lock conflict: CloakBrowser is already running (PID: 12345, port: 9223)
  Hint: Another CloakBrowser instance is already running with this profile.
  Check status:  npm run browser:cloak -- --status
  Stop instance: npm run browser:cloak -- --stop
```

### Resolving Stale Locks
If a previous process crashed abnormally, the launcher automatically detects when the PID is dead and replaces the stale lock. You can also clear stale state using:
```bash
npm run browser:cloak -- --stop
```
