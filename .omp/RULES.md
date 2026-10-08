# Project Rules

1. Never modify `scripts/pool-scanner-v1.mjs` unless user explicitly authorizes a confirmed bug fix.
2. Never commit runtime `data/**`, logs, credentials, sessions, API keys, or environment secrets.
3. Never fabricate financial metrics or silently convert missing data to zero.
4. Preserve pool-local vs wallet-global separation.
5. No Helius, Alchemy, or Solana RPC dependency for historical screening.
6. Reuse existing implementations first.
7. Avoid unrelated refactoring and new abstractions.
8. Read only files relevant to the assigned task.
9. For small tasks, implement directly; do not produce repeated planning.
10. Run targeted tests for small modifications; run broader regression only when required.
11. Never run expensive full historical scans unless explicitly requested.
12. Do not overwrite valid canonical datasets or successful analysis snapshots on failure.
13. Do not bypass authentication or rate limits.
14. Stop once the requested scope is completed.
15. Never force push or amend commits.
16. Report blockers honestly; do not claim unperformed live tests passed.
