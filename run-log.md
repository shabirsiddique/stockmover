# Stock Mover run log
- 2026-07-29 18:06 — OK | rows: 230 | nelson: 225/230 (97.8%) | images +0 | deploy 6a6a32d0a6c807ef2f35b07c | route: chrome
- 2026-07-29 19:00 — OK | rows: 230 | nelson: 225/230 (97.8%) | images +0 (4 wrong entries corrected) | deploy 6a6a3f724675f947b7f270ca | route: chrome
- 2026-07-30 15:45 — OK | rows: 220 | nelson: 215/220 (97.7%) | images +0 | deploy (id unread, connector timeout; live verified) | route: chrome
- 2026-07-30 18:07 — OK | rows: 213 | nelson: 208/213 (97.7%) | images +9 | deploy 6a6b849f11bcc36eff1748b2 | route: chrome
- 2026-07-31 16:42 — OK | rows: 220 | nelson: 215/220 (97.7%) | images +19 | deploy 6a6cc25e62bf2a00d3442b48 | route: chrome/netlify (manual run; 18:01 scheduled run skipped at user request)
- 2026-07-31 18:55 — HOST MIGRATION | Netlify free plan out of credits (deploys paused until 14 Aug). Cloudflare Pages tried and rejected: uploader drops the filename on programmatic upload, deploys "succeed" but site 404s. Moved to GitHub Pages — shabirsiddique/stockmover, public, main/root → https://shabirsiddique.github.io/stockmover/ | rows: 220 | verified live | Netlify left up frozen as fallback
- 2026-07-31 19:55 — OK | rows: 218 | nelson: 213/218 (97.7%) | images +0 | commit web | route: github-pages
- 2026-08-01 14:35 — FAILED at step 1: Chrome extension not connected (and Control_Chrome lacks macOS automation permission) — no browser route for EposNow exports, deploy or verification. Nothing deployed; live app still on 2026-07-31 build.
- 2026-08-01 15:13 — BUILT, NOT DEPLOYED | rows: 207 | nelson: 203/207 (98.1%) | images +9 | staged at .stockmover-deploy/upload/index.html | blocked at step 7: Chrome extension not connected (manual EposNow exports used) | route: github-pages (pending)
