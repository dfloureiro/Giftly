// Two-factor authentication (TOTP + recovery codes), optional or required with REQUIRE_2FA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, Client, loginAdmin, inviteAdmin, ADMIN_PASSWORD } from './helpers.js';
import { hotp, counterAt, verifyTotp, base32Encode, newRecoveryCodes, useRecoveryCode } from '../src/totp.js';
import { qrMatrix } from '../src/qr.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

/** Turn 2FA on for a logged-in client; returns { secret, recovery }. */
async function enable(client) {
  const page = (await client.get('/admin/profile/2fa')).text;
  const secret = /<code class="secret">([A-Z2-7 ]+)<\/code>/.exec(page)[1].replace(/ /g, '');
  assert.match(page, /<svg[^>]*role="img"/, 'QR code shown');
  const wrong = await client.post('/admin/profile/2fa/confirm', { code: '000000' }, { from: '/admin/profile/2fa' });
  assert.equal(wrong.status, 400);
  const ok = await client.post('/admin/profile/2fa/confirm', { code: hotp(secret, counterAt()) }, { from: '/admin/profile/2fa' });
  assert.equal(ok.status, 200);
  const recovery = [...ok.text.matchAll(/<li><code>([a-z0-9]{4}-[a-z0-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(recovery.length, 10);
  return { secret, recovery };
}

/** Password step; returns the client (with the pending 2FA cookie) and the response. */
async function passwordStep(base, username, password) {
  const c = new Client(base);
  const r = await c.request('/login', { method: 'POST', form: { username, password } });
  return { c, r };
}

// The code used when enabling can't be reused, so later logins use the next time step
// (accepted thanks to the ±1 step drift window).
const nextCode = (secret, k = 1) => hotp(secret, counterAt() + k);

test('TOTP and recovery codes: RFC 6238 vectors, drift, replay, one-time recovery', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(hotp(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(key, Math.floor(2000000000 / 30), 8), '69279037');
  const secret = base32Encode(key);
  const c = counterAt();
  assert.equal(verifyTotp(secret, hotp(secret, c)), c);
  assert.equal(verifyTotp(secret, hotp(secret, c - 1)), c - 1, 'one step of drift');
  assert.equal(verifyTotp(secret, hotp(secret, c - 2)), null);
  assert.equal(verifyTotp(secret, hotp(secret, c), { after: c }), null, 'no replay');
  const { codes, hashes } = newRecoveryCodes();
  const left = useRecoveryCode(hashes, codes[3].toUpperCase().replace('-', ' '));
  assert.equal(left.length, 9);
  assert.equal(useRecoveryCode(left, codes[3]), null, 'used up');
});

test('QR encoder picks a version that fits and refuses oversized text', () => {
  assert.equal(qrMatrix('hello').length, 21, 'version 1');
  assert.equal(qrMatrix('x'.repeat(120)).length, 45, 'version 7');
  assert.throws(() => qrMatrix('x'.repeat(300)));
});

test('turning 2FA on: login then needs a code; codes are single-use; recovery codes work once', async () => {
  const admin = await loginAdmin(server.base);
  const user = await inviteAdmin(server.base, admin, { username: 'twofa-user', password: 'twofa-password-1' });
  const { secret, recovery } = await enable(user);
  assert.equal((await user.get('/admin/profile')).status, 200, 'the device that enabled it stays logged in');

  const { c, r } = await passwordStep(server.base, 'twofa-user', 'twofa-password-1');
  assert.equal(r.location, '/login/2fa');
  assert.equal((await c.get('/admin/profile')).status, 303, 'no session before the code');
  assert.equal((await c.request('/login/2fa', { method: 'POST', form: { code: '123456' } })).status, 401);
  const code = nextCode(secret);
  const ok = await c.request('/login/2fa', { method: 'POST', form: { code } });
  assert.equal(ok.status, 303);
  assert.equal((await c.get('/admin/profile')).status, 200);

  const again = await passwordStep(server.base, 'twofa-user', 'twofa-password-1');
  assert.equal((await again.c.request('/login/2fa', { method: 'POST', form: { code } })).status, 401, 'same code twice');

  const viaRecovery = await again.c.request('/login/2fa', { method: 'POST', form: { code: recovery[0] } });
  assert.match(viaRecovery.location, /recoveryUsed&n=9/);
  const third = await passwordStep(server.base, 'twofa-user', 'twofa-password-1');
  assert.equal((await third.c.request('/login/2fa', { method: 'POST', form: { code: recovery[0] } })).status, 401, 'recovery code used up');
});

test('a forged or missing pending cookie gives nothing; the password step alone is not a session', async () => {
  const c = new Client(server.base);
  assert.equal((await c.get('/login/2fa')).status, 303);
  c.jar.set('giftly_2fa', 'eyJ1IjoxfQ.forged');
  assert.equal((await c.request('/login/2fa', { method: 'POST', form: { code: '000000' } })).location, '/login');
});

test('a new-password link does not bypass 2FA', async () => {
  const admin = await loginAdmin(server.base);
  const u = await inviteAdmin(server.base, admin, { username: 'reset-2fa', password: 'reset-pass-1' });
  const { secret } = await enable(u);
  const users = (await admin.get('/admin/users')).text;
  const id = Number(new RegExp('<code>reset-2fa</code></td>[\\s\\S]*?/admin/users/(\\d+)/reset-link').exec(users)[1]);
  const page = await admin.post(`/admin/users/${id}/reset-link`, {}, { from: '/admin/users' });
  const token = /\/reset\/([A-Za-z0-9_-]{16,64})/.exec(page.text)[1];
  const c = new Client(server.base);
  const r = await c.request(`/reset/${token}`, { method: 'POST', form: { password: 'new-reset-pw-1', confirm: 'new-reset-pw-1' } });
  assert.equal(r.location, '/login/2fa', 'asks for the code before logging in');
  assert.equal((await c.get('/admin/profile')).status, 303);
  await c.request('/login/2fa', { method: 'POST', form: { code: nextCode(secret) } });
  assert.equal((await c.get('/admin/profile')).status, 200);
});

test('turning 2FA off needs the password and a code; another admin can turn it off for you', async () => {
  const admin = await loginAdmin(server.base);
  const u = await inviteAdmin(server.base, admin, { username: 'off-2fa', password: 'off-pass-123' });
  const { secret } = await enable(u);
  const bad = await u.post('/admin/profile/2fa/disable', { password: 'wrong-pass', code: nextCode(secret) }, { from: '/admin/profile/2fa' });
  assert.equal(bad.status, 400);
  const good = await u.post('/admin/profile/2fa/disable', { password: 'off-pass-123', code: nextCode(secret) }, { from: '/admin/profile/2fa' });
  assert.match(good.location, /twofaOff/);
  assert.equal((await passwordStep(server.base, 'off-2fa', 'off-pass-123')).r.location, '/admin', 'no code asked any more');

  // On again, then another admin resets it (lost phone): their session ends, login without a code.
  await enable(u);
  const users = (await admin.get('/admin/users')).text;
  const id = Number(new RegExp('<code>off-2fa</code></td>[\\s\\S]*?/admin/users/(\\d+)/2fa/disable').exec(users)[1]);
  await admin.post(`/admin/users/${id}/2fa/disable`, {}, { from: '/admin/users' });
  assert.equal((await u.get('/admin/profile')).status, 303, 'logged out');
  assert.equal((await passwordStep(server.base, 'off-2fa', 'off-pass-123')).r.location, '/admin');
});

test('disable-2fa script', async () => {
  const admin = await loginAdmin(server.base);
  const u = await inviteAdmin(server.base, admin, { username: 'script-2fa', password: 'script-pass-1' });
  await enable(u);
  const run = promisify(execFile);
  const env = { ...process.env, DATA_DIR: server.dataDir };
  const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts/disable-2fa.js'), 'script-2fa'], { env });
  assert.match(stdout, /turned off/);
  assert.equal((await passwordStep(server.base, 'script-2fa', 'script-pass-1')).r.location, '/admin');
});

test('REQUIRE_2FA: admins without 2FA can only set it up, and cannot turn it off', async () => {
  const strict = await startServer({ REQUIRE_2FA: 'true' });
  try {
    const admin = await loginAdmin(strict.base);
    for (const path of ['/admin', '/admin/profile', '/admin/occasions', '/admin/users']) {
      const r = await admin.get(path);
      assert.equal(r.status, 303, path);
      assert.equal(r.location, '/admin/profile/2fa?required=1', path);
    }
    const setup = (await admin.get('/admin/profile/2fa?required=1')).text;
    assert.match(setup, /requires two-factor authentication/);
    const { secret } = await enable(admin);
    assert.equal((await admin.get('/admin/lists')).status, 200, 'full access once enabled');
    const off = await admin.post('/admin/profile/2fa/disable', { password: ADMIN_PASSWORD, code: nextCode(secret) }, { from: '/admin/profile/2fa' });
    assert.equal(off.status, 403);
  } finally {
    await strict.stop();
  }
});
