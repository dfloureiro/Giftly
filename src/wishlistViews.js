// Views for personal wishlists. The owner's page shows NOTHING about reservations.
import { h, raw, layout, csrfField, postButton, adminHeader, uploadField } from './views.js';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function wishNav(ctx, active) {
  const tab = (href, key, name) => h`<a href="${href}" class="subtab${active === name ? ' active' : ''}"${active === name ? raw(' aria-current="page"') : ''}>${ctx.t(key)}</a>`;
  return h`<nav class="subnav">
    ${tab('/admin/wishlist', 'wish.mine', 'mine')}
    ${tab('/admin/wishlists', 'wish.others', 'others')}
  </nav>`;
}

const page = (ctx, { title, active, body }) => layout(ctx, { title, body: h`${adminHeader(ctx)}${wishNav(ctx, active)}${body}` });

function wishThumb(it) {
  if (it.image_file) return h`<div class="thumb"><img src="/img/${it.image_file}" alt="" loading="lazy"></div>`;
  const pending = it.preview_status === 'pending';
  return h`<div class="thumb empty${pending ? ' pending' : ''}"${pending ? h` data-preview-id="${it.id}" data-preview-kind="wish"` : ''} aria-hidden="true">🎁</div>`;
}

function wishBody(ctx, it) {
  return h`
    <h3>${it.title}</h3>
    ${it.notes ? h`<p class="notes">${it.notes}</p>` : ''}
    <div class="meta">
      ${it.price ? h`<span class="price" title="${ctx.t('price.fromShop')}">${it.price}</span>` : ''}
      ${it.url ? h`<a href="${it.url}" target="_blank" rel="noopener noreferrer nofollow">${ctx.t('list.visit', { host: hostOf(it.url) })} ↗</a>` : ''}
    </div>`;
}

function itemFields(ctx, v = {}) {
  return h`
    <label>${ctx.t('admin.itemTitle')}
      <input name="title" required maxlength="200" value="${v.title || ''}">
    </label>
    <label>${ctx.t('admin.itemUrl')}
      <input name="url" type="url" maxlength="2000" value="${v.url || ''}" placeholder="https://">
    </label>
    <label>${ctx.t('admin.itemNotes')}
      <input name="notes" maxlength="1000" value="${v.notes || ''}" placeholder="${ctx.t('admin.itemNotesPlaceholder')}">
    </label>`;
}

// ---------- my wishlist ----------

export function ownWishlistPage(ctx, { wishlist, active, history, error, form }) {
  return page(ctx, {
    title: ctx.t('wish.mine'),
    active: 'mine',
    body: h`
<h1>${ctx.t('wish.mineTitle')}</h1>
<p class="small muted">${ctx.t('wish.mineIntro')}</p>

${active.length ? h`<ul class="items admin-items">
  ${active.map((it, idx) => h`<li class="item" id="wish-${it.id}">
    ${wishThumb(it)}
    <div class="body">${wishBody(ctx, it)}
      ${it.preview_status === 'pending' ? h`<p class="small muted" data-preview-status="${it.id}">${ctx.t('preview.pending')}</p>` : ''}
    </div>
    <div class="actions">
      ${idx > 0 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↑', { cls: 'icon', extra: '<input type="hidden" name="dir" value="up">' }) : ''}
      ${idx < active.length - 1 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↓', { cls: 'icon', extra: '<input type="hidden" name="dir" value="down">' }) : ''}
      <details class="edit">
        <summary class="button secondary">${ctx.t('admin.edit')}</summary>
        <form method="post" action="/admin/wishlist/items/${it.id}" class="stack">
          ${csrfField(ctx)}
          ${itemFields(ctx, it)}
          ${uploadField(ctx)}
          <label>${ctx.t('preview.imageSource')}
            <input name="image_source" type="url" maxlength="2000" value="${it.image_source || ''}" placeholder="https://…/foto.jpg">
          </label>
          ${it.image_file ? h`<label class="check"><input type="checkbox" name="remove_image" value="1"> ${ctx.t('preview.remove')}</label>` : ''}
          <button type="submit" class="primary">${ctx.t('admin.save')}</button>
        </form>
        ${it.url ? postButton(ctx, `/admin/wishlist/items/${it.id}/preview`, ctx.t('preview.refresh'), { cls: 'link small' }) : ''}
      </details>
      <details class="edit">
        <summary class="button danger">${ctx.t('wish.remove')}</summary>
        <form method="post" action="/admin/wishlist/items/${it.id}/remove" class="stack">
          ${csrfField(ctx)}
          <fieldset class="group">
            <legend>${ctx.t('wish.removeWhy')}</legend>
            <label class="check"><input type="radio" name="reason" value="bought" required> ${ctx.t('wish.reason.bought')}</label>
            <label class="check"><input type="radio" name="reason" value="unwanted"> ${ctx.t('wish.reason.unwanted')}</label>
            <label class="check"><input type="radio" name="reason" value="received"> ${ctx.t('wish.reason.received')}</label>
          </fieldset>
          <button type="submit" class="danger">${ctx.t('wish.remove')}</button>
        </form>
      </details>
    </div>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t('wish.empty')}</p>`}

<section class="card">
  <h2>${ctx.t('admin.addItem')}</h2>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/wishlist/items" class="stack">
    ${csrfField(ctx)}
    ${itemFields(ctx, form)}
    ${uploadField(ctx)}
    <button type="submit" class="primary">${ctx.t('admin.add')}</button>
  </form>
</section>

<section class="card">
  <h2>${ctx.t('give.visibility')}</h2>
  <form method="post" action="/admin/wishlist/visibility" class="row">
    ${csrfField(ctx)}
    <label class="grow">
      <select name="visibility">
        <option value="admins"${wishlist.visibility === 'admins' ? raw(' selected') : ''}>${ctx.t('wish.vis.admins')}</option>
        <option value="private"${wishlist.visibility === 'private' ? raw(' selected') : ''}>${ctx.t('wish.vis.private')}</option>
      </select>
    </label>
    <button type="submit" class="secondary">${ctx.t('admin.save')}</button>
  </form>
</section>

${history.length ? h`<section>
  <details>
    <summary><strong>${ctx.t('wish.history')}</strong> <span class="muted small">(${history.length})</span></summary>
    <ul class="plain">
      ${history.map((it) => h`<li class="row"><span class="grow">${it.title} <span class="muted small">· ${ctx.t(`wish.reason.${it.removed_reason}`)}</span></span>
        ${postButton(ctx, `/admin/wishlist/items/${it.id}/restore`, ctx.t('wish.restore'), { cls: 'link small' })}</li>`)}
    </ul>
  </details>
</section>` : ''}`,
  });
}

// ---------- other admins' wishlists ----------

export function othersIndexPage(ctx, { list }) {
  return page(ctx, {
    title: ctx.t('wish.others'),
    active: 'others',
    body: h`
<h1>${ctx.t('wish.others')}</h1>
${list.length ? h`<ul class="lists">
  ${list.map((w) => h`<li><a href="/admin/wishlists/${w.id}"><strong>${ctx.t('wish.ofName', { name: w.owner_name })}</strong>
    <span class="small muted">${ctx.t('wish.itemCount', { n: w.item_count })}</span></a></li>`)}
</ul>` : h`<p class="empty">${ctx.t('wish.noOthers')}</p>`}`,
  });
}

function giveForm(ctx, w, it, choices, preselect) {
  return h`<details class="edit"${preselect ? raw(' open') : ''}>
    <summary class="button primary">${ctx.t('wish.illGive')}</summary>
    <form method="post" action="/admin/wishlists/${w.id}/items/${it.id}/give" class="stack">
      ${csrfField(ctx)}
      <label>${ctx.t('give.forOccasion')}
        <select name="occasion" required>
          ${choices.map((c) => h`<option value="${c.value}"${c.value === preselect ? raw(' selected') : ''}>${c.label.key ? ctx.t(c.label.key, c.label.vars) : c.label.text}</option>`)}
        </select>
      </label>
      ${choices.length ? '' : h`<p class="small muted">${ctx.t('wish.noGiveChoices')}</p>`}
      <p class="small muted">${ctx.t('wish.illGiveHint', { name: w.owner_name })}</p>
      <button type="submit" class="primary">${ctx.t('wish.illGive')}</button>
    </form>
  </details>`;
}

export function othersWishlistPage(ctx, { wishlist: w, items, choices, preselect, linkedLists }) {
  return page(ctx, {
    title: ctx.t('wish.ofName', { name: w.owner_name }),
    active: 'others',
    body: h`
<h1>${ctx.t('wish.ofName', { name: w.owner_name })}</h1>
<p class="small muted">${ctx.t('wish.othersIntro', { name: w.owner_name })}</p>
<p><a class="button secondary" href="/admin/wishlists/${w.id}/new-list">＋ ${ctx.t('wish.createList')}</a></p>
${linkedLists.length ? h`<p class="small">${ctx.t('wish.yourLists')}: ${linkedLists.map((l, i) => h`${i ? ', ' : ''}<a href="/admin/lists/${l.id}">${l.title}</a>`)}</p>` : ''}

${items.length ? h`<ul class="items admin-items">
  ${items.map((it) => h`<li class="item${it.claimed ? ' picked' : ''}" id="wish-${it.id}">
    ${wishThumb(it)}
    <div class="body">${wishBody(ctx, it)}
      <p class="status">${it.my_gift_id
        ? h`🎁 <strong>${ctx.t('wish.youGive')}</strong>`
        : it.claimed ? h`<span class="muted">🎀 ${ctx.t('wish.alreadyChosen')}</span>` : h`<span class="muted">${ctx.t('admin.free')}</span>`}</p>
    </div>
    <div class="actions">
      ${it.claimed ? '' : giveForm(ctx, w, it, choices, preselect)}
    </div>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t('wish.emptyOther', { name: w.owner_name })}</p>`}`,
  });
}

export function newListPage(ctx, { wishlist: w, items, error }) {
  return page(ctx, {
    title: ctx.t('wish.createList'),
    active: 'others',
    body: h`
<h1>${ctx.t('wish.createList')}</h1>
<section class="card">
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <p class="small muted">${ctx.t('wish.createListHint', { name: w.owner_name })}</p>
  <form method="post" action="/admin/wishlists/${w.id}/new-list" class="stack">
    ${csrfField(ctx)}
    <label>${ctx.t('admin.listTitle')}
      <input name="title" required maxlength="120" value="${ctx.t('wish.defaultListTitle', { name: w.owner_name })}">
    </label>
    <label>${ctx.t('admin.description')}
      <textarea name="description" rows="2" maxlength="2000"></textarea>
    </label>
    <fieldset class="group">
      <legend>${ctx.t('wish.whichItems')}</legend>
      ${items.map((it) => h`<label class="check"><input type="checkbox" name="items" value="${it.id}" checked> ${it.title}${it.price ? h` <span class="muted small">· ${it.price}</span>` : ''}</label>`)}
    </fieldset>
    <label class="check"><input type="checkbox" name="auto_add_new" value="1" checked> ${ctx.t('wish.autoAdd')}</label>
    <label>${ctx.t('give.visibility')}
      <select name="visibility">
        <option value="private" selected>${ctx.t('lists.vis.private')}</option>
        <option value="shared">${ctx.t('wish.vis.sharedExceptOwner', { name: w.owner_name })}</option>
      </select>
    </label>
    <button type="submit" class="primary">${ctx.t('admin.create')}</button>
  </form>
</section>`,
  });
}
