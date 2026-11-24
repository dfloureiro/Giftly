// Views for personal wishlists. The owner's page shows NOTHING about reservations.
import { h, raw, layout, csrfField, postButton, adminHeader, uploadField, dragHandle, pageHead, formPage } from './views.js';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const page = (ctx, { title, body }) => layout(ctx, { title, body: h`${adminHeader(ctx)}${body}` });

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

function editForm(ctx, it) {
  return h`<details class="edit">
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
      </details>`;
}

/** `forPerson`: someone else's wishlist ("they already have it"), else your own ("I bought it"). */
function removeForm(ctx, it, forPerson = false) {
  const r = (k) => ctx.t(forPerson ? `wish.reasonFor.${k}` : `wish.reason.${k}`);
  return h`<details class="edit">
        <summary class="button danger">${ctx.t('wish.remove')}</summary>
        <form method="post" action="/admin/wishlist/items/${it.id}/remove" class="stack">
          ${csrfField(ctx)}
          <fieldset class="group">
            <legend>${ctx.t('wish.removeWhy')}</legend>
            <label class="check"><input type="radio" name="reason" value="bought" required> ${r('bought')}</label>
            <label class="check"><input type="radio" name="reason" value="unwanted"> ${r('unwanted')}</label>
            <label class="check"><input type="radio" name="reason" value="received"> ${r('received')}</label>
          </fieldset>
          <button type="submit" class="danger">${ctx.t('wish.remove')}</button>
        </form>
      </details>`;
}

// ---------- my wishlist ----------

export function ownWishlistPage(ctx, { wishlist, active, history, error }) {
  return page(ctx, {
    title: ctx.t('wish.mine'),
    body: h`
${pageHead(ctx, ctx.t('wish.mineTitle'), { href: '/admin/wishlist/new', label: ctx.t('wish.addToWishlist') })}
<p class="small muted">${ctx.t('wish.mineIntro')}</p>
${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}

${active.length ? h`<ul class="items admin-items" data-sortable="/admin/wishlist/order">
  ${active.map((it, idx) => h`<li class="item" id="wish-${it.id}" data-id="${it.id}">
    ${active.length > 1 ? dragHandle(ctx) : ''}
    ${wishThumb(it)}
    <div class="body">${wishBody(ctx, it)}
      ${it.preview_status === 'pending' ? h`<p class="small muted" data-preview-status="${it.id}">${ctx.t('preview.pending')}</p>` : ''}
    </div>
    <div class="actions">
      ${idx > 0 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↑', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="up">' }) : ''}
      ${idx < active.length - 1 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↓', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="down">' }) : ''}
      ${editForm(ctx, it)}
      ${removeForm(ctx, it)}
    </div>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t('wish.empty')}</p>`}

<section class="card">
  <h2>${ctx.t('give.visibility')}</h2>
  <form method="post" action="/admin/wishlist/visibility" class="row">
    ${csrfField(ctx)}
    <label class="grow">
      <select name="visibility">
        <option value="shared"${wishlist.visibility === 'shared' ? raw(' selected') : ''}>${ctx.t('wish.vis.admins')}</option>
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

export function newWishPage(ctx, { form = {}, error }) {
  return formPage(ctx, {
    title: ctx.t('wish.addToWishlist'), back: '/admin/wishlist', backLabel: ctx.t('wish.mineTitle'), error,
    body: h`<form method="post" action="/admin/wishlist/items" class="stack">
    ${csrfField(ctx)}
    ${itemFields(ctx, form)}
    ${uploadField(ctx)}
    <button type="submit" class="primary">${ctx.t('admin.add')}</button>
  </form>`,
  });
}

// ---------- other admins' wishlists and ideas (on the person's page) ----------

function giveForm(ctx, w, it, choices, preselect, back = '', pick = null) {
  // Opened from an occasion: one tap, the occasion is already chosen.
  if (pick) {
    return h`<form method="post" action="/admin/wishlists/${w.id}/items/${it.id}/give" class="give-now">
      ${csrfField(ctx)}<input type="hidden" name="occasion" value="${pick.value}">${back ? h`<input type="hidden" name="back" value="${back}">` : ''}
      <button type="submit" class="primary">🎁 ${ctx.t('wish.illGive')}</button>
    </form>`;
  }
  return h`<details class="edit"${preselect ? raw(' open') : ''}>
    <summary class="button">${ctx.t('wish.illGive')}</summary>
    <form method="post" action="/admin/wishlists/${w.id}/items/${it.id}/give" class="stack">
      ${csrfField(ctx)}${back ? h`<input type="hidden" name="back" value="${back}">` : ''}
      <label>${ctx.t('give.forOccasion')}
        <select name="occasion" required>
          ${choices.map((c) => h`<option value="${c.value}"${c.value === preselect ? raw(' selected') : ''}>${c.label.key ? ctx.t(c.label.key, c.label.vars) : c.label.text}</option>`)}
        </select>
      </label>
      ${choices.length ? '' : h`<p class="small muted">${ctx.t('wish.noGiveChoices')}</p>`}
      <p class="small muted">${ctx.t(w.kind === 'ideas' && w.owner_id ? 'wish.illGiveHintPrivate' : 'wish.illGiveHintPerson', { name: w.owner_name })}</p>
      <button type="submit" class="primary">${ctx.t('wish.illGive')}</button>
    </form>
  </details>`;
}

/**
 * A wishlist seen by someone who is NOT its recipient: what's taken, "I'll give it", and
 * "create a list". `editable` (ideas) adds edit/remove/reorder; `addForm` the "add an idea" form
 * (with "only me" for the admin's private ideas).
 */
export function wishSection(ctx, { w, items, choices = [], preselect = '', lists = [], editable = false, personId = null, back = '', history = [], banner = true, addForm = false, createList = true }) {
  // Coming from an occasion ("pick from the wishlist"): a banner, one-tap buttons, back to it after.
  const pick = choices.find((c) => c.value === preselect) ?? null;
  const pickBack = pick?.value.startsWith('occasion:') ? `/admin/give/occasions/${pick.value.split(':')[1]}` : back;
  const sortable = editable && items.length > 1 && !pick;
  return h`
${pick && banner ? h`<div class="pick-banner">
  <span>🎁 ${ctx.t('wish.pickingFor')} <strong>${pick.label.key ? ctx.t(pick.label.key, pick.label.vars) : pick.label.text}</strong></span>
  ${pickBack !== back ? h`<a class="small" href="${pickBack}">← ${ctx.t('wish.pickBack')}</a>` : ''}
</div>` : ''}
${createList || lists.length ? h`<p class="row">
  ${createList ? h`<a class="button secondary" href="/admin/wishlists/${w.id}/new-list">＋ ${ctx.t('wish.createList')}</a>` : ''}
  ${lists.length ? h`<span class="small">${ctx.t('wish.yourLists')}: ${lists.map((l, i) => h`${i ? ', ' : ''}<a href="/admin/lists/${l.id}">${l.title}</a>`)}</span>` : ''}
</p>` : ''}
${items.length ? h`<ul class="items admin-items"${sortable ? h` data-sortable="/admin/wishlist/order" data-sortable-extra="wishlist_id=${w.id}"` : ''}>
  ${items.map((it, idx) => h`<li class="item${it.claimed ? ' picked' : ''}" id="wish-${it.id}" data-id="${it.id}">
    ${sortable ? dragHandle(ctx) : ''}
    ${wishThumb(it)}
    <div class="body">${wishBody(ctx, it)}
      <p class="status">${it.my_gift_id
        ? h`🎁 <strong>${ctx.t('wish.youGive')}</strong>`
        : it.claimed ? h`<span class="muted">🎀 ${ctx.t('wish.alreadyChosen')}</span>` : h`<span class="muted">${ctx.t('admin.free')}</span>`}</p>
      ${it.preview_status === 'pending' ? h`<p class="small muted" data-preview-status="${it.id}">${ctx.t('preview.pending')}</p>` : ''}
    </div>
    <div class="actions">
      ${it.claimed ? '' : giveForm(ctx, w, it, choices, preselect, pick ? pickBack : back, pick)}
      ${editable && !pick ? h`
        ${idx > 0 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↑', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="up">' }) : ''}
        ${idx < items.length - 1 ? postButton(ctx, `/admin/wishlist/items/${it.id}/move`, '↓', { cls: 'icon move', extra: '<input type="hidden" name="dir" value="down">' }) : ''}
        ${editForm(ctx, it)}
        ${removeForm(ctx, it, true)}` : ''}
    </div>
  </li>`)}
</ul>` : h`<p class="empty">${ctx.t(w.kind === 'ideas' ? 'wish.noIdeasYet' : 'wish.emptyOther', { name: w.owner_name })}</p>`}
${addForm ? h`<details class="add-gift add-wish">
  <summary>＋ ${ctx.t('wish.addIdea')}</summary>
  <form method="post" action="/admin/wishlist/items" class="stack">
    ${csrfField(ctx)}<input type="hidden" name="person_id" value="${personId}">
    ${itemFields(ctx)}
    ${uploadField(ctx)}
    <label class="check"><input type="checkbox" name="private" value="1"> 🔒 ${ctx.t('wish.onlyMe')}</label>
    <button type="submit" class="primary">${ctx.t('admin.add')}</button>
  </form>
</details>` : ''}
${editable && history.length ? h`<details>
  <summary class="small">${ctx.t('wish.history')} (${history.length})</summary>
  <ul class="plain">${history.map((it) => h`<li class="row"><span class="grow">${it.title} <span class="muted small">· ${ctx.t(`wish.reason.${it.removed_reason}`)}</span></span>
    ${postButton(ctx, `/admin/wishlist/items/${it.id}/restore`, ctx.t('wish.restore'), { cls: 'link small' })}</li>`)}</ul>
</details>` : ''}`;
}

/** "Maria's wishlist" (hers), "Ideas for Maria" (kept by the admins) or "Your private ideas for Maria". */
export const wishTitle = (ctx, w) => ctx.t(w.kind === 'own' ? 'wish.ofName' : w.owner_id ? 'wish.myPrivateIdeas' : 'wish.ideasFor', { name: w.owner_name });

export function newListPage(ctx, { wishlist: w, groups, error }) {
  const onlyPrivate = groups.some((g) => g.w.kind === 'ideas' && g.w.owner_id);
  return page(ctx, {
    title: ctx.t('wish.createList'),
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
    ${groups.map((g) => h`<fieldset class="group">
      <legend>${groups.length > 1 ? wishTitle(ctx, g.w) : ctx.t('wish.whichItems')}</legend>
      ${g.items.length ? g.items.map((it) => h`<label class="check"><input type="checkbox" name="items" value="${it.id}" checked> ${it.title}${it.price ? h` <span class="muted small">· ${it.price}</span>` : ''}</label>`)
        : h`<p class="small muted">${ctx.t('wish.emptyOther', { name: g.w.owner_name })}</p>`}
    </fieldset>`)}
    <label class="check"><input type="checkbox" name="auto_add_new" value="1" checked> ${ctx.t('wish.autoAdd')}</label>
    ${onlyPrivate ? h`<p class="small muted">🔒 ${ctx.t('wish.privateListOnly')}</p><input type="hidden" name="visibility" value="private">` : h`<label>${ctx.t('give.visibility')}
      <select name="visibility">
        <option value="private" selected>${ctx.t('lists.vis.private')}</option>
        <option value="shared">${ctx.t('wish.vis.sharedExceptOwner', { name: w.owner_name })}</option>
      </select>
    </label>`}
    <button type="submit" class="primary">${ctx.t('admin.create')}</button>
  </form>
</section>`,
  });
}
