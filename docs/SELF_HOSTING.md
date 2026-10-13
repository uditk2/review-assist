# Self-hosting the GitHub App

The hosted App at reviewassist.dev stores nothing, but your diff does pass through it on each
pull request event and while a reviewer has the guided review open. If your policy rules that out, run your own copy. It is
the same code, deployed to your Cloudflare account, under your own GitHub App registration.

What you run:

- **One Cloudflare Worker** (`apps/github-app/worker`). It serves the viewer from its asset
  store and handles `/api/*`. No database, no KV, no Durable Objects.
- **Nothing changes on the developer's side.** The MCP server writes `.intent/<branch>.json`
  into the repository. The App reads it from GitHub. Neither is configured with the other's host.

## 1. Register a GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (or the same under an
organization). Use your Worker's host wherever `<host>` appears.

| Field | Value |
|---|---|
| Homepage URL | `https://<host>/` |
| Callback URL | `https://<host>/api/callback` |
| Setup URL (optional) | `https://<host>/installed/` |
| Webhook URL | `https://<host>/api/webhook` |
| Webhook secret | a random string; it becomes `GITHUB_WEBHOOK_SECRET` |

Repository permissions:

- **Checks:** read and write. Posts the Review Assist check.
- **Contents:** read-only. Reads the Intent Document and the diff.
- **Metadata:** read-only. Required by GitHub.
- **Pull requests:** read and write. Posts the summary comment, the PR description block, and the reviewer's comments and verdict.

Subscribe to events: **Pull request**. GitHub sends installation events to every App without
a subscription.

After creating it, collect four values from the App's settings page: the **App ID**, the
**Client ID**, a new **client secret**, and a generated **private key** (`.pem`). The Worker
accepts the key as GitHub issues it (PKCS#1) or as PKCS#8.

## 2. Point the Worker at your host

In `apps/github-app/worker/wrangler.toml`:

- **Routes:** replace the two `reviewassist.dev` entries with your domain. `custom_domain = true`
  needs the zone on Cloudflare. Or delete `routes` and use the `workers.dev` host, which
  `workers_dev = true` already serves.
- **Analytics:** leave `GA_MEASUREMENT_ID` alone or delete it. The Worker reports nothing
  unless `GA_API_SECRET` is set, and the site's own analytics only load on reviewassist.dev.

## 3. Set the secrets

```bash
cd apps/github-app/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < path/to/your-app.private-key.pem
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` derives the key that encrypts the reviewer's session cookie. Rotating it signs
everyone out.

## 4. Build and deploy

```bash
npm install                              # repo root
npm run build -w @review-assist/viewer   # prerenders the site into viewer/dist
cd apps/github-app/worker && npx wrangler deploy
```

Build before every deploy. The Worker serves `viewer/dist`, not the viewer source.

## 5. Install it and check one PR

- Install your App on a test repository from `https://github.com/apps/<your-app-slug>`. The
  site's Install button still links to the hosted App (`APP_INSTALL` in
  `apps/github-app/viewer/index.html`); change it if your team will use your landing page.
- Open a pull request. A **Review Assist** check should appear within seconds. On a branch with no
  document it reads "No Intent Document", which is correct.
- Open `https://<host>/#<owner>/<repo>/pull/<number>` and sign in with GitHub.

If no check appears, open the App's **Advanced → Recent Deliveries**:

- **401:** the webhook secret does not match `GITHUB_WEBHOOK_SECRET`.
- **202 but no check:** the Worker could not mint an installation token. Check `GITHUB_APP_ID`
  and `GITHUB_APP_PRIVATE_KEY`, then read `npx wrangler tail` while you push to the PR.

Links in the PR comment and check point at your host, because the Worker builds them from the
host the webhook arrived on.
