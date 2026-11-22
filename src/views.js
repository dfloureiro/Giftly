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

const csrfField = (ctx) => h`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;

/** A one-button POST form. */
function postButton(ctx, action, label, { confirm, cls = '', extra = '' } = {}) {
  return h`<form method="post" action="${action}" class="inline"${confirm ? h` data-confirm="${confirm}"` : ''}>
    ${csrfField(ctx)}${raw(extra)}<button type="submit" class="${cls}">${label}</button></form>`;
}

function flash(ctx) {
  if (!ctx.flash) return '';
  return h`<div class="flash flash-${ctx.flash.type}" role="status">${ctx.flash.text}</div>`;
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
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css?v=3">
<script src="/static/app.js?v=3" defer></script>
</head>
<body class="${bodyClass}">
<nav class="lang" aria-label="Language">
  ${[['pt', 'PT'], ['en', 'EN']].map(([code, label]) => code === ctx.lang
    ? h`<strong aria-current="true">${label}</strong>`
    : h`<a href="/lang?to=${code}&amp;back=${encodeURIComponent(ctx.url.pathname)}" hreflang="${code}" lang="${code}">${label}</a>`)}
</nav>
<main class="wrap">
${flash(ctx)}
${body}
</main>
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
  <div class="logo" aria-hidden="true">🎁</div>
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

export function joinPage(ctx, { list, name = '', error } = {}) {
  return layout(ctx, {
    title: list.title,
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <div class="logo" aria-hidden="true">🎁</div>
  <h1>${list.title}</h1>
  ${list.description ? h`<p class="description">${list.description}</p>` : ''}
  <p class="muted">${ctx.t('join.intro')}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/l/${list.token}/join" class="stack">
    <label>${ctx.t('login.name')}
      <input name="name" required maxlength="60" autocomplete="name" value="${name}" placeholder="${ctx.t('login.namePlaceholder')}" autofocus>
    </label>
    <button type="submit" class="primary">${ctx.t('login.submit')}</button>
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
    ${it.notes ? h`<p class="notes">${it.notes}</p>` : ''}
    <div class="meta">
      ${it.price ? h`<span class="price" title="${ctx.t('price.fromShop')}">${it.price}</span>` : ''}
      ${it.url ? h`<a href="${it.url}" target="_blank" rel="noopener noreferrer nofollow">${ctx.t('list.visit', { host })} ↗</a>` : ''}
    </div>`;
}

export function guestListPage(ctx, { list, guest, available, mine, takenByOthers, total }) {
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
    ${mine.map((it) => h`<li class="item picked">
      ${thumb(ctx, it)}
      <div class="body">${itemBody(ctx, it)}</div>
      ${postButton(ctx, `/l/${list.token}/unpick/${it.id}`, ctx.t('list.unpick'), { cls: 'secondary', confirm: ctx.t('list.unpickConfirm', { title: it.title }) })}
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
      ${postButton(ctx, `/l/${list.token}/pick/${it.id}`, ctx.t('list.pick'), { cls: 'primary', confirm: ctx.t('list.pickConfirm', { title: it.title }) })}
    </li>`)}
  </ul>` : h`<p class="empty">${total ? ctx.t('list.none') : ctx.t('list.empty')}</p>`}
</section>`,
  });
}

// ---------- admin pages ----------

export function adminLoginPage(ctx, { error } = {}) {
  return layout(ctx, {
    title: ctx.t('admin.title'),
    bodyClass: 'center',
    body: h`
<section class="card narrow">
  <h1>${ctx.t('admin.login')}</h1>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/login" class="stack">
    <label>${ctx.t('admin.password')}
      <input type="password" name="password" required autocomplete="current-password" autofocus>
    </label>
    <button type="submit" class="primary">${ctx.t('login.submit')}</button>
  </form>
</section>`,
  });
}

function adminHeader(ctx, backHref, backLabel) {
  return h`<header class="top admin-top">
  <div>${backHref ? h`<a href="${backHref}" class="back">${backLabel}</a>` : h`<strong>${ctx.t('admin.title')}</strong>`}</div>
  ${postButton(ctx, '/admin/logout', ctx.t('admin.logout'), { cls: 'link' })}
</header>`;
}

function listFields(ctx, v, { withArchived = false } = {}) {
  return h`
    <label>${ctx.t('admin.listTitle')}
      <input name="title" required maxlength="120" value="${v.title || ''}" placeholder="${ctx.t('admin.listTitlePlaceholder')}">
    </label>
    <label>${ctx.t('admin.description')}
      <textarea name="description" rows="2" maxlength="2000" placeholder="${ctx.t('admin.descriptionPlaceholder')}">${v.description || ''}</textarea>
    </label>
    ${withArchived ? h`<label class="check"><input type="checkbox" name="archived" value="1"${v.archived ? raw(' checked') : ''}> ${ctx.t('admin.archived')}</label>` : ''}`;
}

export function adminDashboard(ctx, { all, form, error }) {
  return layout(ctx, {
    title: ctx.t('admin.title'),
    body: h`
${adminHeader(ctx)}
<h1>${ctx.t('admin.lists')}</h1>
${all.length ? h`
<ul class="lists">
  ${all.map((l) => h`<li class="${l.archived ? 'archived' : ''}">
    <a href="/admin/lists/${l.id}">
      <strong>${l.title}</strong>
      ${l.archived ? h`<span class="badge">${ctx.t('admin.archivedBadge')}</span>` : ''}
      <span class="small muted">${l.item_count} ${ctx.t('admin.items').toLowerCase()} (${l.reserved_count} ${ctx.t('admin.reserved')}) · ${l.guest_count} ${ctx.t('admin.guests').toLowerCase()}</span>
    </a>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t('admin.noLists')}</p>`}

<section class="card">
  <h2>${ctx.t('admin.newList')}</h2>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/lists" class="stack">
    ${csrfField(ctx)}
    ${listFields(ctx, form)}
    <button type="submit" class="primary">${ctx.t('admin.create')}</button>
  </form>
</section>`,
  });
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

export function adminListPage(ctx, { list, allItems, allGuests, baseUrl, listForm, listError, itemError }) {
  const lf = listForm || list;
  return layout(ctx, {
    title: list.title,
    body: h`
${adminHeader(ctx, '/admin', ctx.t('admin.back'))}
<h1>${list.title} ${list.archived ? h`<span class="badge">${ctx.t('admin.archivedBadge')}</span>` : ''}</h1>
<section class="share card">
  <p>${ctx.t('admin.shareHint')}</p>
  <div class="copy-row">
    <input readonly value="${`${baseUrl}/l/${list.token}`}" id="share-link" aria-label="${ctx.t('admin.shareLink')}">
    <button type="button" class="primary" data-copy="#share-link" data-copied="${ctx.t('admin.copied')}">${ctx.t('admin.copy')}</button>
  </div>
  ${postButton(ctx, `/admin/lists/${list.id}/new-link`, ctx.t('admin.newLink'), { cls: 'link small', confirm: ctx.t('admin.newLinkConfirm') })}
</section>

<section>
  <h2>${ctx.t('admin.items')} <span class="muted small">${allItems.filter((i) => i.reserved_name).length}/${allItems.length} ${ctx.t('admin.reserved')}</span></h2>
  ${allItems.length ? h`
  <ul class="items admin-items">
    ${allItems.map((it, idx) => h`<li class="item ${it.reserved_name ? 'picked' : ''}" id="item-${it.id}">
      ${thumb(ctx, it, { admin: true })}
      <div class="body">
        ${itemBody(ctx, it)}
        ${previewStatus(ctx, it)}
        <p class="status">${it.reserved_name
          ? h`🎀 ${ctx.t('admin.reservedBy', { name: it.reserved_name })} <span class="muted">· ${fmtDate(ctx, it.reserved_at)}${it.reserved_guest_id ? '' : ` · ${ctx.t('admin.manual')}`}</span>`
          : h`<span class="muted">${ctx.t('admin.free')}</span>`}</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/admin/items/${it.id}">${ctx.t('admin.edit')}</a>
        ${it.reserved_name ? postButton(ctx, `/admin/items/${it.id}/release`, ctx.t('admin.release'), { cls: 'secondary', confirm: ctx.t('admin.releaseConfirm') }) : ''}
        ${idx > 0 ? postButton(ctx, `/admin/items/${it.id}/move`, '↑', { cls: 'icon', extra: '<input type="hidden" name="dir" value="up">' }) : ''}
        ${idx < allItems.length - 1 ? postButton(ctx, `/admin/items/${it.id}/move`, '↓', { cls: 'icon', extra: '<input type="hidden" name="dir" value="down">' }) : ''}
        ${postButton(ctx, `/admin/items/${it.id}/delete`, ctx.t('admin.delete'), { cls: 'danger', confirm: ctx.t('admin.deleteItemConfirm') })}
      </div>
    </li>`)}
  </ul>` : h`<p class="empty">${ctx.t('admin.noItems')}</p>`}
</section>

<section class="card">
  <h2>${ctx.t('admin.addItem')}</h2>
  ${itemError ? h`<div class="flash flash-error" role="alert">${itemError}</div>` : ''}
  <form method="post" action="/admin/lists/${list.id}/items" class="stack">
    ${csrfField(ctx)}
    ${itemFields(ctx, {})}
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
  </details>
</section>

<section>
  <h2>${ctx.t('admin.guests')}</h2>
  ${allGuests.length ? h`
  <table>
    <thead><tr><th>${ctx.t('login.name')}</th><th>${ctx.t('admin.picks')}</th><th>${ctx.t('admin.lastSeen')}</th><th></th></tr></thead>
    <tbody>
      ${allGuests.map((g) => h`<tr>
        <td>${g.name}</td><td>${g.pick_count}</td><td>${fmtDate(ctx, g.last_seen)}</td>
        <td>${postButton(ctx, `/admin/guests/${g.id}/delete`, ctx.t('admin.deleteGuest'), { cls: 'link danger', confirm: ctx.t('admin.deleteGuestConfirm') })}</td>
      </tr>`)}
    </tbody>
  </table>` : h`<p class="empty">${ctx.t('admin.noGuests')}</p>`}
</section>

<section class="card">
  <h2>${ctx.t('admin.editList')}</h2>
  ${listError ? h`<div class="flash flash-error" role="alert">${listError}</div>` : ''}
  <form method="post" action="/admin/lists/${list.id}" class="stack">
    ${csrfField(ctx)}
    ${listFields(ctx, lf, { withArchived: true })}
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  <hr>
  ${postButton(ctx, `/admin/lists/${list.id}/delete`, ctx.t('admin.deleteList'), { cls: 'danger', confirm: ctx.t('admin.deleteListConfirm') })}
</section>`,
  });
}

export function adminItemPage(ctx, { item, list, form, error }) {
  const v = form || item;
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
    <label>${ctx.t('admin.reservedName')}
      <input name="reserved_name" maxlength="60" value="${v.reserved_name || ''}">
      <span class="small muted">${ctx.t('admin.reservedNameHint')}</span>
    </label>
    <button type="submit" class="primary">${ctx.t('admin.save')}</button>
  </form>
  ${item.url || item.image_source ? h`<hr>${postButton(ctx, `/admin/items/${item.id}/preview`, ctx.t('preview.refresh'), { cls: 'secondary' })}` : ''}
</section>`,
  });
}

export function errorPage(ctx, message) {
  return layout(ctx, {
    bodyClass: 'center',
    body: h`<section class="card narrow"><h1>🙈</h1><p>${message}</p><p><a href="/">${ctx.t('error.home')}</a></p></section>`,
  });
}
