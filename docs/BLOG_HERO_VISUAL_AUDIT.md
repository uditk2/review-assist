# Blog hero visual audit

29 October 2026. All 28 published Review Assist articles were checked against their title, opening example, diff, review question, and merge decision. The existing heroes were either unlabeled sketches or illustrative scenes. They did not let a reader see the specific failure mode before opening the article. Each hero now uses a labeled diagram tied to that article's example. The article alt text was updated with the diagram.

| Article | Review point now visible in the hero |
| --- | --- |
| One `.reviewer/` question for a status change | A new `paused` state prompts an export access question across the API and worker. |
| Shipping quote adapter | A missing quote and a valid free quote both becoming zero is the dangerous translation. |
| DRY refactor | Combining owned and shared document queries loses the share grant filter. |
| Single responsibility | An order commits, receipt delivery fails, and the API reports failure. |
| Inventory reservation | Two buyers race for one unit; only one reservation should succeed. |
| Dead letter queue worker | Retry, acknowledgment, and dead letter handoff have separate outcomes. |
| Cache invalidation | An in-flight old cache fill can finish after deletion and restore stale data. |
| Cursor pagination | Equal timestamps require an ID tie-breaker to avoid a skipped row. |
| API rate limiter | Independent instance counters can admit more than a shared account quota. |
| Webhook signature verification | Raw body verification precedes side effects; redelivery is a separate check. |
| Payment idempotency key | Concurrent retries produce one charge; a changed payload is rejected. |
| Request logging | An allowlist admits safe fields and blocks a token. |
| API response change | An old client still expects `total_cents` after the new response provides `total`. |
| Feature flag rollout | Off, on, and unavailable flag states must preserve displayed price equals charged price. |
| npm audit fix PR | Advisory, installed path, lockfile diff, and consumer test form the evidence chain. |
| Database migration | Nullable rows need a backfill before a not null constraint is enforced. |
| Guidelines in `.reviewer/` | A repository rule reaches one changed hunk and asks the author for evidence. |
| Authorization change | Removed project membership must turn an allow decision into a denial. |
| Re-review after a push | Evidence for one PR head needs checking again after a new push. |
| Scope drift | An extra behavior change lies outside the user request. |
| Untested path | A changed path has a tested branch and an unverified branch requiring a merge call. |
| Green Review Assist check | Explanation coverage and code correctness are separate review questions. |
| Code and transcript flow | Raw sessions stay local while the intent document and PR diff follow distinct paths. |
| Repository review questions | A useful rule names a change trigger, one question, and a test. |
| Unverified assumption comment | A comment connects the assumption, affected hunk, and needed evidence. |
| Unexplained changes | Three hunks are explained while a fourth lacks review context. |
| Conversation spine | Selected session turns support an author answer to a cold reviewer. |
| Review Assist architecture | A cold reviewer question leads to an intent document, validation, or code fix. |

Each visual uses the site palette and short technical labels. Labels describe the article's hypothetical example, not Review Assist implementation, except on the articles that explain Review Assist itself. The images carry no standalone product claims; the article text supplies the conditions, tradeoffs, and final review decision.
