// Accounts: bootstrap, login/sessions, invites, password changes/resets, scripts,
// and per-user notifications.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startServer, Client, loginAdmin, inviteAdmin, createList, joinList, pickableIds,
  webhookReceiver, sleep, ADMIN_PASSWORD,
} from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

const loginStatus = async (base, username, password) =>
  (await new Client(base).request('/login', { method: 'POST', form: { username, password } })).status;

/** The id of a user, from the admin users page. */
const userIdOf = (page, username) => Number(new RegExp(
  `<code>${username}</code></td>[\\s\\S]*?/admin/users/(\\d+)/reset-link`).exec(page)[1]);

const waitFor = async (fn) => { for (let i = 0; i < 30 && !fn(); i++) await sleep(100); };

test('the first account is created from ADMIN_USERNAME/ADMIN_PASSWORD', async () => {
  assert.equal(await loginStatus(server.base, 'admin', ADMIN_PASSWORD), 303);
  assert.equal(await loginStatus(server.base, 'ADMIN', ADMIN_PASSWORD), 303, 'usernames are case-insensitive');
});

test('wrong password and unknown user fail the same way', async () => {
  const wrong = await new Client(server.base).request('/login', { method: 'POST', form: { username: 'admin', password: 'nope-nope' } });
  const unknown = await new Client(server.base).request('/login', { method: 'POST', form: { username: 'ghost', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.match(wrong.text, /Wrong username or password/);
  assert.match(unknown.text, /Wrong username or password/);
});

test('a forged session cookie is not accepted; logout ends the session on the server', async () => {
  const forged = new Client(server.base);
  forged.jar.set('giftly_session', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal((await forged.get('/admin/profile')).status, 303);

  const admin = await loginAdmin(server.base);
  const stolen = admin.jar.get('giftly_session');
  await admin.post('/admin/logout', {}, { from: '/admin/lists' });
  const replay = new Client(server.base);
  replay.jar.set('giftly_session', stolen);
  assert.equal((await replay.get('/admin/profile')).status, 303, 'old cookie no longer works');
});

test('invite: link shown once, creates an account, cannot be reused or used after revoking', async () => {
  const admin = await loginAdmin(server.base);
  const maria = await inviteAdmin(server.base, admin, { username: 'Maria.Ana', name: 'Maria Ana' });
  const profile = (await maria.get('/admin/profile')).text;
  assert.match(profile, /value="maria.ana"/, 'username stored in lowercase');
  assert.equal(await loginStatus(server.base, 'maria.ana', 'second-password-1'), 303);

  // The page listing users never shows invite tokens again.
  const page = await admin.post('/admin/users/invite', {}, { from: '/admin/users' });
  const token = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(page.text)[1];
  assert.ok(!(await admin.get('/admin/users')).text.includes(token));

  const accept = (t, username) => new Client(server.base).request(`/invite/${t}`, {
    method: 'POST', form: { username, name: username, password: 'pass-word-123', confirm: 'pass-word-123' },
  });
  assert.equal((await accept(token, 'first')).status, 303);
  assert.equal((await accept(token, 'second')).status, 404, 'invite used only once');

  const page2 = await admin.post('/admin/users/invite', {}, { from: '/admin/users' });
  const token2 = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(page2.text)[1];
  const id = Number(/\/admin\/users\/invites\/(\d+)\/revoke/.exec((await admin.get('/admin/users')).text)[1]);
  await admin.post(`/admin/users/invites/${id}/revoke`, {}, { from: '/admin/users' });
  assert.equal((await new Client(server.base).get(`/invite/${token2}`)).status, 404);
});

test('invite form validates username and password', async () => {
  const admin = await loginAdmin(server.base);
  const page = await admin.post('/admin/users/invite', {}, { from: '/admin/users' });
  const token = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(page.text)[1];
  const tryAccept = (form) => new Client(server.base).request(`/invite/${token}`, { method: 'POST', form });
  assert.equal((await tryAccept({ username: 'x', name: 'X', password: 'long-enough-1', confirm: 'long-enough-1' })).status, 400);
  assert.equal((await tryAccept({ username: 'admin', name: 'A', password: 'long-enough-1', confirm: 'long-enough-1' })).status, 400, 'taken');
  assert.equal((await tryAccept({ username: 'okname', name: 'A', password: 'short', confirm: 'short' })).status, 400);
  assert.equal((await tryAccept({ username: 'okname', name: 'A', password: 'long-enough-1', confirm: 'different-1' })).status, 400);
  assert.equal((await tryAccept({ username: 'okname', name: 'A', password: 'long-enough-1', confirm: 'long-enough-1' })).status, 303);
});

test('changing your password needs the current one and logs out your other devices', async () => {
  const admin = await loginAdmin(server.base);
  const user = await inviteAdmin(server.base, admin, { username: 'changer', password: 'old-password-1' });
  const otherDevice = await loginAdmin(server.base, { username: 'changer', password: 'old-password-1' });

  const wrong = await user.post('/admin/profile/password', { current: 'nope', password: 'new-password-1', confirm: 'new-password-1' }, { from: '/admin/profile' });
  assert.equal(wrong.status, 400);
  const ok = await user.post('/admin/profile/password', { current: 'old-password-1', password: 'new-password-1', confirm: 'new-password-1' }, { from: '/admin/profile' });
  assert.match(ok.location, /passwordChanged/);

  assert.equal((await user.get('/admin/profile')).status, 200, 'this device stays logged in');
  assert.equal((await otherDevice.get('/admin/profile')).status, 303, 'other device logged out');
  assert.equal(await loginStatus(server.base, 'changer', 'old-password-1'), 401);
  assert.equal(await loginStatus(server.base, 'changer', 'new-password-1'), 303);
});

test('another admin can create a password-reset link; it logs the user out everywhere', async () => {
  const admin = await loginAdmin(server.base);
  await inviteAdmin(server.base, admin, { username: 'forgetful', password: 'forgotten-pw-1' });
  const stillLoggedIn = await loginAdmin(server.base, { username: 'forgetful', password: 'forgotten-pw-1' });
  const id = userIdOf((await admin.get('/admin/users')).text, 'forgetful');
  const page = await admin.post(`/admin/users/${id}/reset-link`, {}, { from: '/admin/users' });
  const token = /\/reset\/([A-Za-z0-9_-]{16,64})/.exec(page.text)[1];

  // An invite page does not accept reset tokens and vice versa.
  assert.equal((await new Client(server.base).get(`/invite/${token}`)).status, 404);

  const c = new Client(server.base);
  const r = await c.request(`/reset/${token}`, { method: 'POST', form: { password: 'brand-new-pw-1', confirm: 'brand-new-pw-1' } });
  assert.equal(r.status, 303);
  assert.equal((await c.get('/admin/profile')).status, 200, 'logged in after reset');
  assert.equal((await stillLoggedIn.get('/admin/profile')).status, 303, 'old sessions ended');
  assert.equal(await loginStatus(server.base, 'forgetful', 'forgotten-pw-1'), 401);
  assert.equal((await new Client(server.base).request(`/reset/${token}`, { method: 'POST', form: { password: 'again-again-1', confirm: 'again-again-1' } })).status, 404);
});

test('admins can remove other admins but not themselves', async () => {
  const admin = await loginAdmin(server.base);
  const temp = await inviteAdmin(server.base, admin, { username: 'temporary' });
  const ids = [...(await admin.get('/admin/users')).text.matchAll(/\/admin\/users\/(\d+)\/delete/g)].map((m) => Number(m[1]));
  assert.ok(ids.length > 0);
  const self = await admin.post('/admin/users/1/delete', {}, { from: '/admin/users' });
  assert.equal(self.status, 400);
  const tempId = userIdOf((await admin.get('/admin/users')).text, 'temporary');
  await admin.post(`/admin/users/${tempId}/delete`, {}, { from: '/admin/users' });
  assert.equal((await temp.get('/admin/profile')).status, 303, 'removed user is logged out');
  assert.equal(await loginStatus(server.base, 'temporary', 'second-password-1'), 401);
});

test('each admin gets notifications on their own channels, for the events they chose', async () => {
  const hookA = await webhookReceiver();
  const hookB = await webhookReceiver();
  try {
    const admin = await loginAdmin(server.base);
    const bea = await inviteAdmin(server.base, admin, { username: 'bea' });
    await admin.post('/admin/notifications', { webhook_url: hookA.url, event_pick: '1' }, { from: '/admin/profile' });
    await bea.post('/admin/notifications', { webhook_url: hookB.url, event_pick: '1', event_unpick: '1' }, { from: '/admin/profile' });

    const { token } = await createList(admin, { title: 'Shared list', gifts: ['Robot vacuum'] });
    const guest = await joinList(server.base, token, 'Ana');
    const [gift] = await pickableIds(guest, token);
    await guest.post(`/l/${token}/pick/${gift}`, {}, { from: `/l/${token}` });
    await waitFor(() => hookA.calls.length && hookB.calls.length);
    assert.equal(hookA.calls.length, 1);
    assert.equal(hookB.calls.length, 1);
    assert.equal(hookA.calls[0].guest, 'Ana');
    assert.match(hookB.calls[0].message, /Robot vacuum/);

    await guest.post(`/l/${token}/unpick/${gift}`, {}, { from: `/l/${token}` });
    await waitFor(() => hookB.calls.length > 1);
    assert.equal(hookB.calls.length, 2, 'bea wanted unpick');
    assert.equal(hookA.calls.length, 1, 'admin did not');

    // The test button only notifies whoever pressed it.
    await bea.post('/admin/notifications/test', {}, { from: '/admin/profile' });
    await waitFor(() => hookB.calls.length > 2);
    assert.equal(hookB.calls.at(-1).event, 'test');
    assert.equal(hookA.calls.length, 1);
  } finally {
    await hookA.close();
    await hookB.close();
    const admin = await loginAdmin(server.base);
    await admin.post('/admin/notifications', { event_pick: '1' }, { from: '/admin/profile' });
  }
});

test('reset-password and invite scripts print working links', async () => {
  const env = { ...process.env, DATA_DIR: server.dataDir, BASE_URL: server.base };
  const node = [process.execPath, '--disable-warning=ExperimentalWarning'];
  const { stdout } = await run(node[0], [node[1], join(ROOT, 'scripts/reset-password.js'), 'admin'], { env });
  const resetUrl = stdout.trim().split('\n').at(-1);
  assert.match(resetUrl, /\/reset\/[A-Za-z0-9_-]{16,64}$/);
  assert.equal((await new Client(server.base).get(new URL(resetUrl).pathname)).status, 200);

  const inv = await run(node[0], [node[1], join(ROOT, 'scripts/invite.js')], { env });
  assert.equal((await new Client(server.base).get(new URL(inv.stdout.trim().split('\n').at(-1)).pathname)).status, 200);

  await assert.rejects(run(node[0], [node[1], join(ROOT, 'scripts/reset-password.js'), 'nobody'], { env }));
});

test('after accounts exist, ADMIN_PASSWORD is ignored; old notification settings move to the first account', async () => {
  const hook = await webhookReceiver();
  // A fresh install configured the 1.x way: ADMIN_PASSWORD + NOTIFY_* env vars.
  const v1 = await startServer({ ADMIN_USERNAME: 'diogo', NOTIFY_WEBHOOK_URL: hook.url, NOTIFY_EVENTS: 'pick' });
  try {
    const admin = await loginAdmin(v1.base, { username: 'diogo' });
    assert.match((await admin.get('/admin/notifications')).text, /Active: webhook/);
    await v1.stop({ keepData: true });

    // Restart with a different ADMIN_PASSWORD: the account keeps its own password.
    const v2 = await startServer({ ADMIN_USERNAME: 'diogo', ADMIN_PASSWORD: 'a-different-pass-1' }, { dataDir: v1.dataDir });
    try {
      assert.equal(await loginStatus(v2.base, 'diogo', 'a-different-pass-1'), 401);
      assert.equal(await loginStatus(v2.base, 'diogo', ADMIN_PASSWORD), 303);
      assert.match(v2.logs(), /ADMIN_PASSWORD is ignored/);
    } finally {
      await v2.stop({ keepData: false });
    }
  } finally {
    await hook.close();
  }
});

test('without accounts or ADMIN_PASSWORD the login page explains how to start', async () => {
  const empty = await startServer({ ADMIN_PASSWORD: '' });
  try {
    const page = (await new Client(empty.base).get('/login')).text;
    assert.match(page, /no accounts yet/i);
    assert.match(empty.logs(), /No accounts yet/);
  } finally {
    await empty.stop();
  }
});
