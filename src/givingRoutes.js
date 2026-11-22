// Routes for "Gifts to give" (admin only). Every read/write goes through giving.js,
// which applies the shared/private rule for the logged-in user (ctx.user.id).
import { config } from './config.js';
import {
  people, occasions, gifts, checklist, upcoming, today, nextBirthday, validDate,
  VISIBILITIES, STATUSES,
} from './giving.js';
import { saveImageBuffer, removeImage } from './preview.js';
import { enqueuePreview, clearPreview } from './previewQueue.js';
import * as gv from './givingViews.js';

/** Price typed by hand: "12,50" / "12.5" / "€ 12" → cents, or null (empty), or NaN (invalid). */
export function parsePrice(v) {
  const s = String(v ?? '').replace(/[€$£\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '');
  if (!s) return null;
  if (!/^\d{1,7}([.,]\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s.replace(',', '.')) * 100);
}

export function registerGivingRoutes({ route, html, redirect, notFound, clean, cleanMultiline, cleanUrl }) {
  const A = { auth: 'admin' };
  const uidOf = (ctx) => ctx.user.id;

  /** `path` with a flash message (?m=…) and an optional #anchor. */
  const withMsg = (path, m, anchor = '') => {
    const [base] = path.split('#');
    return `${base}${m ? `${base.includes('?') ? '&' : '?'}m=${m}` : ''}${anchor ? `#${anchor}` : ''}`;
  };

  /** Where to go after a form: a same-section path from the form, else a default. */
  const back = (ctx, fallback) => {
    const b = String(ctx.body.back || '');
    return b.startsWith('/admin/give') && !b.startsWith('//') ? b : fallback;
  };

  // ----- overview -----

  route('GET', '/admin/give', (ctx) => {
    const uid = uidOf(ctx);
    const year = christmasYear();
    html(ctx.res, gv.overviewPage(ctx, {
      entries: upcoming(uid, 60),
      christmasYear: year,
      christmas: occasions.christmasOf(uid, year),
      hasPeople: people.list(uid).length > 0,
    }));
  }, A);

  // ----- people -----

  function personForm(body) {
    const num = (v, min, max) => {
      const n = Number(String(v ?? '').trim());
      return Number.isInteger(n) && n >= min && n <= max ? n : null;
    };
    const f = {
      name: clean(body.name, 80),
      birthday_day: num(body.birthday_day, 1, 31),
      birthday_month: num(body.birthday_month, 1, 12),
      birth_year: num(body.birth_year, 1900, 2200),
      notes: cleanMultiline(body.notes, 1000),
      gives_christmas: body.gives_christmas === '1',
      visibility: VISIBILITIES.includes(body.visibility) ? body.visibility : 'shared',
    };
    let error;
    if (!f.name) error = 'give.nameRequired';
    else if (!f.birthday_day !== !f.birthday_month) error = 'give.badBirthday';
    else if (f.birthday_day && f.birthday_day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][f.birthday_month - 1]) error = 'give.badBirthday';
    if (!f.birthday_day) f.birth_year = null;
    return { f, error };
  }

  route('GET', '/admin/give/people', (ctx) => {
    html(ctx.res, gv.peoplePage(ctx, { list: withNextBirthday(people.list(uidOf(ctx))) }));
  }, A);

  route('POST', '/admin/give/people', (ctx) => {
    const { f, error } = personForm(ctx.body);
    if (error) return html(ctx.res, gv.peoplePage(ctx, { list: withNextBirthday(people.list(uidOf(ctx))), form: f, error: ctx.t(error) }), 400);
    const id = people.create(uidOf(ctx), f);
    if (f.gives_christmas) joinCurrentChristmas(uidOf(ctx), id);
    redirect(ctx.res, `/admin/give/people/${id}?m=created`);
  }, A);

  function renderPerson(ctx, person, extra = {}, status = 200) {
    const uid = uidOf(ctx);
    const next = person.birthday_month ? nextBirthday(person.birthday_month, person.birthday_day) : null;
    html(ctx.res, gv.personPage(ctx, {
      person,
      next,
      history: gifts.forPerson(uid, person.id),
      choices: occasionChoices(uid, person, next),
      others: people.list(uid).filter((p) => p.id !== person.id),
      ...extra,
    }), status);
  }

  route('GET', '/admin/give/people/:id', (ctx) => {
    const person = people.get(uidOf(ctx), Number(ctx.params.id));
    if (!person) return notFound(ctx);
    renderPerson(ctx, person);
  }, A);

  route('POST', '/admin/give/people/:id', (ctx) => {
    const uid = uidOf(ctx);
    const person = people.get(uid, Number(ctx.params.id));
    if (!person) return notFound(ctx);
    const { f, error } = personForm(ctx.body);
    if (error) return renderPerson(ctx, person, { personForm: f, personError: ctx.t(error) }, 400);
    people.update(uid, person.id, f);
    if (f.gives_christmas && !person.gives_christmas) joinCurrentChristmas(uid, person.id);
    redirect(ctx.res, `/admin/give/people/${person.id}?m=saved`);
  }, A);

  route('POST', '/admin/give/people/:id/delete', (ctx) => {
    if (!people.delete(uidOf(ctx), Number(ctx.params.id))) return notFound(ctx);
    redirect(ctx.res, '/admin/give/people?m=deleted');
  }, A);

  // ----- occasions -----

  function christmasYear(from = today()) {
    const y = Number(from.slice(0, 4));
    return from > `${y}-12-25` ? y + 1 : y;
  }

  route('GET', '/admin/give/occasions', (ctx) => {
    const uid = uidOf(ctx);
    const list = occasions.list(uid).map((o) => {
      const c = checklist(uid, o);
      return { ...o, total: c.total, done: c.done };
    });
    html(ctx.res, gv.occasionsPage(ctx, {
      list,
      people: people.list(uid),
      christmasYear: christmasYear(),
    }));
  }, A);

  // "New Christmas": Christmas of a year, pre-filled with everyone marked "gives Christmas".
  route('POST', '/admin/give/occasions/christmas', (ctx) => {
    const uid = uidOf(ctx);
    const year = Number(ctx.body.year) || christmasYear();
    if (year < 2000 || year > 2200) return notFound(ctx);
    const existing = occasions.christmasOf(uid, year);
    if (existing) return redirect(ctx.res, `/admin/give/occasions/${existing.id}`);
    const visibility = VISIBILITIES.includes(ctx.body.visibility) ? ctx.body.visibility : 'shared';
    const ids = people.list(uid).filter((p) => p.gives_christmas).map((p) => p.id);
    const id = occasions.create(uid, { type: 'christmas', name: ctx.t('give.christmasName', { year }), date: `${year}-12-25`, visibility }, ids);
    redirect(ctx.res, `/admin/give/occasions/${id}?m=created`);
  }, A);

  function occasionForm(ctx) {
    const f = {
      name: clean(ctx.body.name, 120),
      date: clean(ctx.body.date, 10),
      visibility: VISIBILITIES.includes(ctx.body.visibility) ? ctx.body.visibility : 'shared',
    };
    let error;
    if (!f.name) error = 'give.nameRequired';
    else if (!validDate(f.date)) error = 'give.badDate';
    return { f, error };
  }

  route('POST', '/admin/give/occasions', (ctx) => {
    const uid = uidOf(ctx);
    const { f, error } = occasionForm(ctx);
    if (error) {
      return html(ctx.res, gv.occasionsPage(ctx, {
        list: occasions.list(uid), people: people.list(uid), christmasYear: christmasYear(), form: f, error: ctx.t(error),
      }), 400);
    }
    const ids = [].concat(ctx.body.people ?? []).map(Number);
    const id = occasions.create(uid, { type: 'custom', ...f }, ids);
    redirect(ctx.res, `/admin/give/occasions/${id}?m=created`);
  }, A);

  function renderChecklist(ctx, occasion, extra = {}, status = 200) {
    const uid = uidOf(ctx);
    const c = checklist(uid, occasion);
    const inList = new Set(c.rows.map((r) => r.person.id));
    html(ctx.res, gv.checklistPage(ctx, {
      occasion,
      ...c,
      onlyMissing: ctx.url.searchParams.get('missing') === '1',
      candidates: people.list(uid).filter((p) => !inList.has(p.id)),
      ...extra,
    }), status);
  }

  route('GET', '/admin/give/occasions/:id', (ctx) => {
    const occasion = occasions.get(uidOf(ctx), Number(ctx.params.id));
    if (!occasion) return notFound(ctx);
    renderChecklist(ctx, occasion);
  }, A);

  route('POST', '/admin/give/occasions/:id', (ctx) => {
    const uid = uidOf(ctx);
    const occasion = occasions.get(uid, Number(ctx.params.id));
    if (!occasion) return notFound(ctx);
    const { f, error } = occasionForm(ctx);
    if (error) return renderChecklist(ctx, occasion, { occasionForm: f, occasionError: ctx.t(error) }, 400);
    occasions.update(uid, occasion.id, f);
    redirect(ctx.res, `/admin/give/occasions/${occasion.id}?m=saved`);
  }, A);

  route('POST', '/admin/give/occasions/:id/delete', (ctx) => {
    if (!occasions.delete(uidOf(ctx), Number(ctx.params.id))) return notFound(ctx);
    redirect(ctx.res, '/admin/give/occasions?m=deleted');
  }, A);

  route('POST', '/admin/give/occasions/:id/participants', (ctx) => {
    const id = Number(ctx.params.id);
    if (!occasions.addParticipant(uidOf(ctx), id, Number(ctx.body.person_id))) return notFound(ctx);
    redirect(ctx.res, `/admin/give/occasions/${id}`);
  }, A);

  route('POST', '/admin/give/occasions/:id/participants/:pid/remove', (ctx) => {
    const id = Number(ctx.params.id);
    if (!occasions.removeParticipant(uidOf(ctx), id, Number(ctx.params.pid))) return notFound(ctx);
    redirect(ctx.res, `/admin/give/occasions/${id}`);
  }, A);

  // ----- gifts -----

  /** Occasions a gift for `person` can be attached to: next birthday + recent/upcoming occasions. */
  function occasionChoices(uid, person, next = null) {
    const out = [];
    if (next) out.push({ value: `birthday:${next.year}`, birthdayYear: next.year });
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    for (const o of occasions.list(uid).filter((o) => o.date >= since).reverse()) {
      out.push({ value: `occasion:${o.id}`, occasion: o });
    }
    return out;
  }

  /** Parse the gift form (shared by create and edit). */
  function giftForm(ctx) {
    const { url, error: urlError } = cleanUrl(ctx.body.url);
    const { url: imageSource, error: imageError } = cleanUrl(ctx.body.image_source);
    const cents = parsePrice(ctx.body.price);
    const f = {
      name: clean(ctx.body.name, 200),
      url: url ?? String(ctx.body.url ?? ''),
      notes: cleanMultiline(ctx.body.notes, 1000),
      status: STATUSES.includes(ctx.body.status) ? ctx.body.status : 'idea',
      visibility: VISIBILITIES.includes(ctx.body.visibility) ? ctx.body.visibility : 'shared',
      image_source: imageSource ?? String(ctx.body.image_source ?? ''),
      price_cents: Number.isNaN(cents) ? null : cents,
      price_currency: config.currency,
      clear_price: String(ctx.body.price ?? '').trim() === '' && ctx.body.price !== undefined,
    };
    let error;
    if (!f.name) error = 'give.nameRequired';
    else if (urlError || imageError) error = 'admin.badUrl';
    else if (Number.isNaN(cents)) error = 'give.badPrice';
    return { f, error };
  }

  function applyUpload(giftId, dataUrl) {
    const m = /^data:image\/(jpeg|png|webp|gif|avif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return false;
    let file;
    try { file = saveImageBuffer(Buffer.from(m[2], 'base64')); } catch { return false; }
    const old = gifts.raw(giftId)?.image_file;
    gifts.setPreview(giftId, { image_file: file, preview_status: 'uploaded' });
    removeImage(old);
    return true;
  }

  const giftError = (ctx, error, to) => html(ctx.res, gv.errorBack(ctx, ctx.t(error), to), 400);

  /** Other people a joint gift is also for ("also" checkboxes); only people this admin can see. */
  function alsoFor(ctx, mainId) {
    const uid = uidOf(ctx);
    return [].concat(ctx.body.also ?? []).map(Number)
      .filter((id) => id && id !== mainId && people.get(uid, id));
  }

  /** "Gives Christmas" people join this year's Christmas automatically if it exists and hasn't passed. */
  function joinCurrentChristmas(uid, personId) {
    const xmas = occasions.christmasOf(uid, christmasYear());
    if (xmas && xmas.date >= today()) occasions.addParticipant(uid, xmas.id, personId);
  }

  route('POST', '/admin/give/gifts', (ctx) => {
    const uid = uidOf(ctx);
    const person = people.get(uid, Number(ctx.body.person_id));
    if (!person) return notFound(ctx);
    const to = back(ctx, `/admin/give/people/${person.id}`);
    const { f, error } = giftForm(ctx);
    if (error) return giftError(ctx, error, to);

    // Which occasion: "birthday:<year>" or "occasion:<id>".
    const [kind, ref] = String(ctx.body.occasion || '').split(':');
    let occasionId = null;
    let year;
    if (kind === 'birthday' && Number(ref) >= 2000 && Number(ref) <= 2200) {
      year = Number(ref);
    } else if (kind === 'occasion') {
      const o = occasions.get(uid, Number(ref));
      if (!o) return notFound(ctx);
      occasionId = o.id;
      year = Number(o.date.slice(0, 4));
      occasions.addParticipant(uid, o.id, person.id); // giving a gift makes them a participant
    } else {
      return giftError(ctx, 'give.pickOccasion', to);
    }
    const also = alsoFor(ctx, person.id);
    if (occasionId) for (const pid of also) occasions.addParticipant(uid, occasionId, pid);
    const id = gifts.create(uid, { ...f, person_id: person.id, person_ids: also, occasion_id: occasionId, year });
    applyUpload(id, ctx.body.image_data);
    enqueuePreview(id, { kind: 'gift' });
    redirect(ctx.res, withMsg(to, 'giftAdded', `gift-${id}`));
  }, A);

  route('POST', '/admin/give/gifts/:id', (ctx) => {
    const uid = uidOf(ctx);
    const gift = gifts.get(uid, Number(ctx.params.id));
    if (!gift) return notFound(ctx);
    const to = back(ctx, `/admin/give/people/${gift.person_id}`);
    const { f, error } = giftForm(ctx);
    if (error) return giftError(ctx, error, to);
    if (ctx.body.remove_image === '1') f.image_source = '';
    gifts.update(uid, gift.id, f);
    if (ctx.body.also_present === '1') {
      const also = alsoFor(ctx, gift.person_id);
      gifts.setPeople(gift.id, [gift.person_id, ...also]);
      if (gift.occasion_id) for (const pid of also) occasions.addParticipant(uid, gift.occasion_id, pid);
    }
    const uploaded = applyUpload(gift.id, ctx.body.image_data);
    if (!uploaded && ctx.body.remove_image === '1') clearPreview(gift.id, 'removed', 'gift');
    if (!uploaded && f.image_source && f.image_source !== gift.image_source) enqueuePreview(gift.id, { force: true, kind: 'gift' });
    else if (f.url !== gift.url) enqueuePreview(gift.id, { kind: 'gift' });
    redirect(ctx.res, withMsg(to, 'saved', `gift-${gift.id}`));
  }, A);

  route('POST', '/admin/give/gifts/:id/status', (ctx) => {
    const uid = uidOf(ctx);
    const gift = gifts.get(uid, Number(ctx.params.id));
    if (!gift || !STATUSES.includes(ctx.body.status)) return notFound(ctx);
    gifts.setStatus(uid, gift.id, ctx.body.status);
    redirect(ctx.res, withMsg(back(ctx, `/admin/give/people/${gift.person_id}`), '', `gift-${gift.id}`));
  }, A);

  route('POST', '/admin/give/gifts/:id/preview', (ctx) => {
    const gift = gifts.get(uidOf(ctx), Number(ctx.params.id));
    if (!gift) return notFound(ctx);
    enqueuePreview(gift.id, { force: true, kind: 'gift' });
    redirect(ctx.res, withMsg(back(ctx, `/admin/give/people/${gift.person_id}`), '', `gift-${gift.id}`));
  }, A);

  route('POST', '/admin/give/gifts/:id/delete', (ctx) => {
    const gift = gifts.delete(uidOf(ctx), Number(ctx.params.id));
    if (!gift) return notFound(ctx);
    removeImage(gift.image_file);
    redirect(ctx.res, withMsg(back(ctx, `/admin/give/people/${gift.person_id}`), 'deleted'));
  }, A);
}

/** Adds { next: { date, year } } to people with a birthday, sorted by name (unchanged order). */
function withNextBirthday(list) {
  return list.map((p) => ({ ...p, next: p.birthday_month ? nextBirthday(p.birthday_month, p.birthday_day) : null }));
}
