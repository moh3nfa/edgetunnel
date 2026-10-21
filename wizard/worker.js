/**
 * edgetunnel Install Wizard — Cloudflare Worker UI
 * Deploys edgetunnel to the user's Cloudflare Pages project (not Workers).
 */

const SCRIPT_SOURCES = [
	'https://raw.githubusercontent.com/moh3nfa/edgetunnel/main/_worker.js',
	'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
];

const DEFAULT_COMPAT = '2025-11-04';
const KV_BINDING = 'KV';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return cors(new Response(null, { status: 204 }));
		}

		if (url.pathname === '/api/install' && request.method === 'POST') {
			return cors(await handleInstall(request, env));
		}

		if (url.pathname === '/api/health') {
			return cors(Response.json({ ok: true, service: 'edgetunnel-install-wizard', target: 'pages' }));
		}

		return new Response(WIZARD_HTML, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			},
		});
	},
};

function cors(res) {
	const headers = new Headers(res.headers);
	headers.set('access-control-allow-origin', '*');
	headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
	headers.set('access-control-allow-headers', 'content-type');
	return new Response(res.body, { status: res.status, headers });
}

async function handleInstall(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: 'بدنهٔ درخواست نامعتبر است.' }, { status: 400 });
	}

	const token = String(body.token || '').trim();
	const admin = String(body.admin || '').trim();
	const projectName = sanitizeName(body.workerName || body.projectName || 'panel-warp');
	const key = String(body.key || '').trim();
	let accountId = String(body.accountId || '').trim();

	if (!token) {
		return Response.json({ ok: false, error: 'توکن API کلادفلر لازم است.' }, { status: 400 });
	}
	if (!admin || admin.length < 4) {
		return Response.json({ ok: false, error: 'رمز ادمین حداقل ۴ کاراکتر باشد.' }, { status: 400 });
	}

	const steps = [];
	const log = (id, status, detail) => {
		steps.push({ id, status, detail, at: Date.now() });
	};

	try {
		if (!accountId) {
			const accounts = await cf(token, 'GET', '/accounts');
			if (!accounts.success || !accounts.result?.length) {
				throw new Error('هیچ اکانتی با این توکن پیدا نشد. دسترسی Account را چک کنید.');
			}
			accountId = accounts.result[0].id;
			log('account', 'ok', `اکانت: ${accounts.result[0].name || accountId}`);
		} else {
			log('account', 'ok', `اکانت: ${accountId}`);
		}

		let kvId = null;
		const kvList = await cf(token, 'GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
		const existingKv = (kvList.result || []).find(
			(n) => n.title === 'edgetunnel' || n.title === 'Kv' || n.title === 'KV' || n.title === projectName
		);
		if (existingKv) {
			kvId = existingKv.id;
			log('kv', 'ok', `KV موجود: ${existingKv.title}`);
		} else {
			const created = await cf(token, 'POST', `/accounts/${accountId}/storage/kv/namespaces`, {
				title: `${projectName}-kv`,
			});
			if (!created.success) throw new Error(formatErrors(created) || 'ساخت KV شکست خورد.');
			kvId = created.result.id;
			log('kv', 'ok', 'نام‌اسپیس KV ساخته شد.');
		}

		log('script', 'progress', 'در حال دریافت _worker.js …');
		const script = await fetchEdgeScript(env);
		if (!script || script.length < 1000) {
			throw new Error('دانلود اسکریپت edgetunnel ناموفق بود.');
		}
		log('script', 'ok', `اسکریپت آماده (${Math.round(script.length / 1024)} KB)`);

		const vars = { ADMIN: admin };
		if (key) vars.KEY = key;

		log('deploy', 'progress', `ساخت/دیپلوی Pages: ${projectName}`);
		const { host, reused } = await deployPages(token, accountId, projectName, script, kvId, vars, log);
		log('deploy', 'ok', reused ? `Pages به‌روز شد: ${host}` : `Pages ساخته شد: ${host}`);

		const pagesUrl = host.startsWith('http') ? host : `https://${host}`;
		const adminUrl = `${pagesUrl.replace(/\/$/, '')}/admin`;

		return Response.json({
			ok: true,
			accountId,
			projectName,
			kvId,
			pagesUrl,
			workerUrl: pagesUrl,
			adminUrl,
			target: 'pages',
			steps,
		});
	} catch (err) {
		log('error', 'fail', String(err.message || err));
		return Response.json({ ok: false, error: String(err.message || err), steps }, { status: 500 });
	}
}

function sanitizeName(name) {
	return String(name)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 58) || 'panel-warp';
}

async function fetchEdgeScript(env) {
	if (env?.EDGE_SCRIPT_URL) {
		const r = await fetch(env.EDGE_SCRIPT_URL);
		if (r.ok) return await r.text();
	}
	for (const src of SCRIPT_SOURCES) {
		try {
			const r = await fetch(src, {
				headers: { 'user-agent': 'edgetunnel-install-wizard' },
				cf: { cacheTtl: 60 },
			});
			if (r.ok) {
				const text = await r.text();
				if (text.includes('export default') || text.includes('fetch(request')) {
					return text;
				}
			}
		} catch {
			/* try next */
		}
	}
	return null;
}

async function deployPages(token, accountId, name, code, kvId, vars, log) {
	const envVars = Object.fromEntries(
		Object.entries(vars).map(([k, v]) => [k, { type: 'plain_text', value: v }])
	);
	const kvBinding = { [KV_BINDING]: { namespace_id: kvId } };
	const deploymentConfigs = {
		production: {
			env_vars: envVars,
			kv_namespaces: kvBinding,
			compatibility_date: DEFAULT_COMPAT,
		},
		preview: {
			env_vars: envVars,
			kv_namespaces: kvBinding,
			compatibility_date: DEFAULT_COMPAT,
		},
	};

	let project = null;
	let reused = false;
	try {
		project = await cf(token, 'POST', `/accounts/${accountId}/pages/projects`, {
			name,
			production_branch: 'main',
			deployment_configs: deploymentConfigs,
		});
		if (!project.success) throw new Error(formatErrors(project) || 'ساخت پروژه Pages شکست خورد.');
		project = project.result;
		log('project', 'ok', `پروژه Pages ساخته شد: ${project.subdomain || name}`);
	} catch (e) {
		const existing = await cf(token, 'GET', `/accounts/${accountId}/pages/projects/${name}`).catch(() => null);
		if (!existing?.success) throw e;
		reused = true;
		project = existing.result;
		log('project', 'ok', `پروژه موجود: ${project.subdomain || name}`);
		await cf(token, 'PATCH', `/accounts/${accountId}/pages/projects/${name}`, {
			deployment_configs: deploymentConfigs,
		});
		log('bindings', 'ok', 'ADMIN و KV روی Pages تنظیم شد.');
	}

	const form = new FormData();
	form.append('manifest', '{}');
	form.append('branch', 'main');
	form.append('_worker.js', new Blob([code], { type: 'application/javascript' }), '_worker.js');

	const deployRes = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${name}/deployments`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		}
	);
	const deployJson = await deployRes.json().catch(() => ({ success: false }));
	if (!deployJson.success) {
		throw new Error(formatErrors(deployJson) || `دیپلوی Pages شکست خورد (HTTP ${deployRes.status}).`);
	}
	log('upload', 'ok', 'باندل _worker.js روی Pages آپلود شد.');

	return { host: project.subdomain || `${name}.pages.dev`, reused };
}

async function cf(token, method, path, jsonBody) {
	const init = {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
	};
	if (jsonBody !== undefined) init.body = JSON.stringify(jsonBody);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, init);
	const data = await res.json().catch(() => ({ success: false, errors: [{ message: res.statusText }] }));
	if (!res.ok && data.success === false) {
		const msg = formatErrors(data) || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	return data;
}

function formatErrors(data) {
	if (!data?.errors?.length) return '';
	return data.errors.map((e) => e.message || JSON.stringify(e)).join(' · ');
}

const WIZARD_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>edgetunnel — ویزارد نصب (Pages)</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
<style>
:root {
  --ink: #071018;
  --panel: rgba(10, 22, 34, 0.72);
  --line: rgba(120, 190, 210, 0.18);
  --text: #e7f2f6;
  --muted: #8aa3b0;
  --mint: #5eead4;
  --mint-dim: #2dd4bf;
  --warn: #fbbf24;
  --fail: #fb7185;
  --ok: #4ade80;
  --glow: rgba(45, 212, 191, 0.35);
  --radius: 18px;
  --font: "Vazirmatn", system-ui, sans-serif;
  --display: "Syne", "Vazirmatn", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { min-height: 100%; }
body {
  font-family: var(--font);
  color: var(--text);
  background: var(--ink);
  overflow-x: hidden;
}
.sky {
  position: fixed; inset: 0; z-index: -2;
  background:
    radial-gradient(1200px 700px at 85% -10%, rgba(45, 212, 191, 0.22), transparent 55%),
    radial-gradient(900px 600px at -10% 40%, rgba(14, 116, 144, 0.28), transparent 50%),
    radial-gradient(700px 500px at 50% 110%, rgba(15, 70, 90, 0.45), transparent 45%),
    linear-gradient(165deg, #04080d 0%, #0a1620 45%, #071018 100%);
}
.mesh {
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    linear-gradient(rgba(94, 234, 212, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(94, 234, 212, 0.04) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse at 50% 30%, black 20%, transparent 75%);
  animation: drift 28s linear infinite;
}
@keyframes drift {
  from { background-position: 0 0, 0 0; }
  to { background-position: 56px 28px, -56px 28px; }
}
.orb {
  position: fixed; width: 42vw; max-width: 520px; aspect-ratio: 1;
  border-radius: 50%; filter: blur(60px); opacity: 0.35; z-index: -1;
  background: radial-gradient(circle, var(--mint-dim), transparent 70%);
  top: -8%; left: -8%;
  animation: float 12s ease-in-out infinite;
}
@keyframes float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(8%, 12%) scale(1.08); }
}
.wrap { width: min(920px, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 4rem; }
.hero {
  min-height: min(88vh, 760px);
  display: grid; align-content: center; gap: 1.25rem; padding: 1rem 0 2.5rem;
}
.brand {
  font-family: var(--display); font-weight: 800;
  font-size: clamp(2.6rem, 9vw, 4.6rem); letter-spacing: -0.04em; line-height: 0.95;
  background: linear-gradient(120deg, #fff 20%, var(--mint) 90%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: rise 0.9s cubic-bezier(.2,.8,.2,1) both;
}
.hero h1 {
  font-size: clamp(1.15rem, 3.2vw, 1.55rem); font-weight: 600;
  max-width: 24ch; line-height: 1.45;
  animation: rise 0.9s 0.08s cubic-bezier(.2,.8,.2,1) both;
}
.hero p.lead {
  color: var(--muted); font-size: 1.02rem; max-width: 40ch; line-height: 1.7;
  animation: rise 0.9s 0.16s cubic-bezier(.2,.8,.2,1) both;
}
@keyframes rise {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: none; }
}
.cta-row {
  display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem;
  animation: rise 0.9s 0.24s cubic-bezier(.2,.8,.2,1) both;
}
.btn {
  appearance: none; border: 0; cursor: pointer;
  font-family: inherit; font-weight: 600; font-size: 0.98rem;
  padding: 0.85rem 1.35rem; border-radius: 999px;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.btn:active { transform: translateY(1px) scale(0.99); }
.btn-primary {
  background: var(--mint); color: #04201a;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 12px 40px var(--glow);
}
.btn-primary:hover { background: #7ff5e0; }
.btn-ghost {
  background: transparent; color: var(--text);
  box-shadow: inset 0 0 0 1px var(--line);
}
.btn-ghost:hover { background: rgba(255,255,255,0.04); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); backdrop-filter: blur(18px);
  padding: clamp(1.25rem, 3vw, 1.85rem); margin-top: 0.5rem;
}
.steps-rail { display: flex; gap: 0.45rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.rail-dot {
  height: 4px; flex: 1; min-width: 40px; border-radius: 99px;
  background: rgba(255,255,255,0.08);
  transition: background .35s ease, box-shadow .35s ease;
}
.rail-dot.on { background: var(--mint); box-shadow: 0 0 16px var(--glow); }
.rail-dot.done { background: var(--mint-dim); }
.step { display: none; animation: rise 0.45s ease both; }
.step.active { display: block; }
.step h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.4rem; }
.step .hint { color: var(--muted); font-size: 0.92rem; line-height: 1.65; margin-bottom: 1.25rem; }
label { display: block; font-size: 0.82rem; color: var(--muted); margin: 0.85rem 0 0.35rem; }
input {
  width: 100%; background: rgba(0,0,0,0.35); border: 1px solid var(--line);
  color: var(--text); border-radius: 12px; padding: 0.8rem 0.95rem;
  font: inherit; font-size: 0.95rem; outline: none;
  transition: border-color .2s ease, box-shadow .2s ease;
}
input:focus {
  border-color: rgba(94, 234, 212, 0.55);
  box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.15);
}
.row-actions {
  display: flex; flex-wrap: wrap; gap: 0.65rem;
  margin-top: 1.4rem; justify-content: space-between;
}
.row-actions > div { display: flex; gap: 0.55rem; flex-wrap: wrap; }
.log { margin-top: 1rem; font-size: 0.86rem; display: grid; gap: 0.45rem; }
.log-item {
  display: flex; gap: 0.6rem; align-items: flex-start;
  padding: 0.55rem 0.7rem; border-radius: 10px;
  background: rgba(0,0,0,0.28); border: 1px solid transparent;
}
.log-item .tag {
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em;
  padding: 0.15rem 0.45rem; border-radius: 6px; flex-shrink: 0;
}
.tag.ok { background: rgba(74,222,128,.15); color: var(--ok); }
.tag.fail { background: rgba(251,113,133,.15); color: var(--fail); }
.tag.warn { background: rgba(251,191,36,.15); color: var(--warn); }
.tag.progress { background: rgba(94,234,212,.12); color: var(--mint); }
.success-box { text-align: center; padding: 0.5rem 0 0.25rem; }
.success-box .big {
  font-family: var(--display); font-size: clamp(1.6rem, 4vw, 2.2rem);
  font-weight: 800; margin: 0.4rem 0 0.75rem;
}
.links { display: grid; gap: 0.65rem; margin: 1.25rem 0 0.5rem; text-align: right; }
.links a {
  color: var(--mint); text-decoration: none; word-break: break-all;
  padding: 0.75rem 0.9rem; border-radius: 12px;
  background: rgba(0,0,0,0.3); border: 1px solid var(--line); display: block;
}
.links a:hover { border-color: rgba(94,234,212,0.45); }
.copy-note { color: var(--muted); font-size: 0.85rem; margin-top: 0.75rem; }
.footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; text-align: center; }
.spinner {
  width: 1.05rem; height: 1.05rem; border-radius: 50%;
  border: 2px solid rgba(4,32,26,0.25); border-top-color: #04201a;
  display: inline-block; vertical-align: -2px; margin-left: 0.4rem;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) {
  .wrap { width: calc(100% - 1.25rem); padding-top: 1.5rem; }
  .row-actions { flex-direction: column-reverse; align-items: stretch; }
  .row-actions > div { width: 100%; }
  .btn { width: 100%; text-align: center; }
}
</style>
</head>
<body>
<div class="sky"></div>
<div class="mesh"></div>
<div class="orb" aria-hidden="true"></div>

<main class="wrap">
  <section class="hero" id="hero">
    <div class="brand">edgetunnel</div>
    <h1>نصب روی Cloudflare Pages در چند قدم</h1>
    <p class="lead">ویزارد یک‌مسیره برای کاربران ایران: توکن API، رمز ادمین، دیپلوی روی <b dir="ltr">Pages</b>. پنل فارسی است؛ لینک تلگرام به‌خاطر فیلترینگ استفاده نمی‌شود.</p>
    <div class="cta-row">
      <button type="button" class="btn btn-primary" id="startBtn">شروع نصب</button>
      <a class="btn btn-ghost" href="https://panel-warp.pages.dev/login" target="_blank" rel="noopener">نمونهٔ زنده</a>
    </div>
  </section>

  <section class="panel" id="wizard" hidden>
    <div class="steps-rail" aria-hidden="true">
      <div class="rail-dot on" data-rail="0"></div>
      <div class="rail-dot" data-rail="1"></div>
      <div class="rail-dot" data-rail="2"></div>
      <div class="rail-dot" data-rail="3"></div>
    </div>

    <div class="step active" data-step="0">
      <h2>۱ · آماده‌سازی توکن</h2>
      <p class="hint">API Token با دسترسی Cloudflare Pages (Edit)، Workers KV Storage (Edit) و Account Settings (Read).</p>
      <label for="token">Cloudflare API Token</label>
      <input id="token" type="password" autocomplete="off" placeholder="cfat_…" dir="ltr" />
      <label for="accountId">Account ID <span style="opacity:.7">(اختیاری)</span></label>
      <input id="accountId" type="text" autocomplete="off" placeholder="مثلاً 9fdd…" dir="ltr" />
      <div class="row-actions">
        <button type="button" class="btn btn-ghost" data-back>قبلی</button>
        <div><button type="button" class="btn btn-primary" data-next>ادامه</button></div>
      </div>
    </div>

    <div class="step" data-step="1">
      <h2>۲ · تنظیمات Pages</h2>
      <p class="hint">نام پروژهٔ Pages و رمز ورود پنل. روی حساب Cloudflare شما به‌صورت Pages دیپلوی می‌شود.</p>
      <label for="workerName">نام پروژهٔ Pages</label>
      <input id="workerName" type="text" value="panel-warp" dir="ltr" />
      <label for="admin">رمز ADMIN (ورود به /admin)</label>
      <input id="admin" type="password" autocomplete="new-password" placeholder="حداقل ۴ کاراکتر" />
      <label for="key">کلید سریع اشتراک KEY <span style="opacity:.7">(اختیاری)</span></label>
      <input id="key" type="text" autocomplete="off" placeholder="مثلاً mySecret" dir="ltr" />
      <div class="row-actions">
        <button type="button" class="btn btn-ghost" data-back>قبلی</button>
        <div><button type="button" class="btn btn-primary" data-next>ادامه</button></div>
      </div>
    </div>

    <div class="step" data-step="2">
      <h2>۳ · دیپلوی Pages</h2>
      <p class="hint">ویزارد پروژهٔ Pages می‌سازد (یا به‌روز می‌کند)، KV را بایند می‌کند، <b dir="ltr">ADMIN</b> را ست می‌کند و <b dir="ltr">_worker.js</b> را آپلود می‌کند.</p>
      <ul class="hint" style="padding-inline-start:1.1rem; margin-bottom:1rem;">
        <li>هدف: <b dir="ltr">*.pages.dev</b> (نه workers.dev)</li>
        <li>بایندینگ <b dir="ltr">KV</b> + متغیر <b dir="ltr">ADMIN</b></li>
        <li>پنل فارسی پیش‌فرض در <b dir="ltr">/login</b> و <b dir="ltr">/admin</b></li>
      </ul>
      <div class="row-actions">
        <button type="button" class="btn btn-ghost" data-back id="backBeforeDeploy">قبلی</button>
        <div><button type="button" class="btn btn-primary" id="deployBtn">نصب روی Pages</button></div>
      </div>
      <div class="log" id="log" hidden></div>
    </div>

    <div class="step" data-step="3">
      <div class="success-box">
        <p class="hint" style="margin:0">نصب Pages کامل شد</p>
        <div class="big">آمادهٔ استفاده</div>
        <p class="hint" id="doneSummary"></p>
        <div class="links" id="doneLinks"></div>
        <p class="copy-note">با رمز ADMIN وارد شوید. زبان پیش‌فرض پنل فارسی است؛ از دکمهٔ EN | فارسی می‌توانید عوض کنید.</p>
      </div>
      <div class="row-actions" style="justify-content:center">
        <button type="button" class="btn btn-ghost" id="againBtn">نصب دوباره</button>
      </div>
    </div>
  </section>

  <p class="footer">ویزارد نصب edgetunnel · هدف دیپلوی: Cloudflare Pages</p>
</main>

<script>
(() => {
  const hero = document.getElementById('hero');
  const wizard = document.getElementById('wizard');
  const startBtn = document.getElementById('startBtn');
  const steps = [...document.querySelectorAll('.step')];
  const rails = [...document.querySelectorAll('.rail-dot')];
  let i = 0;

  function show(n) {
    i = Math.max(0, Math.min(n, steps.length - 1));
    steps.forEach((el, idx) => el.classList.toggle('active', idx === i));
    rails.forEach((el, idx) => {
      el.classList.toggle('on', idx === i);
      el.classList.toggle('done', idx < i);
    });
    wizard.hidden = false;
    if (n >= 0) hero.style.display = 'none';
    wizard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  startBtn.addEventListener('click', () => show(0));
  document.querySelectorAll('[data-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (i === 0 && !document.getElementById('token').value.trim()) return shake(document.getElementById('token'));
      if (i === 1) {
        if (!document.getElementById('workerName').value.trim()) return shake(document.getElementById('workerName'));
        if (document.getElementById('admin').value.trim().length < 4) return shake(document.getElementById('admin'));
      }
      show(i + 1);
    });
  });
  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (i === 0) { wizard.hidden = true; hero.style.display = ''; return; }
      show(i - 1);
    });
  });
  document.getElementById('againBtn').addEventListener('click', () => show(0));

  function shake(el) {
    el.focus();
    el.style.borderColor = 'var(--fail)';
    setTimeout(() => { el.style.borderColor = ''; }, 900);
  }

  const deployBtn = document.getElementById('deployBtn');
  const logEl = document.getElementById('log');
  deployBtn.addEventListener('click', async () => {
    deployBtn.disabled = true;
    document.getElementById('backBeforeDeploy').disabled = true;
    deployBtn.innerHTML = 'در حال نصب روی Pages<span class="spinner"></span>';
    logEl.hidden = false;
    logEl.innerHTML = '<div class="log-item"><span class="tag progress">…</span><span>شروع دیپلوی Pages</span></div>';

    const payload = {
      token: document.getElementById('token').value.trim(),
      accountId: document.getElementById('accountId').value.trim(),
      workerName: document.getElementById('workerName').value.trim(),
      admin: document.getElementById('admin').value.trim(),
      key: document.getElementById('key').value.trim(),
    };

    try {
      const res = await fetch('/api/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      renderSteps(data.steps || []);
      if (!data.ok) throw new Error(data.error || 'نصب ناموفق');

      const url = data.pagesUrl || data.workerUrl;
      document.getElementById('doneSummary').textContent =
        'پروژهٔ Pages «' + (data.projectName || '') + '» آماده است.';
      document.getElementById('doneLinks').innerHTML =
        '<a href="' + url + '" target="_blank" rel="noopener">Pages → ' + url + '</a>' +
        '<a href="' + data.adminUrl + '" target="_blank" rel="noopener">پنل ادمین → ' + data.adminUrl + '</a>' +
        '<a href="' + url.replace(/\\/$/, '') + '/login" target="_blank" rel="noopener">صفحه ورود → ' + url.replace(/\\/$/, '') + '/login</a>';
      show(3);
    } catch (err) {
      logEl.insertAdjacentHTML('beforeend',
        '<div class="log-item"><span class="tag fail">ERR</span><span>' + escapeHtml(String(err.message || err)) + '</span></div>');
    } finally {
      deployBtn.disabled = false;
      document.getElementById('backBeforeDeploy').disabled = false;
      deployBtn.textContent = 'نصب روی Pages';
    }
  });

  function renderSteps(stepsArr) {
    logEl.innerHTML = stepsArr.map((s) => {
      const t = s.status === 'ok' ? 'ok' : s.status === 'fail' ? 'fail' : s.status === 'warn' ? 'warn' : 'progress';
      return '<div class="log-item"><span class="tag ' + t + '">' + t.toUpperCase() + '</span><span>' +
        escapeHtml(s.detail || s.id) + '</span></div>';
    }).join('');
  }
  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
</script>
</body>
</html>`;
