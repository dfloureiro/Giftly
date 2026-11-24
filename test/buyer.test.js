// Lists that ask guests, when they pick a gift, whether they buy it or want the managers to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAdmin, inviteAdmin, createList, joinList, pickableIds, webhookReceiver, sleep, formFields } from './helpers.js';

let server, admin, hook;
before(async () => {
  hook = await webhookReceiver();
  server = await startServer({ NOTIFY_ALLOWED_HOSTS: '127.0.0.1' });
  admin = await loginAdmin(server.base);
  const r = await admin.post('/admin/notifications', { webhook_url: hook.url, event_pick: '1' }, { from: '/admin/profile' });
  assert.equal(r.status, 303, `notification settings saved (${r.status})`);
});
after(async () => { await server?.stop(); await hook?.close(); });

const picks = (html) => /<section class="mine">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
const itemIds = async (listId) =>
  [...(await admin.get(`/admin/lists/${listId}`)).text.matchAll(/\/admin\/items\/(\d+)\/delete/g)].map((m) => Number(m[1]));

/** Submit the edit form as a browser does: the hidden "0", then the box's "1" when ticked. */
async function setAskBuyer(id, on) {
  const edit = (await admin.get(`/admin/lists/${id}/edit`)).text;
  const pairs = Object.entries(formFields(edit, `/admin/lists/${id}`)).filter(([k]) => k !== 'ask_buyer');
  pairs.push(['ask_buyer', '0']);
  if (on) pairs.push(['ask_buyer', '1']);
  const r = await admin.request(`/admin/lists/${id}`, { method: 'POST', form: pairs });
  assert.equal(r.status, 303);
}

test('the "New list" form switches it on (hidden 0 + ticked 1), and the edit form off again', async () => {
  const csrf = await admin.csrf('/admin/lists/new');
  const r = await admin.request('/admin/lists', { method: 'POST', form: [['_csrf', csrf], ['title', 'Asks'], ['ask_buyer', '0'], ['ask_buyer', '1']] });
  const id = Number(/\/admin\/lists\/(\d+)/.exec(r.location)?.[1]);
  assert.match((await admin.get(`/admin/lists/${id}/edit`)).text, /name="ask_buyer" value="1" checked/);
  await setAskBuyer(id, false);
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}/edit`)).text, /name="ask_buyer" value="1" checked/);
});

test('off by default: one "I\'ll give this one" button and no buyer question', async () => {
  const { id, token } = await createList(admin, { gifts: ['Kettle'] });
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}/edit`)).text, /name="ask_buyer" value="1" checked/);
  const ana = await joinList(server.base, token, 'Ana');
  const page = (await ana.get(`/l/${token}`)).text;
  assert.match(page, /I&#39;ll give this one|I'll give this one/);
  assert.doesNotMatch(page, /name="buyer"/);
  const [kettle] = await itemIds(id);
  await ana.post(`/l/${token}/pick/${kettle}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}`)).text, /we buy/, 'an answer is ignored when the list does not ask');
});

test('when on, the guest picks with an answer; admins see it, the count and the notification', async () => {
  const { id, token } = await createList(admin, { gifts: ['Teapot', 'Scarf'] });
  await setAskBuyer(id, true);
  assert.match((await admin.get(`/admin/lists/${id}/edit`)).text, /name="ask_buyer" value="1" checked/);
  const [teapot, scarf] = await itemIds(id);

  const ana = await joinList(server.base, token, 'Ana');
  const page = (await ana.get(`/l/${token}`)).text;
  assert.match(page, new RegExp(`action="/l/${token}/pick/${teapot}"[^>]*>[\\s\\S]*?name="buyer" value="guest"[\\s\\S]*?name="buyer" value="us"`));

  // No answer (a page opened before the setting was switched on): nothing is reserved.
  let r = await ana.post(`/l/${token}/pick/${teapot}`, {}, { from: `/l/${token}` });
  assert.match(r.location, /m=chooseBuyer/);
  assert.ok((await pickableIds(ana, token)).includes(teapot));

  hook.calls.length = 0;
  r = await ana.post(`/l/${token}/pick/${teapot}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.match(r.location, /m=picked/);
  await ana.post(`/l/${token}/pick/${scarf}`, { buyer: 'guest' }, { from: `/l/${token}` });

  const adminPage = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(adminPage, /Reserved by Ana <span class="badge buyer-us">🛒 we buy/);
  assert.match(adminPage, /Reserved by Ana <span class="badge buyer-guest">🛍️ guest buys/);
  assert.match(adminPage, /2\/2 reserved · 1 for us to buy/);

  for (let i = 0; i < 50 && hook.calls.length < 2; i++) await sleep(20);
  const teapotCall = hook.calls.find((c) => c.item === 'Teapot');
  assert.equal(teapotCall?.buyer, 'us');
  assert.match(teapotCall.message, /asks you to buy it/);
  assert.match(picks((await ana.get(`/l/${token}`)).text), /ll buy it for you./);
});

test('the guest can change the answer; only for their own picks; it resets when the gift is freed', async () => {
  const { id, token } = await createList(admin, { gifts: ['Lamp'] });
  await setAskBuyer(id, true);
  const [lamp] = await itemIds(id);
  const ana = await joinList(server.base, token, 'Ana');
  const rui = await joinList(server.base, token, 'Rui');
  await ana.post(`/l/${token}/pick/${lamp}`, { buyer: 'guest' }, { from: `/l/${token}` });

  // Someone else can't change it.
  await rui.post(`/l/${token}/buyer/${lamp}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /buyer-guest/);

  hook.calls.length = 0;
  await ana.post(`/l/${token}/buyer/${lamp}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /buyer-us/);
  for (let i = 0; i < 50 && !hook.calls.length; i++) await sleep(20);
  assert.match(hook.calls[0]?.title ?? '', /Ana changed who buys a gift/);

  await ana.post(`/l/${token}/unpick/${lamp}`, {}, { from: `/l/${token}` });
  await rui.post(`/l/${token}/pick/${lamp}`, { buyer: 'guest' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Rui <span class="badge buyer-guest">/);

  // An admin reserving for someone leaves the answer to them.
  const edit = (await admin.get(`/admin/lists/${id}`)).text;
  await admin.request(`/admin/items/${lamp}/reserve`, { method: 'POST', form: { ...formFields(edit, `/admin/items/${lamp}/reserve`), name: 'Avó Rosa' } });
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Avó Rosa <span class="badge buyer/);
  const rosa = await joinList(server.base, token, 'Avó Rosa');
  assert.match(picks((await rosa.get(`/l/${token}`)).text), /Who buys it\?/);
});

test('admins set who buys when reserving for someone, and can change it on the list page', async () => {
  const { id, token } = await createList(admin, { gifts: ['Book', 'Vase'] });
  await setAskBuyer(id, true);
  const [book, vase] = await itemIds(id);

  // The reserve form asks too (only on lists that ask).
  let page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, new RegExp(`action="/admin/items/${book}/reserve"[\\s\\S]*?<select name="buyer">`));
  await admin.request(`/admin/items/${book}/reserve`, { method: 'POST', form: { ...formFields(page, `/admin/items/${book}/reserve`), name: 'Tio Zé', buyer: 'us' } });
  page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /Reserved by Tio Zé <span class="badge buyer-us">/);
  const ze = await joinList(server.base, token, 'Tio Zé');
  assert.match(picks((await ze.get(`/l/${token}`)).text), /ll buy it for you\./);

  // Switch it from the list page.
  await admin.request(`/admin/items/${book}/buyer`, { method: 'POST', form: { ...formFields(page, `/admin/items/${book}/buyer`), buyer: 'guest' } });
  page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /Reserved by Tio Zé <span class="badge buyer-guest">/);

  // A page opened before the guest changed it doesn't overwrite a different reservation.
  const stale = page;
  await ze.post(`/l/${token}/unpick/${book}`, {}, { from: `/l/${token}` });
  await ze.post(`/l/${token}/pick/${book}`, { buyer: 'guest' }, { from: `/l/${token}` });
  const r = await admin.request(`/admin/items/${book}/buyer`, { method: 'POST', form: { ...formFields(stale, `/admin/items/${book}/buyer`), buyer: 'us' } });
  assert.match(r.location, /m=reservationChanged/);
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Tio Zé <span class="badge buyer-guest">/);

  // A free gift has no switch.
  assert.doesNotMatch(page, new RegExp(`/admin/items/${vase}/buyer`));

  // Lists that don't ask: no question in the reserve form.
  const other = await createList(admin, { gifts: ['Pen'] });
  assert.doesNotMatch((await admin.get(`/admin/lists/${other.id}`)).text, /<select name="buyer">/);
});

test('an admin changing who buys tells the other admins (not themselves)', async () => {
  const bea = await inviteAdmin(server.base, admin, { username: 'bea-buyer' });
  const theirs = await webhookReceiver();
  try {
    await bea.post('/admin/notifications', { webhook_url: theirs.url, event_pick: '1' }, { from: '/admin/profile' });
    const { id, token } = await createList(admin, { gifts: ['Plant'] });
    await setAskBuyer(id, true);
    const [plant] = await itemIds(id);
    const ana = await joinList(server.base, token, 'Ana');
    await ana.post(`/l/${token}/pick/${plant}`, { buyer: 'guest' }, { from: `/l/${token}` });
    for (let i = 0; i < 50 && !theirs.calls.length; i++) await sleep(20);
    theirs.calls.length = 0;
    hook.calls.length = 0;
    const page = (await admin.get(`/admin/lists/${id}`)).text;
    await admin.request(`/admin/items/${plant}/buyer`, { method: 'POST', form: { ...formFields(page, `/admin/items/${plant}/buyer`), buyer: 'us' } });
    for (let i = 0; i < 50 && !theirs.calls.length; i++) await sleep(20);
    assert.match(theirs.calls[0]?.title ?? '', /admin changed who buys Ana's gift/);
    assert.equal(theirs.calls[0].buyer, 'us');
    await sleep(150);
    assert.equal(hook.calls.length, 0, 'not the admin who did it');
  } finally {
    await theirs.close();
  }
});

test('admins mark a gift they were asked to buy as bought; the guest sees it and can no longer give it up or switch', async () => {
  const { id, token } = await createList(admin, { gifts: ['Drone', 'Socks'] });
  await setAskBuyer(id, true);
  const [drone, socks] = await itemIds(id);
  const ana = await joinList(server.base, token, 'Ana');
  await ana.post(`/l/${token}/pick/${drone}`, { buyer: 'us' }, { from: `/l/${token}` });
  await ana.post(`/l/${token}/pick/${socks}`, { buyer: 'guest' }, { from: `/l/${token}` });

  let page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /1 for us to buy/);
  assert.match(page, new RegExp(`action="/admin/items/${drone}/bought"`));
  assert.doesNotMatch(page, new RegExp(`action="/admin/items/${socks}/bought"`), 'only for gifts we were asked to buy');

  // Not for a gift the guest buys, even when posted directly.
  await admin.request(`/admin/items/${socks}/bought`, { method: 'POST', form: { ...formFields(page, `/admin/items/${drone}/bought`), expect: formFields(page, `/admin/items/${socks}/buyer`).expect, bought: '1' } });
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}`)).text, /buyer-bought/);

  await admin.request(`/admin/items/${drone}/bought`, { method: 'POST', form: { ...formFields(page, `/admin/items/${drone}/bought`) } });
  page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /Reserved by Ana <span class="badge buyer-bought">✅ bought/);
  assert.match(page, /Bought by admin · /);
  assert.match(page, /0 for us to buy · 1 bought/);
  assert.match(page, /Not bought yet/);
  assert.doesNotMatch(page, new RegExp(`action="/admin/items/${drone}/buyer"`), 'no switch while bought');

  // The guest sees it, without "Give up" or the switch; posting anyway changes nothing.
  const mine = picks((await ana.get(`/l/${token}`)).text);
  assert.match(mine, /ve bought it for you/);
  assert.doesNotMatch(mine, new RegExp(`/l/${token}/unpick/${drone}`));
  assert.doesNotMatch(mine, new RegExp(`/l/${token}/buyer/${drone}`));
  let r = await ana.post(`/l/${token}/unpick/${drone}`, {}, { from: `/l/${token}` });
  assert.match(r.location, /m=boughtLocked/);
  await ana.post(`/l/${token}/buyer/${drone}`, { buyer: 'guest' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Ana <span class="badge buyer-bought">/);
  await admin.request(`/admin/items/${drone}/buyer`, { method: 'POST', form: { ...formFields(page, `/admin/items/${drone}/bought`), buyer: 'guest' } });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Ana <span class="badge buyer-bought">/);

  // Undo, then an admin release clears it for whoever picks it next.
  page = (await admin.get(`/admin/lists/${id}`)).text;
  await admin.request(`/admin/items/${drone}/bought`, { method: 'POST', form: { ...formFields(page, `/admin/items/${drone}/bought`) } });
  page = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(page, /Reserved by Ana <span class="badge buyer-us">/);
  await admin.request(`/admin/items/${drone}/bought`, { method: 'POST', form: { ...formFields(page, `/admin/items/${drone}/bought`) } });
  page = (await admin.get(`/admin/lists/${id}`)).text;
  await admin.request(`/admin/items/${drone}/release`, { method: 'POST', form: formFields(page, `/admin/items/${drone}/release`) });
  const rui = await joinList(server.base, token, 'Rui');
  await rui.post(`/l/${token}/pick/${drone}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Rui <span class="badge buyer-us">/);
  assert.doesNotMatch(picks((await rui.get(`/l/${token}`)).text), /bought it for you/);

  // A page opened before the gift changed hands doesn't mark the new reservation.
  const stale = (await admin.get(`/admin/lists/${id}`)).text;
  await rui.post(`/l/${token}/unpick/${drone}`, {}, { from: `/l/${token}` });
  await ana.post(`/l/${token}/pick/${drone}`, { buyer: 'us' }, { from: `/l/${token}` });
  r = await admin.request(`/admin/items/${drone}/bought`, { method: 'POST', form: formFields(stale, `/admin/items/${drone}/bought`) });
  assert.match(r.location, /m=reservationChanged/);
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Ana <span class="badge buyer-us">/);
});
