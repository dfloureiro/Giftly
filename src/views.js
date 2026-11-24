import { config } from './config.js';

// ---------- tiny escaping template engine ----------

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// ---------- helpers ----------

export function fmtDate(ctx, ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(ctx.lang === 'en' ? 'en-GB' : 'pt-PT', {
    dateStyle: 'short', timeStyle: 'short', timeZone: config.timeZone,
  }).format(new Date(ms));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Drag handle for reordering (app.js); the ↑/↓ buttons stay as the no-JavaScript fallback. */
export const dragHandle = (ctx) => h`<button type="button" class="drag-handle" aria-label="${ctx.t('admin.dragToReorder')}" title="${ctx.t('admin.dragToReorder')}" hidden><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>`;

const csrfField = (ctx) => h`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;

/** A one-button POST form. */
function postButton(ctx, action, label, { confirm, cls = '', extra = '' } = {}) {
  return h`<form method="post" action="${action}" class="inline"${confirm ? h` data-confirm="${confirm}"` : ''}>
    ${csrfField(ctx)}${raw(extra)}<button type="submit" class="${cls}">${label}</button></form>`;
}

/**
 * Which reservation an admin page showed ("free" when none). The reserve/release forms send it
 * back as `expect`, and the server only acts if it still holds.
 */
export function reservationKey(item) {
  return item.reserved_name ? `${item.reserved_guest_id ?? 'manual'}.${item.reserved_at ?? ''}` : 'free';
}

/**
 * On a list that asks who buys: the admin's switch for a reserved gift ("we buy" / "guest buys").
 * Sends `expect` like the other reservation actions, so it only applies to the reservation shown.
 */
function adminBuyerSwitch(ctx, it) {
  const button = (value) => h`<button type="submit" name="buyer" value="${value}" class="link">${ctx.t(`admin.buyerSet.${value}`)}</button>`;
  const choices = it.reserved_buyer ? [it.reserved_buyer === 'us' ? 'guest' : 'us'] : ['us', 'guest'];
  return h`<form method="post" action="/admin/items/${it.id}/buyer" class="buyer-choice small">
    ${csrfField(ctx)}<input type="hidden" name="expect" value="${reservationKey(it)}">
    ${choices.map((c, i) => h`${i ? ' · ' : ''}${button(c)}`)}
  </form>`;
}

/** A gift the managers were asked to buy: "Mark as bought" / "Not bought yet". */
function boughtToggle(ctx, it) {
  return h`<form method="post" action="/admin/items/${it.id}/bought" class="inline">
    ${csrfField(ctx)}<input type="hidden" name="expect" value="${reservationKey(it)}">
    <input type="hidden" name="bought" value="${it.bought_at ? '0' : '1'}">
    <button type="submit" class="${it.bought_at ? 'link' : 'secondary'}">${ctx.t(it.bought_at ? 'admin.unmarkBought' : 'admin.markBought')}</button>
  </form>`;
}

/** Who has an item reserved (or that it's free / taken in another list). */
function reservationStatus(ctx, it, adminNames, list = {}) {
  const buying = it.reserved_name && it.reserved_buyer === 'us';
  return h`${reservationText(ctx, it, adminNames)}
    ${buying && it.bought_at ? h`<span class="small muted bought-line">✅ ${ctx.t('admin.boughtBy', { name: adminNames[it.bought_by_user_id] || '—', date: fmtDate(ctx, it.bought_at) })}</span>` : ''}
    ${buying || (list.ask_buyer && it.reserved_name) ? h`<span class="buyer-row">${buying ? boughtToggle(ctx, it) : ''}${list.ask_buyer && it.reserved_name && !it.bought_at ? adminBuyerSwitch(ctx, it) : ''}</span>` : ''}`;
}

function reservationText(ctx, it, adminNames) {
  return it.claimed_elsewhere && !it.reserved_name
    ? h`<span class="muted">🎀 ${ctx.t('wish.claimedElsewhere')}</span>`
    : it.reserved_name
    ? h`🎀 ${ctx.t('admin.reservedBy', { name: it.reserved_name })}${it.reserved_buyer ? h` <span class="badge buyer-${it.bought_at ? 'bought' : it.reserved_buyer}">${ctx.t(it.bought_at ? 'admin.buyer.bought' : `admin.buyer.${it.reserved_buyer}`)}</span>` : ''} <span class="muted">· ${fmtDate(ctx, it.reserved_at)}${it.reserved_by_user_id ? ` · ${ctx.t('admin.byAdmin', { name: adminNames[it.reserved_by_user_id] || '—' })}` : ''}${it.reserved_guest_id ? '' : ` · ${ctx.t('admin.manual')}`}</span>`
    : h`<span class="muted">${ctx.t('admin.free')}</span>`;
}

/** The explicit reservation actions: release, and reserve for / reassign to someone by name. */
function reservationActions(ctx, it, datalistId, list = {}) {
  const expect = h`<input type="hidden" name="expect" value="${reservationKey(it)}">`;
  if (it.claimed_elsewhere && !it.reserved_name) return '';
  const label = it.reserved_name ? ctx.t('admin.reassignButton') : ctx.t('admin.reserveButton');
  return h`${it.reserved_name ? postButton(ctx, `/admin/items/${it.id}/release`, ctx.t('admin.release'), { cls: 'secondary', confirm: ctx.t('admin.releaseConfirm'), extra: String(expect) }) : ''}
        <details class="reserve-for">
          <summary class="button secondary">${label}</summary>
          <form method="post" action="/admin/items/${it.id}/reserve" class="stack">
            ${csrfField(ctx)}${expect}
            <label>${ctx.t('admin.reserveFor')}
              <input name="name" required maxlength="60" list="${datalistId}" autocomplete="off" placeholder="${ctx.t('login.namePlaceholder')}">
            </label>
            ${list.ask_buyer ? h`<label>${ctx.t('list.buyerAsk')}
              <select name="buyer">
                <option value="">${ctx.t('admin.buyerLetThem')}</option>
                <option value="us">${ctx.t('admin.buyerSet.us')}</option>
                <option value="guest">${ctx.t('admin.buyerSet.guest')}</option>
              </select>
            </label>` : ''}
            <p class="small muted">${ctx.t('admin.reserveHint')}</p>
            <button type="submit" class="primary">${label}</button>
          </form>
        </details>`;
}

function flash(ctx) {
  if (!ctx.flash) return '';
  return h`<div class="flash flash-${ctx.flash.type}" role="status">${ctx.flash.text}</div>`;
}


/** PT · EN. Guest pages show it above the page; admin pages put it in the header row, next to the account menu. */
function langSwitch(ctx) {
  return h`<nav class="lang" aria-label="Language">
  ${[['pt', 'PT'], ['en', 'EN']].map(([code, label]) => code === ctx.lang
    ? h`<strong aria-current="true">${label}</strong>`
    : h`<a href="/lang?to=${code}&amp;back=${encodeURIComponent(ctx.url.pathname)}" hreflang="${code}" lang="${code}">${label}</a>`)}
</nav>`;
}

function layout(ctx, { title, body, bodyClass = '' }) {
  const site = config.siteTitle || ctx.t('appName');
  return h`<!doctype html>
<html lang="${ctx.lang === 'pt' ? 'pt-PT' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title ? `${title} · ${site}` : site}</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#C8553D">
<meta name="apple-mobile-web-app-title" content="${site}">
<link rel="stylesheet" href="/static/style.css?v=30">
<script src="/static/app.js?v=7" defer></script>
</head>
<body class="${bodyClass}">
${langSwitch(ctx)}
<main class="wrap">
${flash(ctx)}
${body}
</main>
<footer class="site-footer">
  <a href="https://github.com/dfloureiro/giftly" target="_blank" rel="noopener noreferrer">Giftly</a>
  <span aria-hidden="true">·</span>
  <a href="https://liberapay.com/dfloureiro/donate" target="_blank" rel="noopener noreferrer">${ctx.t('footer.support')}</a>
</footer>
</body>
</html>`;
}

// ---------- guest pages ----------

export function homePage(ctx, { sessions }) {
  const site = config.siteTitle || ctx.t('appName');
  return layout(ctx, {
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${site}</h1>
  ${sessions.length ? h`
    <p class="muted">${ctx.t('home.yourLists')}</p>
    <ul class="lists">
      ${sessions.map(({ list, guest }) => h`<li><a href="/l/${list.token}"><strong>${list.title}</strong>
        <span class="small muted">${ctx.t('list.hello', { name: guest.name })}</span></a></li>`)}
    </ul>` : h`<p class="muted">${ctx.t('home.askForLink')}</p>`}
</section>`,
  });
}

export function joinPage(ctx, { list, name = '', error, sameName = '' } = {}) {
  return layout(ctx, {
    title: list.title,
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${list.title}</h1>
  ${list.description ? h`<p class="description">${list.description}</p>` : ''}
  <p class="muted">${ctx.t('join.intro')}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  ${sameName ? h`<div class="same-name" role="alert">
    <p><strong>${ctx.t('join.sameName', { name: sameName })}</strong></p>
    <form method="post" action="/l/${list.token}/join">
      <input type="hidden" name="name" value="${sameName}"><input type="hidden" name="confirm" value="1">
      <button type="submit" class="primary">${ctx.t('join.itsMe')}</button>
    </form>
    <p class="small muted">${ctx.t('join.notMe')}</p>
  </div>` : ''}
  <form method="post" action="/l/${list.token}/join" class="stack">
    <label>${ctx.t('login.name')}
      <input name="name" required maxlength="60" autocomplete="name" value="${name}" placeholder="${ctx.t('login.namePlaceholder')}"${sameName ? '' : raw(' autofocus')}>
    </label>
    <button type="submit" class="${sameName ? 'secondary' : 'primary'}">${ctx.t(sameName ? 'join.otherName' : 'login.submit')}</button>
  </form>
  <p class="small muted">${ctx.t('login.hint')}</p>
</section>`,
  });
}

function thumb(ctx, it, { admin = false } = {}) {
  if (it.image_file) return h`<div class="thumb"><img src="/img/${it.image_file}" alt="" loading="lazy" decoding="async"></div>`;
  const pending = admin && it.preview_status === 'pending';
  return h`<div class="thumb empty${pending ? ' pending' : ''}"${pending ? h` data-preview-id="${it.id}"` : ''} aria-hidden="true">🎁</div>`;
}

function previewStatus(ctx, it) {
  if (it.preview_status === 'pending') return h`<p class="small muted" data-preview-status="${it.id}">${ctx.t('preview.pending')}</p>`;
  if (it.preview_status === 'failed' || it.preview_status === 'none') return h`<p class="small muted">${ctx.t('preview.failed')}</p>`;
  return '';
}

function itemBody(ctx, it) {
  const host = it.url ? hostOf(it.url) : '';
  return h`
    <h3>${it.title}</h3>
    ${it.wish_notes ? h`<p class="notes">${it.wish_notes}</p>` : ''}
    ${it.notes ? h`<p class="notes">${it.notes}</p>` : ''}
    <div class="meta">
      ${it.price ? h`<span class="price" title="${ctx.t('price.fromShop')}">${it.price}</span>` : ''}
      ${it.url ? h`<a href="${it.url}" target="_blank" rel="noopener noreferrer nofollow">${ctx.t('list.visit', { host })} ↗</a>` : ''}
    </div>`;
}

/** Picking on a list that asks who buys: one button per answer (works without JavaScript). */
function pickWithBuyer(ctx, list, it) {
  return h`<form method="post" action="/l/${list.token}/pick/${it.id}" class="inline pick-buyer" data-confirm="${ctx.t('list.pickConfirm', { title: it.title })}">
    ${csrfField(ctx)}
    <button type="submit" name="buyer" value="guest" class="primary">${ctx.t('list.pickBuySelf')}</button>
    <button type="submit" name="buyer" value="us" class="secondary">${ctx.t('list.pickBuyForMe')}</button>
  </form>`;
}

/** In "Your picks": who buys it (the guest's answer), and the button to change it. */
function buyerChoiceForm(ctx, list, it) {
  if (it.bought_at) return h`<p class="small bought-for-you">${ctx.t('list.boughtForYou')}</p>`;
  const other = it.reserved_buyer === 'guest' ? 'us' : 'guest';
  const button = (value, label) => h`<button type="submit" name="buyer" value="${value}" class="link">${label}</button>`;
  return h`<form method="post" action="/l/${list.token}/buyer/${it.id}" class="buyer-choice small">
    ${csrfField(ctx)}
    ${it.reserved_buyer
      ? h`<span>${ctx.t(`list.buyer.${it.reserved_buyer}`)}</span> · ${button(other, ctx.t(`list.buyerSwitch.${other}`))}`
      : h`<span>${ctx.t('list.buyerAsk')}</span> ${button('guest', ctx.t('list.pickBuySelf'))} · ${button('us', ctx.t('list.pickBuyForMe'))}`}
  </form>`;
}

export function guestListPage(ctx, { list, guest, available, mine, takenByOthers, total, adminNames = {} }) {
  return layout(ctx, {
    title: list.title,
    body: h`
<header class="top">
  <div>
    <h1>${list.title}</h1>
    ${list.description ? h`<p class="description">${list.description}</p>` : ''}
  </div>
  <div class="who">
    <span>${ctx.t('list.hello', { name: guest.name })}</span>
    ${postButton(ctx, `/l/${list.token}/logout`, ctx.t('list.logout'), { cls: 'link' })}
  </div>
</header>

${mine.length ? h`
<section class="mine">
  <h2>${ctx.t('list.mine')}</h2>
  <p class="small muted">${ctx.t('list.mineHint')}</p>
  <ul class="items">
    ${mine.map((it) => h`<li class="item picked" id="item-${it.id}">
      ${thumb(ctx, it)}
      <div class="body">${itemBody(ctx, it)}
        ${it.wish_status && it.wish_status !== 'active' ? h`<p class="flash flash-error small">${ctx.t(`wish.guestRemoved.${it.wish_removed_reason === 'unwanted' ? 'unwanted' : 'bought'}`)}</p>` : ''}
        ${it.reserved_by_user_id ? h`<p class="small muted reserved-for-you">🎀 ${ctx.t('list.reservedForYou', { name: adminNames[it.reserved_by_user_id] || '—' })}</p>` : ''}
        ${list.ask_buyer || it.bought_at ? buyerChoiceForm(ctx, list, it) : ''}</div>
      ${it.bought_at ? '' : postButton(ctx, `/l/${list.token}/unpick/${it.id}`, ctx.t('list.unpick'), { cls: 'secondary', confirm: ctx.t('list.unpickConfirm', { title: it.title }) })}
    </li>`)}
  </ul>
</section>` : ''}

<section>
  <h2>${ctx.t('list.available')}</h2>
  <p class="small muted">${ctx.t('list.howItWorks')}
    ${takenByOthers ? h` ${ctx.t('list.takenByOthers', { n: takenByOthers })}` : ''}</p>
  ${available.length ? h`
  <ul class="items">
    ${available.map((it) => h`<li class="item">
      ${thumb(ctx, it)}
      <div class="body">${itemBody(ctx, it)}</div>
      ${list.ask_buyer ? pickWithBuyer(ctx, list, it) : postButton(ctx, `/l/${list.token}/pick/${it.id}`, ctx.t('list.pick'), { cls: 'primary', confirm: ctx.t('list.pickConfirm', { title: it.title }) })}
    </li>`)}
  </ul>` : h`<p class="empty">${total ? ctx.t('list.none') : ctx.t('list.empty')}</p>`}
</section>`,
  });
}

// ---------- admin pages ----------

export function adminLoginPage(ctx, { error, username = '', noAccounts = false, next = '/admin' } = {}) {
  return layout(ctx, {
    title: ctx.t('admin.title'),
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${ctx.t('admin.login')}</h1>
  ${noAccounts ? h`<div class="flash flash-error" role="alert">${ctx.t('account.noAccounts')}</div>` : ''}
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/login" class="stack">
    ${next !== '/admin' ? h`<input type="hidden" name="next" value="${next}">` : ''}
    <label>${ctx.t('account.username')}
      <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${username}" autofocus>
    </label>
    <label>${ctx.t('account.password')}
      <input type="password" name="password" required autocomplete="current-password">
    </label>
    <button type="submit" class="primary">${ctx.t('login.submit')}</button>
  </form>
  <p class="small muted">${ctx.t('account.forgotHint')}</p>
</section>`,
  });
}

// Main navigation: Occasions · People · Lists · My wishlist (the giving side first, then the
// receiving side). Settings and administration live in the account menu.
const ICONS = {
  occasions: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.8.3 5 2.6 5 5.8"/>',
  lists: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  wishlist: '<path d="M4 11h16v9H4zM3 7h18v4H3zM12 7v13"/><path d="M12 7c-1.5-3-5-3.5-5-1.2C7 7.3 10 7 12 7zM12 7c1.5-3 5-3.5 5-1.2C17 7.3 14 7 12 7z"/>',
};
const icon = (name) => raw(`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
// Same stroke style as the bottom bar icons (no emoji).
const GEAR_ICON = raw('<svg class="gear-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>');

const NAV = [
  { href: '/admin/occasions', key: 'nav.occasions', icon: 'occasions', on: (p) => p.startsWith('/admin/occasions') },
  { href: '/admin/people', key: 'nav.people', icon: 'people', on: (p) => p.startsWith('/admin/people') || p.startsWith('/admin/wishlists/') },
  { href: '/admin/lists', key: 'nav.lists', icon: 'lists', on: (p) => p.startsWith('/admin/lists') || p.startsWith('/admin/items') },
  { href: '/admin/wishlist', key: 'nav.myWishlist', icon: 'wishlist', on: (p) => p === '/admin/wishlist' || p.startsWith('/admin/wishlist/') },
];

/** "Maria Ana Silva" → "MS". */
const initials = (name) => {
  const w = String(name || '?').trim().split(/\s+/);
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
};

function adminHeader(ctx, backHref, backLabel) {
  const path = ctx.url.pathname;
  const current = (on) => (on ? raw(' aria-current="page"') : '');
  const menu = [
    ['/admin/profile', 'account.profile'],
    ['/admin/notifications', 'nav.notifications'],
    ['/admin/users', 'account.admins'],
  ];
  return h`<header class="admin-top">
  <nav class="admin-nav" aria-label="${ctx.t('admin.title')}">
    ${NAV.map((n) => h`<a href="${n.href}" class="tab${n.on(path) ? ' active' : ''}"${current(n.on(path))}>${ctx.t(n.key)}</a>`)}
  </nav>
  <div class="top-right">
    ${langSwitch(ctx)}
    <details class="account-menu">
      <summary aria-label="${ctx.t('nav.account')}"><span class="avatar" aria-hidden="true">${initials(ctx.user?.name)}</span><span class="who-name">${ctx.user?.name}</span></summary>
      <div class="menu">
        ${menu.map(([href, key]) => h`<a href="${href}"${current(path.startsWith(href))}>${ctx.t(key)}</a>`)}
        ${postButton(ctx, '/admin/logout', ctx.t('admin.logout'), { cls: 'link' })}
      </div>
    </details>
  </div>
</header>
<nav class="bottom-nav" aria-label="${ctx.t('admin.title')}">
  ${NAV.map((n) => h`<a href="${n.href}" class="${n.on(path) ? 'active' : ''}"${current(n.on(path))}>${icon(n.icon)}<span>${ctx.t(n.short || n.key)}</span></a>`)}
</nav>
${backHref ? h`<p class="backline"><a href="${backHref}" class="back">${backLabel}</a></p>` : ''}`;
}

function listFields(ctx, v, { withArchived = false, canSetVisibility = true } = {}) {
  return h`
    ${canSetVisibility ? h`<label>${ctx.t('give.visibility')}
      <select name="visibility">
        <option value="shared"${v.visibility !== 'private' ? raw(' selected') : ''}>${ctx.t('lists.vis.shared')}</option>
        <option value="private"${v.visibility === 'private' ? raw(' selected') : ''}>${ctx.t('lists.vis.private')}</option>
      </select>
    </label>` : ''}
    <label class="check"><input type="hidden" name="ask_buyer" value="0"><input type="checkbox" name="ask_buyer" value="1"${v.ask_buyer ? raw(' checked') : ''}> ${ctx.t('admin.askBuyer')}</label>
    <p class="small muted hint">${ctx.t('admin.askBuyerHint')}</p>
    ${v.source_wishlist_id ? h`<label class="check"><input type="hidden" name="auto_add_new" value="0"><input type="checkbox" name="auto_add_new" value="1"${v.auto_add_new ? raw(' checked') : ''}> ${ctx.t('wish.autoAdd')}</label>` : ''}
    <label>${ctx.t('admin.listTitle')}
      <input name="title" required maxlength="120" value="${v.title || ''}" placeholder="${ctx.t('admin.listTitlePlaceholder')}">
    </label>
    <label>${ctx.t('admin.description')}
      <textarea name="description" rows="2" maxlength="2000" placeholder="${ctx.t('admin.descriptionPlaceholder')}">${v.description || ''}</textarea>
    </label>
    ${withArchived ? h`<label class="check"><input type="checkbox" name="archived" value="1"${v.archived ? raw(' checked') : ''}> ${ctx.t('admin.archived')}</label>` : ''}`;
}

/**
 * The gear menu of a page (its settings and rare actions): items are links ({ href, label }),
 * one-button forms ({ post, label, confirm, danger, extra }) or a note ({ note }).
 */
export function gearMenu(ctx, items) {
  return h`<details class="account-menu gear-menu">
    <summary class="gear" aria-label="${ctx.t('nav.options')}" title="${ctx.t('nav.options')}">${GEAR_ICON}</summary>
    <div class="menu">
      ${items.filter(Boolean).map((it) => it.href ? h`<a href="${it.href}">${it.label}</a>`
        : it.post ? postButton(ctx, it.post, it.label, { cls: `link${it.danger ? ' danger' : ''}`, confirm: it.confirm, extra: it.extra || '' })
        : h`<p class="small muted menu-note">${it.note}</p>`)}
    </div>
  </details>`;
}

/** A page title with its main action on the right ("＋ New …") and/or its ⚙️ menu, the same on every screen. */
export function pageHead(ctx, title, action = null, gear = null) {
  return h`<div class="page-head"><h1>${title}</h1>${action || gear ? h`<div class="head-actions">${action ? h`<a class="button primary" href="${action.href}">＋ ${action.label}</a>` : ''}${gear ? gearMenu(ctx, gear) : ''}</div>` : ''}</div>`;
}

/** A page with one form: "New list", "New person", "Add a gift"… */
export function formPage(ctx, { title, back, backLabel, error, body }) {
  return layout(ctx, {
    title,
    body: h`
${adminHeader(ctx, back, `← ${backLabel}`)}
<section class="card">
  <h1>${title}</h1>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  ${body}
</section>`,
  });
}

export function adminDashboard(ctx, { all }) {
  return layout(ctx, {
    title: ctx.t('nav.lists'),
    body: h`
${adminHeader(ctx)}
${pageHead(ctx, ctx.t('nav.lists'), { href: '/admin/lists/new', label: ctx.t('admin.newList') })}
${all.length ? h`
<ul class="lists">
  ${all.map((l) => h`<li class="${l.archived ? 'archived' : ''}">
    <a href="/admin/lists/${l.id}">
      <strong>${l.title}</strong>
      ${l.archived ? h`<span class="badge">${ctx.t('admin.archivedBadge')}</span>` : ''}
      ${l.visibility === 'private' ? h`<span class="badge private">🔒 ${ctx.t('give.private')}</span>` : ''}
      ${l.source_wishlist_id ? h`<span class="badge">🎀 ${ctx.t('wish.fromWishlistShort')}</span>` : ''}
      <span class="small muted">${l.item_count} ${ctx.t('admin.items').toLowerCase()} (${l.reserved_count} ${ctx.t('admin.reserved')}) · ${l.guest_count} ${ctx.t('admin.guests').toLowerCase()}</span>
    </a>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t('admin.noLists')}</p>`}
<p class="small muted">${ctx.t('lists.fromWishlistHint')}</p>`,
  });
}

export function newListFormPage(ctx, { form = {}, error }) {
  return formPage(ctx, {
    title: ctx.t('admin.newList'), back: '/admin/lists', backLabel: ctx.t('nav.lists'), error,
    body: h`<form method="post" action="/admin/lists" class="stack">
    ${csrfField(ctx)}
    ${listFields(ctx, form)}
    <button type="submit" class="primary">${ctx.t('admin.create')}</button>
  </form>`,
  });
}

/** Add gifts to a list: one with its details, or several at once (one per line). */
export function newItemPage(ctx, { list, form = {}, error }) {
  return formPage(ctx, {
    title: ctx.t('admin.addItem'), back: `/admin/lists/${list.id}`, backLabel: list.title, error,
    body: h`<form method="post" action="/admin/lists/${list.id}/items" class="stack">
    ${csrfField(ctx)}
    ${itemFields(ctx, form)}
    ${uploadField(ctx)}
    <button type="submit" class="primary">${ctx.t('admin.add')}</button>
  </form>
  <details>
    <summary>${ctx.t('admin.bulkAdd')}</summary>
    <form method="post" action="/admin/lists/${list.id}/items/bulk" class="stack">
      ${csrfField(ctx)}
      <p class="small muted">${ctx.t('admin.bulkHint')}</p>
      <textarea name="lines" rows="6" placeholder="${ctx.t('admin.bulkPlaceholder')}"></textarea>
      <button type="submit" class="primary">${ctx.t('admin.add')}</button>
    </form>
  </details>`,
  });
}

function notifySection(ctx, { values: v, channels, problems }, errors) {
  const checked = (on) => (on ? raw(' checked') : '');
  const secret = (name, isSet) => h`
      <input name="${name}" type="password" autocomplete="off" placeholder="${isSet ? ctx.t('notify.secretKeep') : ''}">
      ${isSet ? h`<label class="check small"><input type="checkbox" name="clear_${name}" value="1"> ${ctx.t('notify.secretClear')}</label>` : ''}`;
  return h`
<section class="card" id="notifications">
  <h2>${ctx.t('notify.heading')}</h2>
  ${[...new Set([...errors, ...problems])].map((k) => h`<div class="flash flash-error" role="alert">${ctx.t(k)}</div>`)}
  <p class="small muted">${channels.length ? ctx.t('notify.active', { channels: channels.join(', ') }) : ctx.t('notify.none')}</p>
  <form method="post" action="/admin/notifications" class="stack">
    ${csrfField(ctx)}
    <fieldset class="group">
      <legend>${ctx.t('notify.when')}</legend>
      <label class="check"><input type="checkbox" name="event_pick" value="1"${checked(v.events.includes('pick'))}> ${ctx.t('notify.ev.pick')}</label>
      <label class="check"><input type="checkbox" name="event_unpick" value="1"${checked(v.events.includes('unpick'))}> ${ctx.t('notify.ev.unpick')}</label>
      <label class="check"><input type="checkbox" name="event_join" value="1"${checked(v.events.includes('join'))}> ${ctx.t('notify.ev.join')}</label>
    </fieldset>
    <fieldset class="group">
      <legend>ntfy</legend>
      <label>${ctx.t('notify.ntfyUrl')}
        <input name="ntfy_url" value="${v.ntfy_url}" placeholder="https://ntfy.sh/giftly-…" autocomplete="off" spellcheck="false">
        <span class="small muted">${ctx.t('notify.ntfyHint')}</span>
      </label>
      <label>${ctx.t('notify.ntfyToken')}${secret('ntfy_token', v.ntfy_token_set)}</label>
    </fieldset>
    <fieldset class="group">
      <legend>Telegram</legend>
      <label>${ctx.t('notify.tgToken')}${secret('telegram_bot_token', v.telegram_bot_token_set)}</label>
      <label>${ctx.t('notify.tgChat')}
        <input name="telegram_chat_id" value="${v.telegram_chat_id}" autocomplete="off" spellcheck="false">
      </label>
    </fieldset>
    <fieldset class="group">
      <legend>Webhook</legend>
      <label>${ctx.t('notify.webhookUrl')}
        <input name="webhook_url" type="url" value="${v.webhook_url}" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" spellcheck="false">
        <span class="small muted">${ctx.t('notify.webhookHint')}</span>
      </label>
    </fieldset>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  ${channels.length ? postButton(ctx, '/admin/notifications/test', ctx.t('notify.testButton'), { cls: 'secondary' }) : ''}
</section>`;
}

function itemFields(ctx, v) {
  return h`
    <label>${ctx.t('admin.itemTitle')}
      <input name="title" required maxlength="200" value="${v.title || ''}">
    </label>
    <label>${ctx.t('admin.itemUrl')}
      <input name="url" type="url" maxlength="2000" value="${v.url || ''}" placeholder="https://">
    </label>
    <label>${ctx.t('admin.itemNotes')}
      <input name="notes" maxlength="1000" value="${v.notes || ''}" placeholder="${ctx.t('admin.itemNotesPlaceholder')}">
    </label>
    ${v.price ? h`<p class="small muted">${ctx.t('price.current', { price: v.price, date: fmtDate(ctx, v.price_checked_at) })}</p>` : ''}`;
}

function uploadField(ctx) {
  return h`<div class="upload" data-upload>
    <label>${ctx.t('upload.label')}
      <input type="file" accept="image/*" data-upload-input>
      <span class="small muted">${ctx.t('upload.hint')}</span>
    </label>
    <input type="hidden" name="image_data" data-upload-data>
    <img alt="" data-upload-preview hidden>
  </div>`;
}

export function adminListPage(ctx, { list, allItems: everything, allGuests, baseUrl, adminNames = {}, sourceOwner = '', changedIds = new Set() }) {
  const allItems = everything.filter((i) => !i.pending);
  const pending = everything.filter((i) => i.pending);
  const toBuy = allItems.filter((i) => i.reserved_name && i.reserved_buyer === 'us'); // asked us to buy it
  return layout(ctx, {
    title: list.title,
    body: h`
${adminHeader(ctx, '/admin/lists', `← ${ctx.t('nav.lists')}`)}
${pageHead(ctx, h`${list.title} ${list.archived ? h`<span class="badge">${ctx.t('admin.archivedBadge')}</span>` : ''}
  ${list.visibility === 'private' ? h`<span class="badge private">🔒 ${ctx.t('give.private')}</span>` : ''}`, null, [
  { href: `/admin/lists/${list.id}/edit`, label: ctx.t('admin.editList') },
  { post: `/admin/lists/${list.id}/new-link`, label: ctx.t('admin.newLink'), confirm: ctx.t('admin.newLinkConfirm') },
  { post: `/admin/lists/${list.id}/delete`, label: ctx.t('admin.deleteList'), confirm: ctx.t('admin.deleteListConfirm'), danger: true },
])}
${list.source_wishlist_id ? h`<p class="small muted">🎀 ${ctx.t('wish.listFrom', { name: sourceOwner })}</p>` : ''}
<section class="share card">
  <p>${ctx.t('admin.shareHint')}</p>
  <div class="copy-row">
    <input readonly value="${`${baseUrl}/l/${list.token}`}" id="share-link" aria-label="${ctx.t('admin.shareLink')}">
    <button type="button" class="primary" data-copy="#share-link" data-copied="${ctx.t('admin.copied')}">${ctx.t('admin.copy')}</button>
  </div>
</section>

<section>
  <div class="page-head"><h2>${ctx.t('admin.items')} <span class="muted small">${allItems.filter((i) => i.reserved_name).length}/${allItems.length} ${ctx.t('admin.reserved')}${toBuy.length ? ` · ${ctx.t('admin.toBuyCount', { n: toBuy.filter((i) => !i.bought_at).length })}` : ''}${toBuy.some((i) => i.bought_at) ? ` · ${ctx.t('admin.boughtCount', { n: toBuy.filter((i) => i.bought_at).length })}` : ''}</span></h2>
    <a class="button primary" href="/admin/lists/${list.id}/items/new">＋ ${ctx.t('admin.addItem')}</a></div>
  ${allItems.length ? h`
  <ul class="items admin-items" data-sortable="/admin/lists/${list.id}/order">
    ${allItems.map((it, idx) => h`<li class="item ${it.reserved_name ? 'picked' : ''}" id="item-${it.id}" data-id="${it.id}">
      ${allItems.length > 1 ? dragHandle(ctx) : ''}
      ${thumb(ctx, it, { admin: true })}
      <div class="body">
        ${itemBody(ctx, it)}
        ${previewStatus(ctx, it)}
        ${it.wishlist_item_id ? h`<p class="small muted">🎀 ${ctx.t('wish.fromWishlist')}${it.hidden ? h` · <strong>${ctx.t('wish.hiddenHere')}</strong>` : ''}${it.wish_status && it.wish_status !== 'active' ? h` · <strong class="warn">${ctx.t(`wish.removedFlag.${it.wish_removed_reason}`)}</strong>` : ''}${it.overridden ? h` · ✎ ${ctx.t('wish.editedHere')}` : ''}${changedIds.has(it.id) ? h` · <a class="warn" href="/admin/items/${it.id}">${ctx.t('wish.wishlistChangedShort')}</a>` : ''}</p>` : ''}
        <p class="status">${reservationStatus(ctx, it, adminNames, list)}</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/admin/items/${it.id}">${ctx.t('admin.edit')}</a>
        ${it.wishlist_item_id ? postButton(ctx, `/admin/items/${it.id}/hide`, it.hidden ? ctx.t('wish.unhide') : ctx.t('wish.hide'), { cls: 'secondary', extra: `<input type="hidden" name="hidden" value="${it.hidden ? '0' : '1'}">` }) : ''}
        ${reservationActions(ctx, it, `guests-${list.id}`, list)}
        ${idx > 0 ? postButton(ctx, `/admin/items/${it.id}/move`, '↑', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="up">' }) : ''}
        ${idx < allItems.length - 1 ? postButton(ctx, `/admin/items/${it.id}/move`, '↓', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="down">' }) : ''}
        ${postButton(ctx, `/admin/items/${it.id}/delete`, ctx.t('admin.delete'), { cls: 'danger', confirm: ctx.t('admin.deleteItemConfirm') })}
      </div>
    </li>`)}
  </ul>
  <datalist id="guests-${list.id}">${allGuests.map((g) => h`<option value="${g.name}"></option>`)}</datalist>` : h`<p class="empty">${ctx.t('admin.noItems')}</p>`}
</section>

${pending.length ? h`<section class="card">
  <h2>🎀 ${ctx.t('wish.newInWishlist')}</h2>
  <p class="small muted">${ctx.t('wish.newInWishlistHint')}</p>
  <ul class="plain">
    ${pending.map((it) => h`<li class="row"><span class="grow">${it.title}${it.price ? h` <span class="muted">· ${it.price}</span>` : ''}</span>
      ${postButton(ctx, `/admin/items/${it.id}/approve`, ctx.t('admin.add'), { cls: 'primary' })}
      ${postButton(ctx, `/admin/items/${it.id}/ignore`, ctx.t('wish.ignore'), { cls: 'secondary' })}</li>`)}
  </ul>
</section>` : ''}

<section class="card">
  <details>
  <summary><strong>${ctx.t('admin.guests')}</strong> <span class="muted small">(${allGuests.length})</span></summary>
  ${allGuests.length ? h`
  <table>
    <thead><tr><th>${ctx.t('login.name')}</th><th>${ctx.t('admin.picks')}</th><th>${ctx.t('admin.lastSeen')}</th><th></th></tr></thead>
    <tbody>
      ${allGuests.map((g) => h`<tr>
        <td>${g.name}</td><td>${g.pick_count}</td><td>${g.last_seen ? fmtDate(ctx, g.last_seen) : h`<span class="muted">${ctx.t('admin.notYet')}</span>`}</td>
        <td>${postButton(ctx, `/admin/guests/${g.id}/delete`, ctx.t('admin.deleteGuest'), { cls: 'link danger', confirm: ctx.t('admin.deleteGuestConfirm') })}</td>
      </tr>`)}
    </tbody>
  </table>` : h`<p class="empty">${ctx.t('admin.noGuests')}</p>`}
  </details>
</section>`,
  });
}

export function editListPage(ctx, { list, form, error }) {
  const canSetVisibility = list.owner_id == null || list.owner_id === ctx.user.id;
  return formPage(ctx, {
    title: ctx.t('admin.editList'), back: `/admin/lists/${list.id}`, backLabel: list.title, error,
    body: h`<form method="post" action="/admin/lists/${list.id}" class="stack">
    ${csrfField(ctx)}
    ${listFields(ctx, { ...list, ...(form || {}) }, { withArchived: true, canSetVisibility })}
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>`,
  });
}

export function adminItemPage(ctx, { item, list, form, error, allGuests = [], adminNames = {}, target = null, changed = [] }) {
  const v = form || item;
  // Shown outside the edit form: saving the form never changes who is bringing the gift.
  const reservation = h`<section class="card" id="reservation">
  <h2>${ctx.t('admin.reservation')}</h2>
  <p class="status">${reservationStatus(ctx, item, adminNames, list)}</p>
  <div class="actions">${reservationActions(ctx, item, `guests-${list.id}`, list)}</div>
  <datalist id="guests-${list.id}">${allGuests.map((g) => h`<option value="${g.name}"></option>`)}</datalist>
</section>`;
  // Linked to a wishlist: ideas are edited in the wishlist (every linked list follows); someone's
  // own wishlist only in this list (they never see it). The reservation is never part of the form.
  if (item.wishlist_item_id) {
    const ov = target?.ov ?? null;
    const shown = form || { ...item, notes: item.wish_notes };
    const fromWish = (k) => (ov && ov[k] != null ? h`<span class="small muted">${ctx.t('wish.inWishlist', { value: target.wi[k] || '—' })}</span>` : '');
    return layout(ctx, {
      title: ctx.t('admin.editItem'),
      body: h`
${adminHeader(ctx, `/admin/lists/${list.id}`, ctx.t('admin.backToList'))}
<section class="card">
  <h1>${ctx.t('admin.editItem')}</h1>
  <p class="muted small">${list.title}</p>
  ${!target ? h`<p class="small muted">🎀 ${ctx.t('wish.linkedEditHint')}</p>`
    : target.mode === 'wishlist' ? h`<p class="flash flash-warn" role="note">🎀 ${ctx.t('wish.editAppliesEverywhere')}</p>`
    : h`<p class="small muted">🎀 ${ctx.t('wish.editThisListOnly', { name: target.w.owner_name })}</p>
      ${item.overridden ? h`<p class="small"><span class="badge">✎ ${ctx.t('wish.editedHere')}</span></p>` : ''}
      ${changed.length ? h`<div class="flash flash-warn" role="alert">${ctx.t('wish.wishlistChanged', { fields: changed.map((k) => ctx.t(`wish.field.${k}`)).join(', ') })}
        ${postButton(ctx, `/admin/items/${item.id}/override/accept`, ctx.t('wish.acceptTheirs'), { cls: 'secondary' })}</div>` : ''}`}
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  ${target ? h`<form method="post" action="/admin/items/${item.id}" class="stack">
    ${csrfField(ctx)}
    <label>${ctx.t('admin.itemTitle')}
      <input name="title" required maxlength="200" value="${shown.title || ''}">${fromWish('title')}
    </label>
    <label>${ctx.t('admin.itemUrl')}
      <input name="url" type="url" maxlength="2000" value="${shown.url || ''}" placeholder="https://">${fromWish('url')}
      <span class="small muted">${ctx.t('wish.newLinkHint')}</span>
    </label>
    <label>${ctx.t('admin.itemNotes')}
      <input name="notes" maxlength="1000" value="${shown.notes || ''}">${fromWish('notes')}
    </label>
    <fieldset class="image-field">
      <legend>${ctx.t('preview.image')}</legend>
      <div class="image-row">
        ${thumb(ctx, item, { admin: true })}
        <div class="grow">
          <label>${ctx.t('preview.imageSource')}
            <input name="image_source" type="url" maxlength="2000" value="${target.mode === 'wishlist' ? target.wi.image_source || '' : ov?.image_source || ''}" placeholder="https://…/foto.jpg">
          </label>
          ${uploadField(ctx)}
          ${item.image_file ? h`<label class="check"><input type="checkbox" name="remove_image" value="1"> ${ctx.t('preview.remove')}</label>` : ''}
        </div>
      </div>
    </fieldset>
    <label>${ctx.t('wish.listNotes')}
      <input name="list_notes" maxlength="1000" value="${item.notes || ''}">
    </label>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  ${item.overridden ? h`<hr>${postButton(ctx, `/admin/items/${item.id}/override/reset`, ctx.t('wish.resetToWishlist'), { cls: 'secondary', confirm: ctx.t('wish.resetConfirm') })}` : ''}` : ''}
</section>
${reservation}`,
    });
  }
  return layout(ctx, {
    title: ctx.t('admin.editItem'),
    body: h`
${adminHeader(ctx, `/admin/lists/${list.id}`, ctx.t('admin.backToList'))}
<section class="card">
  <h1>${ctx.t('admin.editItem')}</h1>
  <p class="muted small">${list.title}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/items/${item.id}" class="stack">
    ${csrfField(ctx)}
    ${itemFields(ctx, v)}
    <fieldset class="image-field">
      <legend>${ctx.t('preview.image')}</legend>
      <div class="image-row">
        ${thumb(ctx, item, { admin: true })}
        <div class="grow">
          ${previewStatus(ctx, item)}
          <label>${ctx.t('preview.imageSource')}
            <input name="image_source" type="url" maxlength="2000" value="${v.image_source || ''}" placeholder="https://…/foto.jpg">
            <span class="small muted">${ctx.t('preview.imageSourceHint')}</span>
          </label>
          ${uploadField(ctx)}
          ${item.image_file ? h`<label class="check"><input type="checkbox" name="remove_image" value="1"> ${ctx.t('preview.remove')}</label>` : ''}
        </div>
      </div>
    </fieldset>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  ${item.url || item.image_source ? h`<hr>${postButton(ctx, `/admin/items/${item.id}/preview`, ctx.t('preview.refresh'), { cls: 'secondary' })}` : ''}
</section>
${reservation}`,
  });
}

// ---------- accounts ----------

function passwordFields(ctx, { current = false } = {}) {
  return h`
    ${current ? h`<label>${ctx.t('account.currentPassword')}
      <input type="password" name="current" required autocomplete="current-password">
    </label>` : ''}
    <label>${ctx.t('account.newPassword')}
      <input type="password" name="password" required minlength="8" autocomplete="new-password">
      <span class="small muted">${ctx.t('account.passwordHint')}</span>
    </label>
    <label>${ctx.t('account.confirmPassword')}
      <input type="password" name="confirm" required minlength="8" autocomplete="new-password">
    </label>`;
}

function accountFields(ctx, v) {
  return h`
    <label>${ctx.t('account.name')}
      <input name="name" required maxlength="80" value="${v.name || ''}" autocomplete="name">
    </label>
    <label>${ctx.t('account.username')}
      <input name="username" required maxlength="32" value="${v.username || ''}" autocomplete="username" autocapitalize="none" spellcheck="false">
      <span class="small muted">${ctx.t('account.usernameHint')}</span>
    </label>`;
}

/** Birthday fields (day, month, optional year), as on a person's record. */
export function birthdayFields(ctx, v = {}) {
  const months = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(ctx.lang === 'en' ? 'en-GB' : 'pt-PT', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))));
  return h`<div class="row">
        <label>${ctx.t('give.day')}
          <input name="birthday_day" inputmode="numeric" type="number" min="1" max="31" value="${v.birthday_day || ''}" size="3">
        </label>
        <label class="grow">${ctx.t('give.month')}
          <select name="birthday_month">
            <option value="">—</option>
            ${months.map((m, i) => h`<option value="${i + 1}"${Number(v.birthday_month) === i + 1 ? raw(' selected') : ''}>${m}</option>`)}
          </select>
        </label>
        <label>${ctx.t('give.yearOptional')}
          <input name="birth_year" inputmode="numeric" type="number" min="1900" max="2200" value="${v.birth_year || ''}" size="5">
        </label>
      </div>`;
}

export function profilePage(ctx, { user, profileForm, profileError, passwordError }) {
  const v = profileForm || user;
  return layout(ctx, {
    title: ctx.t('account.profile'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('account.profile')}</h1>

<section class="card">
  <h2>${ctx.t('account.details')}</h2>
  ${profileError ? h`<div class="flash flash-error" role="alert">${profileError}</div>` : ''}
  <form method="post" action="/admin/profile" class="stack">
    ${csrfField(ctx)}
    ${accountFields(ctx, v)}
    <fieldset class="group">
      <legend>🎂 ${ctx.t('account.birthday')}</legend>
      ${birthdayFields(ctx, v)}
      <span class="small muted">${ctx.t('account.birthdayHint')}</span>
    </fieldset>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
</section>

<section class="card">
  <h2>${ctx.t('account.changePassword')}</h2>
  ${passwordError ? h`<div class="flash flash-error" role="alert">${passwordError}</div>` : ''}
  <form method="post" action="/admin/profile/password" class="stack">
    ${csrfField(ctx)}
    ${passwordFields(ctx, { current: true })}
    <p class="small muted">${ctx.t('account.otherDevicesHint')}</p>
    <button type="submit" class="primary">${ctx.t('account.changePassword')}</button>
  </form>
</section>

<section class="card" id="two-factor">
  <h2>${ctx.t('tf.heading')}</h2>
  <p>${user.totp_secret ? h`<span class="pill ok">✓ ${ctx.t('tf.on')}</span>` : h`<span class="pill">${ctx.t('tf.off')}</span>`}
    ${config.require2fa ? h` <span class="small muted">${ctx.t('tf.requiredNote')}</span>` : ''}</p>
  <p class="small muted">${ctx.t('tf.intro')}</p>
  <a class="button secondary" href="/admin/profile/2fa">${user.totp_secret ? ctx.t('tf.manage') : ctx.t('tf.enable')}</a>
</section>`,
  });
}

export function notificationsPage(ctx, { user, notify, notifyErrors = [], remindersError }) {
  return layout(ctx, {
    title: ctx.t('nav.notifications'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('nav.notifications')}</h1>

${notifySection(ctx, notify, notifyErrors)}

<section class="card" id="reminders">
  <h2>${ctx.t('remind.heading')}</h2>
  <p class="small muted">${ctx.t('remind.intro', { hour: String(config.reminderHour).padStart(2, '0') })}</p>
  ${remindersError ? h`<div class="flash flash-error" role="alert">${remindersError}</div>` : ''}
  <form method="post" action="/admin/notifications/reminders" class="stack">
    ${csrfField(ctx)}
    <label>${ctx.t('remind.days')}
      <input name="reminder_days" value="${user.reminder_days.split(',').filter(Boolean).join(', ')}" placeholder="14, 3" inputmode="numeric" autocomplete="off">
      <span class="small muted">${ctx.t('remind.daysHint')}</span>
    </label>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  ${postButton(ctx, '/admin/notifications/reminders/test', ctx.t('remind.testButton'), { cls: 'secondary' })}
</section>`,
  });
}

export function usersPage(ctx, { all, invites, newLink, error, noBaseUrl = false }) {
  return layout(ctx, {
    title: ctx.t('account.admins'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('account.admins')}</h1>
${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
${noBaseUrl ? h`<div class="flash flash-warn" role="note">${ctx.t('account.noBaseUrl')}</div>` : ''}

${newLink ? h`
<section class="share card">
  <p><strong>${newLink.kind === 'invite' ? ctx.t('account.inviteReady') : ctx.t('account.resetReady', { name: newLink.user.name })}</strong></p>
  <div class="copy-row">
    <input readonly value="${newLink.url}" id="new-link" aria-label="${ctx.t('account.link')}">
    <button type="button" class="primary" data-copy="#new-link" data-copied="${ctx.t('admin.copied')}">${ctx.t('admin.copy')}</button>
  </div>
  <p class="small muted">${ctx.t('account.linkOnce')}</p>
</section>` : ''}

<table>
  <thead><tr><th>${ctx.t('account.name')}</th><th>${ctx.t('account.username')}</th><th></th></tr></thead>
  <tbody>
    ${all.map((u) => h`<tr>
      <td>${u.name}${u.id === ctx.user.id ? h` <span class="badge">${ctx.t('account.you')}</span>` : ''}${u.totp_secret ? h` <span class="badge" title="${ctx.t('tf.on')}">2FA</span>` : ''}</td>
      <td><code>${u.username}</code></td>
      <td class="row-actions">${u.id === ctx.user.id
        ? h`<a href="/admin/profile">${ctx.t('account.profile')}</a>`
        : h`${postButton(ctx, `/admin/users/${u.id}/reset-link`, ctx.t('account.resetLink'), { cls: 'link' })}
            ${u.totp_secret ? postButton(ctx, `/admin/users/${u.id}/2fa/disable`, ctx.t('tf.resetOther'), { cls: 'link', confirm: ctx.t('tf.resetOtherConfirm', { name: u.name }) }) : ''}
            ${postButton(ctx, `/admin/users/${u.id}/delete`, ctx.t('admin.delete'), { cls: 'link danger', confirm: ctx.t('account.deleteConfirm', { name: u.name }) })}`}</td>
    </tr>`)}
  </tbody>
</table>

<section class="card">
  <h2>${ctx.t('account.invite')}</h2>
  <p class="small muted">${ctx.t('account.inviteHint')}</p>
  ${postButton(ctx, '/admin/users/invite', ctx.t('account.createInvite'), { cls: 'primary' })}
  ${invites.length ? h`
  <h3>${ctx.t('account.pendingInvites')}</h3>
  <ul class="plain">
    ${invites.map((i) => h`<li>${ctx.t('account.inviteBy', { name: i.created_by_name || '—', date: fmtDate(ctx, i.created_at), until: fmtDate(ctx, i.expires_at) })}
      ${postButton(ctx, `/admin/users/invites/${i.id}/revoke`, ctx.t('account.revoke'), { cls: 'link danger' })}</li>`)}
  </ul>` : ''}
</section>`,
  });
}

export function invitePage(ctx, { token, form = {}, error }) {
  return layout(ctx, {
    title: ctx.t('account.inviteTitle'),
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${ctx.t('account.inviteTitle')}</h1>
  <p class="muted">${ctx.t('account.inviteIntro')}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/invite/${token}" class="stack">
    ${accountFields(ctx, form)}
    ${passwordFields(ctx)}
    <button type="submit" class="primary">${ctx.t('account.createAccount')}</button>
  </form>
</section>`,
  });
}

export function resetPage(ctx, { token, user, error }) {
  return layout(ctx, {
    title: ctx.t('account.resetTitle'),
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${ctx.t('account.resetTitle')}</h1>
  <p class="muted">${ctx.t('account.resetIntro', { username: user?.username ?? '' })}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/reset/${token}" class="stack">
    ${passwordFields(ctx)}
    <button type="submit" class="primary">${ctx.t('account.setPassword')}</button>
  </form>
</section>`,
  });
}

// ---------- two-factor authentication ----------

function codeInput(ctx, { autofocus = true, recovery = false } = {}) {
  return h`<label>${recovery ? ctx.t('tf.codeOrRecovery') : ctx.t('tf.code')}
    <input name="code" required inputmode="${recovery ? 'text' : 'numeric'}" autocomplete="one-time-code" maxlength="12" autocapitalize="none" spellcheck="false"${autofocus ? raw(' autofocus') : ''}>
  </label>`;
}

export function twoFactorLoginPage(ctx, { error } = {}) {
  return layout(ctx, {
    title: ctx.t('tf.heading'),
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <img class="logo" src="/favicon.svg" alt="" width="72" height="72">
  <h1>${ctx.t('tf.loginTitle')}</h1>
  <p class="muted">${ctx.t('tf.loginIntro')}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/login/2fa" class="stack">
    ${codeInput(ctx, { recovery: true })}
    <button type="submit" class="primary">${ctx.t('login.submit')}</button>
  </form>
  <p class="small muted">${ctx.t('tf.lostPhone')}</p>
</section>`,
  });
}

export function twoFactorSetupPage(ctx, { secret, qr, required, error }) {
  const grouped = secret.match(/.{1,4}/g).join(' ');
  return layout(ctx, {
    title: ctx.t('tf.heading'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('tf.setupTitle')}</h1>
${required ? h`<div class="flash flash-error" role="alert">${ctx.t('tf.requiredFlash')}</div>` : ''}
${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
<section class="card">
  <ol class="steps">
    <li>${ctx.t('tf.step1')}</li>
    <li>${ctx.t('tf.step2')}
      <div class="qr">${raw(qr)}</div>
      <details><summary class="small">${ctx.t('tf.cantScan')}</summary>
        <p class="small">${ctx.t('tf.manualKey')}</p>
        <p><code class="secret">${grouped}</code></p>
      </details>
    </li>
    <li>${ctx.t('tf.step3')}
      <form method="post" action="/admin/profile/2fa/confirm" class="stack">
        ${csrfField(ctx)}
        ${codeInput(ctx)}
        <button type="submit" class="primary">${ctx.t('tf.activate')}</button>
      </form>
    </li>
  </ol>
</section>`,
  });
}

export function twoFactorManagePage(ctx, { remaining, required, error }) {
  return layout(ctx, {
    title: ctx.t('tf.heading'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('tf.heading')} <span class="pill ok">✓ ${ctx.t('tf.on')}</span></h1>
${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
<section class="card">
  <h2>${ctx.t('tf.recoveryHeading')}</h2>
  <p>${ctx.t('tf.recoveryLeft', { n: remaining })}</p>
  <form method="post" action="/admin/profile/2fa/recovery" class="stack">
    ${csrfField(ctx)}
    ${codeInput(ctx, { autofocus: false })}
    <button type="submit" class="secondary">${ctx.t('tf.newRecovery')}</button>
  </form>
</section>
<section class="card">
  <h2>${ctx.t('tf.disableHeading')}</h2>
  ${required ? h`<p class="small muted">${ctx.t('tf.requiredCantDisable')}</p>` : h`
  <form method="post" action="/admin/profile/2fa/disable" class="stack">
    ${csrfField(ctx)}
    <label>${ctx.t('account.currentPassword')}
      <input type="password" name="password" required autocomplete="current-password">
    </label>
    ${codeInput(ctx, { autofocus: false, recovery: true })}
    <button type="submit" class="danger">${ctx.t('tf.disable')}</button>
  </form>`}
</section>
<p><a href="/admin/profile">← ${ctx.t('account.profile')}</a></p>`,
  });
}

export function recoveryCodesPage(ctx, { codes, justEnabled = false }) {
  return layout(ctx, {
    title: ctx.t('tf.recoveryHeading'),
    body: h`
${adminHeader(ctx)}
${justEnabled ? h`<div class="flash flash-success" role="status">${ctx.t('tf.enabledDone')}</div>` : ''}
<h1>${ctx.t('tf.recoveryHeading')}</h1>
<section class="card">
  <p><strong>${ctx.t('tf.saveTheseCodes')}</strong></p>
  <ul class="recovery-codes">${codes.map((c) => h`<li><code>${c}</code></li>`)}</ul>
  <p class="small muted">${ctx.t('tf.codesOnce')}</p>
  <a class="button primary" href="/admin/profile">${ctx.t('tf.savedContinue')}</a>
</section>`,
  });
}

export function errorPage(ctx, message) {
  return layout(ctx, {
    bodyClass: 'center',
    body: h`<section class="card narrow"><h1>🙈</h1><p>${message}</p><p><a href="/">${ctx.t('error.home')}</a></p></section>`,
  });
}

// Shared building blocks for other view modules (givingViews.js).
export { layout, csrfField, postButton, adminHeader, uploadField, initials };
