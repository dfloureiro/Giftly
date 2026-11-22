// Admins reserving list gifts on behalf of a guest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, loginAdmin, inviteAdmin, createList, joinList, pickableIds, webhookReceiver, sleep,
} from './helpers.js';

let server, admin;
before(async () => {
  server = await startServer();
  admin = await loginAdmin(server.base);
});
after(async () => { await server?.stop(); });

const itemIds = async (listId) =>
  [...(await admin.get(`/admin/lists/${listId}`)).text.matchAll(/\/admin\/items\/(\d+)\/delete/g)].map((m) => Number(m[1]));

test('reserve for someone who has not joined yet: they see it as theirs when they open the list', async () => {
  const { id, token } = await createList(admin, { gifts: ['Teapot', 'Scarf'] });
  const [teapot] = await itemIds(id);
  const r = await admin.post(`/admin/items/${teapot}/reserve`, { name: 'Tia Ana' }, { from: `/admin/lists/${id}` });
  assert.match(r.location, /m=reservedFor/);

  const page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /Reserved by Tia Ana <span class="muted">[^<]*· by admin/);
  assert.match(page, /Tia Ana<\/td><td>1<\/td><td><span class="muted">not joined yet/);

  const other = await joinList(server.base, token, 'Rui');
  assert.ok(!(await pickableIds(other, token)).includes(teapot), 'gone for everyone else');

  const ana = await joinList(server.base, token, 'tia ana'); // case doesn't matter
  const anaPage = (await ana.get(`/l/${token}`)).text;
  assert.match(anaPage, /Your picks[\s\S]*Teapot[\s\S]*Reserved for you by admin/);
  assert.match(anaPage, new RegExp(`/l/${token}/unpick/${teapot}`), 'she can give it up');

  await ana.post(`/l/${token}/unpick/${teapot}`, {}, { from: `/l/${token}` });
  assert.ok((await pickableIds(other, token)).includes(teapot), 'available again after giving up');
});

test('reserving for a guest who already joined links it to them; the edit field does the same', async () => {
  const { id, token } = await createList(admin, { gifts: ['Lamp', 'Mug'] });
  const [lamp, mug] = await itemIds(id);
  const rui = await joinList(server.base, token, 'Rui Costa');
  await admin.post(`/admin/items/${lamp}/reserve`, { name: 'RUI COSTA' }, { from: `/admin/lists/${id}` });
  assert.match((await rui.get(`/l/${token}`)).text, /Your picks[\s\S]*Lamp/);

  // "Reserved by" field on the edit page, for someone who joins later.
  await admin.post(`/admin/items/${mug}`, { title: 'Mug', reserved_name: 'Avó Rosa' }, { from: `/admin/items/${mug}` });
  const rosa = await joinList(server.base, token, 'Avó Rosa');
  assert.match((await rosa.get(`/l/${token}`)).text, /Your picks[\s\S]*Mug/);
  assert.equal((await admin.get(`/admin/lists/${id}`)).text.split('Avó Rosa</td>').length - 1, 1, 'one guest, not two');
});

test('the other admins are notified, not the one who reserved', async () => {
  const mine = await webhookReceiver();
  const theirs = await webhookReceiver();
  try {
    const bea = await inviteAdmin(server.base, admin, { username: 'bea-reserve' });
    await admin.post('/admin/profile/notifications', { webhook_url: mine.url, event_pick: '1' }, { from: '/admin/profile' });
    await bea.post('/admin/profile/notifications', { webhook_url: theirs.url, event_pick: '1' }, { from: '/admin/profile' });
    const { id } = await createList(admin, { title: 'Notify list', gifts: ['Book'] });
    const [book] = await itemIds(id);
    await admin.post(`/admin/items/${book}/reserve`, { name: 'Primo João' }, { from: `/admin/lists/${id}` });
    for (let i = 0; i < 30 && !theirs.calls.length; i++) await sleep(100);
    assert.equal(theirs.calls.length, 1);
    assert.match(theirs.calls[0].title, /admin reserved a gift for Primo João/);
    await sleep(200);
    assert.equal(mine.calls.length, 0, 'not the admin who did it');
  } finally {
    await mine.close();
    await theirs.close();
    await admin.post('/admin/profile/notifications', {}, { from: '/admin/profile' });
  }
});

test('a guest’s first real visit after an admin reserved for them still counts as joining', async () => {
  const hook = await webhookReceiver();
  try {
    const bea = await loginAdmin(server.base, { username: 'bea-reserve', password: 'second-password-1' });
    await bea.post('/admin/profile/notifications', { webhook_url: hook.url, event_join: '1' }, { from: '/admin/profile' });
    const { id, token } = await createList(admin, { title: 'Join list', gifts: ['Pen'] });
    const [pen] = await itemIds(id);
    await admin.post(`/admin/items/${pen}/reserve`, { name: 'Tio Zé' }, { from: `/admin/lists/${id}` });
    await joinList(server.base, token, 'Tio Zé');
    for (let i = 0; i < 30 && !hook.calls.length; i++) await sleep(100);
    assert.equal(hook.calls.filter((c) => c.event === 'join').length, 1);
  } finally {
    await hook.close();
  }
});
