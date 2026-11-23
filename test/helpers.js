// Test helpers: start a real Giftly server on a random port with a temporary data dir,
// and a tiny HTTP client with a cookie jar that behaves like one browser.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'test-password-123';

/** Start a server. Pass `dataDir` to restart on existing data (it is then not deleted on stop). */
export async function startServer(extraEnv = {}, { dataDir: existing } = {}) {
  const dataDir = existing ?? await mkdtemp(join(tmpdir(), 'giftly-test-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
      DATA_DIR: dataDir,
      PORT: '0',
      HOST: '127.0.0.1',
      LINK_PREVIEWS: 'false',
      TRUST_PROXY: 'false',
      NOTIFY_ALLOWED_HOSTS: '127.0.0.1', // the tests' webhook receivers
      APP_LANG: 'en',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk;
      const m = /listening on .*:(\d+) \(/.exec(log);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { log += c; });
    child.on('exit', (code) => reject(new Error(`server exited (${code}):\n${log}`)));
    setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 10_000);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    logs: () => log,
    async stop({ keepData = !!existing } = {}) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      if (!keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  async request(path, { method = 'GET', form } = {}) {
    const headers = { 'accept-language': 'en' };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (/Max-Age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text(), headers: res.headers };
  }

  get(path) { return this.request(path); }

  /** POST a form, adding the CSRF token from `page` (defaults to fetching `from`). */
  async post(path, form = {}, { from, csrf = true } = {}) {
    const data = { ...form };
    if (csrf) data._csrf = await this.csrf(from ?? path);
    return this.request(path, { method: 'POST', form: data });
  }

  async csrf(pagePath) {
    const { text } = await this.get(pagePath);
    return /name="_csrf" value="([^"]+)"/.exec(text)?.[1] ?? '';
  }
}

export async function loginAdmin(base, { username = ADMIN_USERNAME, password = ADMIN_PASSWORD } = {}) {
  const admin = new Client(base);
  const r = await admin.request('/admin/login', { method: 'POST', form: { username, password } });
  if (r.status !== 303) throw new Error(`admin login failed for ${username}: ${r.status}`);
  return admin;
}

/** Create a second admin through an invite link; returns a logged-in client. */
export async function inviteAdmin(base, inviter, { username, name = username, password = 'second-password-1' }) {
  const page = await inviter.post('/admin/users/invite', {}, { from: '/admin/users' });
  const token = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(page.text)?.[1];
  if (!token) throw new Error('no invite link in page');
  const c = new Client(base);
  const r = await c.request(`/invite/${token}`, { method: 'POST', form: { username, name, password, confirm: password } });
  if (r.status !== 303) throw new Error(`invite accept failed: ${r.status}\n${r.text.slice(0, 500)}`);
  return c;
}

/** Create a list (and optional gifts) through the admin; returns { id, token }. */
export async function createList(admin, { title = 'Test list', gifts = [] } = {}) {
  const r = await admin.post('/admin/lists', { title }, { from: '/admin' });
  const id = Number(/\/admin\/lists\/(\d+)/.exec(r.location)?.[1]);
  if (gifts.length) {
    await admin.post(`/admin/lists/${id}/items/bulk`, { lines: gifts.join('\n') }, { from: `/admin/lists/${id}` });
  }
  const page = await admin.get(`/admin/lists/${id}`);
  const token = /\/l\/([A-Za-z0-9_-]{22})/.exec(page.text)?.[1];
  return { id, token };
}

export async function joinList(base, token, name) {
  const guest = new Client(base);
  const r = await guest.request(`/l/${token}/join`, { method: 'POST', form: { name } });
  if (r.status !== 303) throw new Error(`join failed: ${r.status}`);
  return guest;
}

/** Gift ids visible to a guest as pickable, in page order. */
export async function pickableIds(guest, token) {
  const { text } = await guest.get(`/l/${token}`);
  return [...text.matchAll(new RegExp(`/l/${token}/pick/(\\d+)`, 'g'))].map((m) => Number(m[1]));
}

/** Local HTTP server that records JSON webhook calls. */
export async function webhookReceiver() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { calls.push(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
