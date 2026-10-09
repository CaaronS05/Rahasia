# OMP Subagent Routing Policy

## Agent Roster
| Agent | Role | Scope | Permitted Tools | Mutating |
|---|---|---|---|---|
| `dllm-network-auditor` | Network Auditor | External APIs, CDP, rate limits, 429/5xx resilience | `read`, `grep`, `glob`, `find` | No |
| `dllm-data-integrity-auditor` | Data Integrity Auditor | Persistence, locks, idempotency, metric isolation | `read`, `grep`, `glob`, `find` | No |
| `dllm-analytics-specialist` | Analytics Specialist | DLMM math, PnL, lifecycle extraction, sampling | `read`, `grep`, `glob`, `find`, `edit`, `write` | Yes (isolated) |
| `dllm-frontend-specialist` | Frontend Specialist | React 19/Vite UI, hooks, contracts, states | `read`, `grep`, `glob`, `find`, `edit`, `write` | Yes (isolated) |
| `dllm-qa-specialist` | QA Specialist | Regression analysis, edge cases, verification planning | `read`, `grep`, `glob`, `find` | No |

## Core Routing Rules
1. **Simple fix**: Main Agent implements directly. Do not spawn subagents for trivial edits, documentation tweaks, or small isolated bug fixes.
2. **Medium task**: At most 1 specialist, when helpful to explore or implement a focused component.
3. **Complex task**: At most 2 subagents in parallel. Hard concurrency limit enforced by configuration (`task.maxConcurrency: 2`).
4. **Plan Mode**: Use Plan Mode only for significant architecture decisions or cross-cutting structural redesigns.
5. **Parallel Write Constraint**: `dllm-analytics-specialist` and `dllm-frontend-specialist` may write in parallel ONLY when API contracts and file ownership are defined in advance and workspaces are isolated.
6. **Parallel Audit**: `dllm-network-auditor` and `dllm-data-integrity-auditor` may audit in parallel for high-risk backend changes or pipeline refactors.
7. **QA Review**: QA review follows integration when regression risk justifies it; do not spawn QA automatically for trivial fixes.
8. **Centralized Ownership**: Main Agent owns integration, test execution, local commit, and final report. Subagents never run test suites or make git commits.
9. **Manual Push Approval**: GitHub push requires explicit user approval. Never auto-push.
10. **Zero Unauthorized External Requests**: No live Fabriq/LP Agent requests or historical scans without explicit authorization.

## Task Dispatch & Isolation
- Write-enabled subagents (`dllm-analytics-specialist`, `dllm-frontend-specialist`) run with task isolation (`task.isolation.enabled: true`).
- The Main Agent reviews isolated modifications prior to integration into the working tree.
- Subagents have nested delegation disabled (`spawns: ""`).
- If isolation or safe patch integration is unavailable, fall back immediately to sequential Main Agent implementation.
