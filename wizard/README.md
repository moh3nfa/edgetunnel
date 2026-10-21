# edgetunnel Install Wizard

One-page Persian install wizard that deploys **edgetunnel** onto a Cloudflare Worker via the Cloudflare API.

## What it does

1. Reads your Cloudflare API token  
2. Resolves the account (or uses the Account ID you enter)  
3. Creates or reuses a KV namespace and binds it as `KV`  
4. Downloads `_worker.js` from GitHub and uploads it as a Worker  
5. Sets the `ADMIN` secret and enables `*.workers.dev`

## Live URL

`https://edge-install.mfb77952.workers.dev/`

## Local / re-deploy

```bash
# requires CLOUDFLARE_API_TOKEN with Workers + KV edit
npx wrangler deploy -c wizard/wrangler.toml
```

Or upload `wizard/worker.js` with the Workers Script Upload API (module format, `main_module: worker.js`).

## Token permissions needed

- Account → Workers Scripts → Edit  
- Account → Workers KV Storage → Edit  
- Account → Account Settings → Read  

Do not commit API tokens. Rotate any token that was pasted into chat or shared.
