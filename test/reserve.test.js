// Admins reserving list gifts on behalf of a guest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, loginAdmin, inviteAdmin, createList, joinList, pickableIds, webhookReceiver, sleep, formFields,
} from './helpers.js';

let server, admin;
before(async () => {
  server = await startServer();
  admin = await loginAdmin(server.base);
});
after(async () => { await server?.stop(); });

/** The guest page's "Your picks" section. */
const picks = (html) => /<section class="mine">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
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

test('reserving for a guest who already joined links it to them; the edit page reserves and reassigns explicitly', async () => {
  const { id, token } = await createList(admin, { gifts: ['Lamp', 'Mug'] });
  const [lamp, mug] = await itemIds(id);
  const rui = await joinList(server.base, token, 'Rui Costa');
  await admin.post(`/admin/items/${lamp}/reserve`, { name: 'RUI COSTA' }, { from: `/admin/lists/${id}` });
  assert.match((await rui.get(`/l/${token}`)).text, /Your picks[\s\S]*Lamp/);

  // The edit page's own "Reserve" form, for someone who joins later.
  let edit = (await admin.get(`/admin/items/${mug}`)).text;
  let r = await admin.request(`/admin/items/${mug}/reserve`, { method: 'POST', form: { ...formFields(edit, `/admin/items/${mug}/reserve`), name: 'Avó Rosa' } });
  assert.match(r.location, /m=reservedFor/);
  const rosa = await joinList(server.base, token, 'Avó Rosa');
  assert.match((await rosa.get(`/l/${token}`)).text, /Your picks[\s\S]*Mug/);
  assert.equal((await admin.get(`/admin/lists/${id}`)).text.split('Avó Rosa</td>').length - 1, 1, 'one guest, not two');

  // "Reassign" from the edit page moves it to someone else.
  edit = (await admin.get(`/admin/items/${mug}`)).text;
  assert.match(edit, /Reassign/);
  r = await admin.request(`/admin/items/${mug}/reserve`, { method: 'POST', form: { ...formFields(edit, `/admin/items/${mug}/reserve`), name: 'Rui Costa' } });
  assert.match(r.location, /m=reservedFor/);
  assert.doesNotMatch(picks((await rosa.get(`/l/${token}`)).text), /Mug/);
  assert.match((await rui.get(`/l/${token}`)).text, /Your picks[\s\S]*Mug/);
});

test('saving an edit form opened before a guest picked never changes the pick', async () => {
  const { id, token } = await createList(admin, { gifts: ['Kettle'] });
  const [kettle] = await itemIds(id);
  const stale = formFields((await admin.get(`/admin/items/${kettle}`)).text, `/admin/items/${kettle}`);
  const sara = await joinList(server.base, token, 'Sara');
  await sara.post(`/l/${token}/pick/${kettle}`, {}, { from: `/l/${token}` });

  const r = await admin.request(`/admin/items/${kettle}`, { method: 'POST', form: { ...stale, title: 'Electric kettle' } });
  assert.match(r.location, /m=saved/);
  assert.match((await sara.get(`/l/${token}`)).text, /Your picks[\s\S]*Electric kettle/, 'the edit was saved and Sara still has it');
  // Pages from before this fix sent a "reserved_name" field (empty = release): ignored too.
  await admin.request(`/admin/items/${kettle}`, { method: 'POST', form: { ...stale, title: 'Kettle 2', reserved_name: '' } });
  assert.match(picks((await sara.get(`/l/${token}`)).text), /Kettle 2/);
});

test('an old edit form cannot bring back a pick that was given up', async () => {
  const { id, token } = await createList(admin, { gifts: ['Vase'] });
  const [vase] = await itemIds(id);
  const tiago = await joinList(server.base, token, 'Tiago');
  await tiago.post(`/l/${token}/pick/${vase}`, {}, { from: `/l/${token}` });
  const editPage = (await admin.get(`/admin/items/${vase}`)).text;
  const stale = formFields(editPage, `/admin/items/${vase}`);
  await tiago.post(`/l/${token}/unpick/${vase}`, {}, { from: `/l/${token}` });

  // Even with the field older versions of the page had, filled with his name.
  await admin.request(`/admin/items/${vase}`, { method: 'POST', form: { ...stale, reserved_name: 'Tiago' } });
  assert.ok((await pickableIds(tiago, token)).includes(vase), 'still free');

  // The page's "Release" button from before he gave it up does nothing either (and says so).
  const release = await admin.request(`/admin/items/${vase}/release`, { method: 'POST', form: formFields(editPage, `/admin/items/${vase}/release`) });
  assert.match(release.location, /m=reservationChanged/);
});

test('reserve/release buttons from a page opened before a guest picked do not override the guest', async () => {
  const { id, token } = await createList(admin, { gifts: ['Clock', 'Plant'] });
  const [clock, plant] = await itemIds(id);
  const listPage = (await admin.get(`/admin/lists/${id}`)).text;
  const marta = await joinList(server.base, token, 'Marta');
  await marta.post(`/l/${token}/pick/${clock}`, {}, { from: `/l/${token}` });
  await marta.post(`/l/${token}/pick/${plant}`, {}, { from: `/l/${token}` });

  // "Reserve for…" shown while it was free: refused, Marta keeps it.
  const r = await admin.request(`/admin/items/${clock}/reserve`, { method: 'POST', form: { ...formFields(listPage, `/admin/items/${clock}/reserve`), name: 'Primo' } });
  assert.match(r.location, /m=reservationChanged/);
  assert.match((await admin.get(r.location.replace(/#.*/, ''))).text, /reservation changed in the meantime/);
  // Without the field (an older page), it counts as "it was free": also refused.
  assert.match((await admin.post(`/admin/items/${clock}/reserve`, { name: 'Primo' }, { from: `/admin/lists/${id}` })).location, /m=reservationChanged/);
  let mine = (await marta.get(`/l/${token}`)).text;
  assert.match(mine, /Your picks[\s\S]*Clock/);

  // Release with the current page works.
  const fresh = (await admin.get(`/admin/lists/${id}`)).text;
  const rel = await admin.request(`/admin/items/${plant}/release`, { method: 'POST', form: formFields(fresh, `/admin/items/${plant}/release`) });
  assert.match(rel.location, /m=released/);
  mine = (await marta.get(`/l/${token}`)).text;
  assert.doesNotMatch(picks(mine), /Plant/);
  assert.ok((await pickableIds(marta, token)).includes(plant));
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
