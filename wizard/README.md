# edgetunnel Install Wizard (Pages)

One-page Persian install wizard. It deploys **edgetunnel onto Cloudflare Pages** (not Workers) via the Cloudflare API.

## What it does

1. Reads your Cloudflare API token  
2. Resolves the account  
3. Creates or reuses a KV namespace and binds it as `KV` on Pages  
4. Creates or updates a Pages project with `ADMIN` (and optional `KEY`)  
5. Uploads `_worker.js` as a Pages Functions worker bundle  
6. Returns `https://<project>.pages.dev` and `/admin`

## Live URLs

- Wizard UI: https://edge-setup.pages.dev/  
- Example Pages install: https://edge-fa.pages.dev/login  

## Token permissions

- Account → Cloudflare Pages → Edit  
- Account → Workers KV Storage → Edit  
- Account → Account Settings → Read  

Do not commit API tokens. Rotate any token pasted into chat.
