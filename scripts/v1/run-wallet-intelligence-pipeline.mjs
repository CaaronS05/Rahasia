import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Orchestration only: each existing script owns its inputs, formulas, and outputs.
export const STAGES = [
  ["historical_cohort", "build-historical-cohort-dataset.ts"],
  ["quality", "build-wallet-quality-scores.ts"],
  ["risk_metrics", "build-wallet-risk-metrics.ts"],
  ["risk_score", "build-wallet-risk-scores.ts"],
  ["confidence", "build-wallet-confidence-scores.ts"],
  ["style_readiness", "build-wallet-style-readiness.ts"],
  ["style", "build-wallet-style-classifications.ts"],
  ["shortlist", "build-wallet-shortlist.ts"],
  ["publish", "publish-wallet-intelligence.ts"],
  ["audit", "audits/audit-v1-end-to-end.ts"],
];

export async function runWalletIntelligencePipeline({
  spawnStage = spawn,
  emit = (event) => console.log(`[WALLET_INTELLIGENCE] ${JSON.stringify(event)}`),
} = {}) {
  let child = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (const [stage, script] of STAGES) {
      if (stopping) break;
      emit({ stage, status: "running" });
      try {
        await new Promise((resolve, reject) => {
          child = spawnStage(process.execPath, ["--experimental-strip-types", `scripts/v1/${script}`], {
            cwd: ROOT,
            env: { ...process.env },
            // Inherit the runner's process group so the control server stops the entire tree.
            stdio: "inherit",
          });
          child.once("error", reject);
          child.once("close", (code, signal) => {
            child = null;
            if (stopping) resolve();
            else if (code === 0) resolve();
            else reject(new Error(`${stage} failed (${signal || `exit ${code}`})`));
          });
        });
      } catch (error) {
        if (stopping) break;
        emit({ stage, status: "error", error: error.message });
        throw error;
      }
      if (stopping) break;
      emit({ stage, status: "completed" });
    }
    emit({ stage: stopping ? "stopped" : "completed", status: stopping ? "stopped" : "completed" });
    return stopping ? 143 : 0;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWalletIntelligencePipeline().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[WALLET INTELLIGENCE FAILED] ${error.message}`);
    process.exitCode = 1;
  });
}
