// Tab 1: the inbox, a step-by-step trace of the message just processed, what is waiting on the
// owner, and the people from recent messages with their enquiries.
import { all, one, tx, as } from '../db.js';
import { now, mode, resolveContact, split, correct, getContact, getEnquiry, getMessage, visitOf, offersOf, canMessage, OPEN } from '../engine.js';
import { respond } from '../agent.js';
import { fmtTime, fmtDur, fmtNear, nextEvening } from '../time.js';
import { CHANNELS, SERVICES, STAGES, MODES, KINDS, fmtPhone, firstName, personLabel } from '../terms.js';
import { $, esc, beat, channelIcon, changeTracker } from '../ui.js';
import { renderQueue, queueCount, onQueueClick, RISK } from '../owner.js';
import { SAMPLES } from './samples.js';
import { SYSTEM, factsFor } from './prompt.js';
import { ingest, ready } from './match.js';

let ctx;
let selected = SAMPLES[0].id;
let openContact = null;
let recent = []; // contacts touched since the last reset, newest first
let showAll = false;
let notice = null; // { text, bad }
const done = new Set(); // samples processed since the last reset
const diff = changeTracker();

const sample = () => SAMPLES.find((s) => s.id === selected);

const INTENTS = {
  new_request: 'New request',
  follow_up: 'Follow-up',
  question: 'Question',
  choose_time: 'Picks a time',
  not_now: 'Not now',
  declined: 'Declined',
};

// Shown in the trace until the first message is processed.
const START_GUIDE = `<li class="trace-empty">
  <h3>Start here</h3>
  <ol class="start-steps">
    <li><span>Press <strong>Process</strong>. Each step appears here.</span></li>
    <li><span>Work down the inbox. Replies unlock once the message they answer is processed.</span></li>
    <li><span>Replies the agent may not send wait under <strong>Needs you</strong>. <strong>Agent mode</strong> sets how much it sends alone.</span></li>
  </ol>
  <p class="dim small">Then open <strong>Conversations &amp; bookings</strong>, and move the clock forward to see check-ins.</p>
</li>`;

export function mount(c) {
  ctx = c;
  $('#trace').innerHTML = START_GUIDE;
  select(selected);
  $('#inbox').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sample]');
    if (item && !ctx.busy) select(item.dataset.sample);
  });
  $('#process').addEventListener('click', process);
  $('#queue').addEventListener('click', onQueue);
  $('#contacts').addEventListener('click', onContacts);
  $('#trace').addEventListener('click', onTrace);
}

export function reset() {
  openContact = null;
  recent = [];
  showAll = false;
  notice = null;
  done.clear();
  diff.clear();
  $('#trace').innerHTML = START_GUIDE;
  select(SAMPLES[0].id);
}

export function refresh() {
  if (!ctx.db) return;
  renderInbox();
  renderCompose();
  renderNotice();
  renderQueuePane();
  renderContacts();
}

// ---- inbox ----

const LOCK = '<svg class="state-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="9" width="10" height="7.5" rx="1.5"/><path d="M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9"/></svg>';
const TICK = '<svg class="state-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7"/></svg>';

function renderInbox() {
  const db = ctx?.db;
  $('#inbox').innerHTML = SAMPLES.map((s) => {
    const locked = db && !ready(db, s);
    const isDone = done.has(s.id);
    const state = isDone ? `${TICK}<span class="sr-only">processed</span>` : locked ? `${LOCK}<span class="sr-only">not arrived yet</span>` : '';
    return `<li><button type="button" class="inbox-item ${isDone ? 'is-done' : ''} ${locked ? 'is-locked' : ''}" data-sample="${s.id}" aria-pressed="${s.id === selected}">
        ${channelIcon(s.channel)}
        <span class="inbox-text"><span class="inbox-title">${esc(s.title)}</span><span class="inbox-ch">${esc(CHANNELS[s.channel])}${s.reply ? ' · reply' : ''}</span></span>
        <span class="inbox-state">${state}</span>
      </button></li>`;
  }).join('');
}

function select(id) {
  selected = id;
  notice = null;
  if (ctx?.db) refresh();
  else renderInbox();
  document.querySelector(`.inbox-item[data-sample="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

const arrivalTime = (s, t) => (s.moveClock === 'evening' ? Math.max(t, nextEvening(t)) : t);

function renderCompose() {
  const db = ctx.db;
  const s = sample();
  const locked = !ready(db, s);
  $('#compose-meta').innerHTML = `${channelIcon(s.channel)}<span>${esc(CHANNELS[s.channel])}</span><span class="dim">· ${locked ? 'not arrived yet' : `arrives ${esc(fmtTime(arrivalTime(s, now(db))))}`}</span>`;
  $('#compose-hint').innerHTML = locked ? `<strong>${esc(s.after)}</strong> ${esc(s.hint)}` : esc(s.hint);
  $('#raw').value = s.raw;
  $('#process').disabled = ctx.busy || locked;
  $('#process').textContent = done.has(s.id) ? 'Process again' : 'Process';
}

// The next message worth processing after the one just done.
function nextSample() {
  const from = SAMPLES.findIndex((s) => s.id === selected);
  const order = [...SAMPLES.slice(from + 1), ...SAMPLES.slice(0, from + 1)];
  return order.find((s) => !done.has(s.id) && ready(ctx.db, s)) ?? null;
}

// ---- processing ----

async function process() {
  if (ctx.busy || !ctx.db) return;
  const db = ctx.db;
  const s = sample();
  if (!ready(db, s)) return;
  let moved = null;
  const target = arrivalTime(s, now(db));
  if (target > now(db)) {
    ctx.advanceTo(target);
    moved = target;
  }
  let res;
  try {
    res = tx(db, () => as('automation', () => ingest(db, s)));
  } catch (err) {
    notice = { text: err.message, bad: true };
    await ctx.changed();
    return;
  }
  notice = null;
  res.moved = moved;
  done.add(s.id);
  ctx.busy = true;
  $('#process').disabled = true;
  const steps = res.person === 'duplicate' ? 2 : 5;
  for (let step = 1; step <= steps; step++) {
    renderTrace(res, step);
    await beat(step === 1 ? 150 : 320);
  }
  ctx.busy = false;
  if (res.contactId) touch(res.contactId, res.person !== 'review');
  selected = nextSample()?.id ?? selected;
  await ctx.changed();
  document.querySelector(`.inbox-item[data-sample="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderNotice() {
  const el = $('#intake-notice');
  el.className = `notice ${notice?.bad ? 'bad' : ''}`;
  el.hidden = !notice;
  el.textContent = notice?.text ?? '';
}

const contactLabel = (db, id) => {
  return `<strong>${esc(personLabel(getContact(db, id)))}</strong>`;
};

// "Roofing [With agent] →", as a link to the conversation.
function enquiryLink(db, id) {
  const e = getEnquiry(db, id);
  return `<button type="button" class="enq-link" data-focus="${id}" title="Open the conversation">${esc(SERVICES[e.service] ?? 'Service unclear')}
    <span class="pill stage-${e.stage}">${esc(STAGES[e.stage])}</span><span class="enq-go" aria-hidden="true">→</span></button>`;
}

function scoreBar(score, policy) {
  return `<span class="scorebar" style="--s:${score}%;--auto:${policy.auto}%;--review:${policy.review}%" role="img" aria-label="Score ${score} of 100">
    <span class="scorebar-fill ${score >= policy.auto ? 'is-auto' : score >= policy.review ? 'is-review' : ''}"></span>
    <span class="scorebar-mark mark-review"></span><span class="scorebar-mark mark-auto"></span>
  </span>`;
}

const reasonChips = (reasons) =>
  reasons.map((r) => `<span class="chip ${r.pts > 0 ? 'pos' : r.pts < 0 ? 'neg' : ''}">${r.pts > 0 ? '+' : ''}${r.pts} ${esc(r.text)}</span>`).join('');

const CHECK_ICON = { ok: '✓', soft: '!', hard: '✕' };
const checkList = (checks) =>
  `<ul class="checks">${checks.map((c) => `<li class="ck-${c.level}"><span class="ck-icon" aria-hidden="true">${CHECK_ICON[c.level]}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>`;

function bubble(db, messageId, tag) {
  const m = getMessage(db, messageId);
  const offers = offersOf(db, messageId);
  const label = tag ?? `${m.status === 'sent' ? 'Sent' : 'Draft'} by ${m.channel === 'sms' ? 'text' : 'email'}`;
  return `<div class="bubble out${m.status === 'draft' ? ' draft' : ''}"><span class="bubble-tag">${esc(label)}</span><p class="bubble-body">${esc(m.body)}</p></div>
    ${offers.length ? '<p class="dim small">Words by the model; times from the calendar.</p>' : ''}`;
}

const sentTo = (e) =>
  e.reply_via === 'sms' ? `by text to ${fmtPhone(e.reply_to)}` : `by email to ${e.reply_to}${e.subject ? `, subject “${e.subject}”` : ''}`;

function agentBlock(db, res) {
  const a = res.agent;
  const e = getEnquiry(db, a.enquiryId);
  if (a.action === 'waiting') {
    return { status: 'warn', body: '<p>Already waiting for you. Added to the conversation; no reply.</p>' };
  }
  if (a.action === 'closed') return { status: 'done', body: '<p>Enquiry closed. Added to the conversation; no reply.</p>' };
  if (a.action === 'booked' || a.action === 'clash') {
    const pick = res.out.option;
    const offered = a.latest ? `offered in our ${a.latest.message.channel === 'sms' ? 'text' : 'email'} of ${fmtNear(a.latest.message.sent_at, res.at)}` : '';
    const checks = a.offer
      ? [{ level: 'ok', text: `Option ${pick} was ${fmtTime(a.offer.start_at)}, ${offered}` }]
      : [{ level: 'hard', text: `There was no option ${pick} in our last message` }];
    checks.push(
      a.action === 'booked'
        ? { level: 'ok', text: 'Free, still ahead and offered to this customer' }
        : { level: 'hard', text: `Refused: ${a.why}` },
    );
    const result = a.action === 'booked' ? `<p class="result ok">Booked for ${esc(fmtTime(a.offer.start_at))}</p>` : '<p class="result warn">Not booked. New times sent.</p>';
    return {
      status: a.action === 'booked' ? 'done' : 'warn',
      body: `${checkList(checks)}${result}${bubble(db, a.messageId, 'Sent automatically')}
        <p class="dim small">A fixed template; sent in every mode.</p>`,
    };
  }
  const modeLabel = MODES[mode(db)].label;
  const riskLine = `<p class="risk-line"><span class="risk-pill risk-${a.risk}">${a.risk === 'routine' ? 'Routine' : RISK[a.risk]}</span><span class="dim small">Mode: ${esc(modeLabel)}</span></p>`;
  if (a.action === 'sent') {
    const m = getMessage(db, a.messageId);
    return {
      status: 'done',
      body: `${checkList(a.checks)}${riskLine}<p class="result ok">Sent ${esc(sentTo(e))} at ${esc(fmtNear(m.sent_at, res.at))}: ${esc(KINDS[a.kind])}</p>${bubble(db, a.messageId)}`,
    };
  }
  const k = one(db, 'SELECT * FROM tasks WHERE id = ?', [a.taskId]);
  return {
    status: 'warn',
    body: `${checkList(a.checks)}${riskLine}
      <p class="result warn">Waiting for you: ${esc(k.reason)}</p>
      <p class="small">Not sent: <em>${esc(a.blocked)}</em>.</p>
      ${bubble(db, a.messageId, 'Agent’s draft, not sent')}
      <p class="dim small">${
        canMessage(e)
          ? 'A holding reply goes out after 15 business minutes.'
          : 'No holding reply or check-ins without consent.'
      }</p>`,
  };
}

const getRaw = (db, id) => one(db, 'SELECT raw FROM inbound WHERE id = ?', [id]).raw;

function renderTrace(res, upto) {
  const db = ctx.db;
  const items = [];
  const step = (n, title, status, body) =>
    items.push(`<li class="trace-step ${status}" ${n === upto ? 'data-new' : ''}><span class="ts-num">${n}</span><div class="ts-main"><h3>${title}</h3>${body}</div></li>`);
  const p = res.placement;

  const movedNote = res.moved ? `<p class="dim small">Clock moved to ${esc(fmtTime(res.moved))}. Office closed.</p>` : '';
  step(1, 'Received', 'done', `<p>${channelIcon(res.channel)} ${esc(CHANNELS[res.channel])} · ${esc(fmtTime(res.at))}</p>${movedNote}`);

  if (res.person === 'duplicate') {
    if (upto >= 2) {
      const ago = res.at - res.repeat.received_at;
      step(
        2,
        'Stopped before the agent',
        'done',
        `<p>Same text and channel as a message ${ago ? `${esc(fmtDur(ago))} earlier` : 'moments earlier'}.</p>
        <p class="result ok">Repeat delivery: recorded only</p>
        <p class="dim small">No model call, no second reply.</p>${res.enquiryId ? enquiryLink(db, res.enquiryId) : ''}`,
      );
    }
    $('#trace').innerHTML = items.join('');
    $('#trace [data-new]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  if (upto >= 2) {
    const o = res.out;
    const chips = [
      `<span class="chip">${esc(INTENTS[o.intent] ?? o.intent)}${o.option ? ` ${o.option}` : ''}</span>`,
      o.job.urgent ? '<span class="chip neg">urgent</span>' : '',
      `<span class="chip">tone: ${esc(o.tone)}</span>`,
      `<span class="chip ${o.confidence >= 0.8 ? '' : 'warn'}">confidence ${o.confidence.toFixed(2)}</span>`,
      ...o.flags.map((f) => `<span class="chip neg">${esc(f.replace(/_/g, ' '))}</span>`),
    ].join('');
    const rows = res.rows
      .filter((r) => r.read || r.value)
      .map(
        (r) => `<tr><th scope="row">${r.field}</th><td class="raw">${r.read ? esc(r.read) : '<span class="dim">—</span>'}</td>
        <td>${r.value ? esc(r.value) : '<span class="dim">—</span>'}${r.note ? `<span class="note ${r.warn ? 'warn' : ''}">${esc(r.note)}</span>` : ''}</td></tr>`,
      )
      .join('');
    const facts = factsFor({ fields: res.fields, lastSent: res.person === 'reply' ? res.thread.last.body : null });
    step(
      2,
      'Read by the agent',
      'done',
      `<div class="chips">${chips}</div>
      <p class="summary">“${esc(o.job.summary)}”</p>
      ${rows ? `<div class="table-wrap"><table class="readout"><thead><tr><th></th><th>Read</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      <details class="prompt"><summary>Prompt and answer</summary>
        <h4>Instructions</h4><pre>${esc(SYSTEM)}</pre>
        <h4>Message${facts ? ' and facts' : ''}</h4><pre>${esc(getRaw(db, res.inboundId))}${facts ? `\n\n${esc(facts)}` : ''}</pre>
        <h4>Answer <span class="dim">(saved in advance)</span></h4><pre>${esc(JSON.stringify(o, null, 2))}</pre>
      </details>`,
    );
  }

  if (upto >= 3) {
    let body;
    if (res.person === 'reply') {
      const via = res.thread.last.channel === 'sms' ? 'text' : 'email';
      body = `<p>Reply to our ${via} of ${esc(fmtNear(res.thread.last.sent_at, res.at))}.</p>
        <p class="result ok">${contactLabel(db, res.contactId)}</p>`;
    } else {
      const list = res.candidates.length
        ? `<ul class="cands">${res.candidates
            .map(
              (c) => `<li><div class="cand-head"><span>${contactLabel(db, c.contact.id)}</span><span class="cand-score mono">${c.score}</span></div>
              ${scoreBar(c.score, res.policy)}<div class="chips">${reasonChips(c.reasons)}</div></li>`,
            )
            .join('')}</ul><p class="dim small">${res.policy.auto}+ same person · ${res.policy.review}–${res.policy.auto - 1} held for you · below ${res.policy.review} someone new</p>`
        : '<p>No match on phone, email or name.</p>';
      const verdict = {
        new: `<p class="result ok">A new person: ${contactLabel(db, res.contactId)}</p>`,
        merged: `<p class="result ok">Already on file: ${contactLabel(db, res.contactId)}</p>`,
        review: `<p class="result warn">Held for you: could be ${contactLabel(db, res.contactId)}</p>`,
      }[res.person];
      body = list + verdict;
    }
    step(3, 'Who is it from?', res.person === 'review' ? 'warn' : 'done', body);
  }

  if (upto >= 4) {
    let body;
    let status = 'done';
    if (res.person === 'review') {
      status = 'wait';
      body = '<p class="dim">Waits for your decision.</p>';
    } else if (p.action === 'reply') {
      body = `<p class="result ok">Joins the conversation it answers:</p>${enquiryLink(db, p.enquiryId)}`;
    } else if (p.action === 'added') {
      const filled = p.filled.length ? `<p class="small">Fills in: <strong>${esc(p.filled.join(', '))}</strong>.</p>` : '';
      body = `<p class="result ok">Joins an open conversation:</p>${enquiryLink(db, p.enquiryId)}<p class="small">${esc(p.why)}</p>${filled}`;
    } else {
      const others = all(db, 'SELECT id FROM enquiries WHERE contact_id = ? AND id <> ? ORDER BY id', [res.contactId, p.enquiryId]);
      const list = others.length
        ? `<p class="dim small">Their other enquiries:</p><ul class="enq-list">${others.map((o) => `<li>${enquiryLink(db, o.id)}</li>`).join('')}</ul>`
        : '';
      const zip = p.zipFrom === 'contact' ? '<p class="dim small">No ZIP given; using the one on file.</p>' : '';
      body = `<p class="result ok">A new enquiry:</p>${enquiryLink(db, p.enquiryId)}<p class="small">${esc(p.why)}</p>${zip}${list}`;
    }
    step(4, 'Which conversation?', status, body);
  }

  if (upto >= 5) {
    if (res.person === 'review') {
      step(5, 'What the agent did', 'wait', '<p class="dim">Waits for your decision.</p>');
    } else {
      const { status, body } = agentBlock(db, res);
      step(5, 'What the agent did', status, body);
    }
  }
  $('#trace').innerHTML = items.join('');
  $('#trace [data-new]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function onTrace(e) {
  const b = e.target.closest('[data-focus]');
  if (b && !ctx.busy) ctx.focusEnquiry(Number(b.dataset.focus));
}

// ---- needs you ----

function renderQueuePane() {
  const db = ctx.db;
  const n = queueCount(db);
  $('#queue-count').textContent = n;
  $('#queue-count').classList.toggle('hot', n > 0);
  $('#queue').innerHTML = renderQueue(db, now(db));
}

async function onQueue(e) {
  if (!ctx.db || ctx.busy) return;
  const focus = e.target.closest('[data-focus]');
  if (focus) {
    ctx.focusEnquiry(Number(focus.dataset.focus));
    return;
  }
  const out = onQueueClick(ctx, e.target);
  if (!out.handled) return;
  notice = out.error ? { text: out.error, bad: true } : null;
  if (out.contactId) touch(out.contactId, true);
  await ctx.changed();
}

// ---- contacts ----

// Puts a contact at the top of the recent list, optionally opening its card.
function touch(id, open) {
  recent = [id, ...recent.filter((x) => x !== id)];
  if (open) openContact = id;
}

function renderContacts() {
  const db = ctx.db;
  const rows = all(
    db,
    `SELECT c.*, (SELECT group_concat(i.channel) FROM contact_sources cs JOIN inbound i ON i.id = cs.inbound_id WHERE cs.contact_id = c.id) AS channels,
            (SELECT count(*) FROM enquiries e WHERE e.contact_id = c.id) AS jobs,
            (SELECT group_concat(e.stage || ':' || e.id) FROM enquiries e WHERE e.contact_id = c.id) AS stages,
            (SELECT count(*) FROM inbound i WHERE i.contact_id = c.id) AS leads
       FROM contacts c ORDER BY c.id DESC`,
  );
  recent = recent.filter((id) => rows.some((r) => r.id === id));
  $('#contact-count').textContent = rows.length;
  const changed = diff('contacts', rows, (r) => r.id, (r) => [r.name, r.phone, r.email, r.channels, r.stages, r.leads].join('|'));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shown = showAll ? rows : recent.map((id) => byId.get(id));
  const items = shown
    .map((c) => {
      const isOpen = openContact === c.id;
      const icons = [...new Set((c.channels ?? '').split(',').filter(Boolean))].map((ch) => channelIcon(ch, CHANNELS[ch])).join('');
      const jobs = all(db, 'SELECT stage FROM enquiries WHERE contact_id = ? ORDER BY id DESC', [c.id]);
      const stage = jobs.find((j) => OPEN.includes(j.stage)) ?? jobs[0];
      return `<li class="contact ${isOpen ? 'is-open' : ''} ${changed.has(c.id) ? 'flash' : ''}" data-contact="${c.id}">
        <button type="button" class="contact-row" aria-expanded="${isOpen}">
          <span class="contact-name">${esc(personLabel(c))}</span>
          <span class="contact-ch">${icons}</span>
          <span class="contact-jobs">${stage ? `<span class="pill stage-${stage.stage}">${esc(STAGES[stage.stage])}</span>` : ''}${c.jobs > 1 ? `<span class="more" title="${c.jobs} enquiries">+${c.jobs - 1}</span>` : ''}</span>
        </button>
        ${isOpen ? contactDetail(c) : ''}
      </li>`;
    })
    .join('');
  const empty = showAll || recent.length ? '' : '<li class="empty">Senders appear here once processed.</li>';
  const toggle = rows.length > recent.length
    ? `<li class="contacts-toggle"><button type="button" class="link" data-all>${showAll ? 'Show only recent' : `Show all ${rows.length} on file`}</button></li>`
    : '';
  $('#contacts').innerHTML = empty + items + toggle;
}

function contactDetail(c) {
  const db = ctx.db;
  const t = now(db);
  const r = resolveContact(db, c.id);
  const label = { name: 'Name', phone: 'Phone', email: 'Email', zip: 'ZIP' };
  const show = (f, v) => (f === 'phone' ? fmtPhone(v) : v);
  const fieldRows = Object.keys(label)
    .map((f) => {
      const v = r.fields[f];
      const src = r.from[f];
      const seen = src && src !== 'correction' ? r.sources.find((s) => s.id === src) : null;
      const fromText = src === 'correction' ? 'corrected by you' : seen ? `${channelIcon(seen.channel, CHANNELS[seen.channel])} ${esc(fmtNear(seen.received_at, t))}` : '';
      const others = [...new Set(r.sources.filter((s) => s[f] && s[f] !== v).map((s) => s[f]))];
      let extra = others.length ? `<span class="also">also seen: ${others.map((o) => esc(show(f, o))).join(', ')}</span>` : '';
      if (f === 'email' && src !== 'correction') {
        const typo = r.sources.find((s) => s.email === v && s.email_suggestion);
        if (typo) {
          extra += `<span class="fix">Possible typo. <button type="button" class="link" data-correct="email" data-value="${esc(typo.email_suggestion)}">Use ${esc(typo.email_suggestion)}</button></span>`;
        }
      }
      return `<tr><th scope="row">${label[f]}</th><td>${v ? esc(show(f, v)) : '<span class="dim">—</span>'}${extra}</td><td class="from">${fromText}</td></tr>`;
    })
    .join('');

  // Each enquiry with the messages that came in on it.
  const leads = all(
    db,
    `SELECT i.*, cs.rule, cs.reason FROM inbound i LEFT JOIN contact_sources cs ON cs.inbound_id = i.id
      WHERE i.contact_id = ? ORDER BY i.received_at, i.id`,
    [c.id],
  );
  const enquiries = all(db, 'SELECT * FROM enquiries WHERE contact_id = ? ORDER BY created_at DESC, id DESC', [c.id]);
  const leadRow = (i, isFirst) => {
    const tag = i.outcome === 'duplicate' ? 'repeat, ignored' : i.outcome === 'reply' ? 'reply' : isFirst ? 'opened it' : 'added';
    const how = i.rule === 'auto-merge' ? 'Matched automatically' : i.rule === 'owner-merge' ? 'Matched by you' : '';
    const canSplit = ['auto-merge', 'owner-merge'].includes(i.rule) && i.outcome !== 'duplicate';
    return `<li class="${i.outcome === 'duplicate' ? 'is-repeat' : ''}">
      ${channelIcon(i.channel, CHANNELS[i.channel])}<span>${esc(CHANNELS[i.channel])}</span><span class="dim">${esc(fmtNear(i.received_at, t))}</span><span class="lead-tag">${tag}</span>
      ${canSplit ? `<button type="button" class="link" data-split="${i.id}" title="${esc(`${how}, ${i.reason}`)}">Not ${esc(firstName(c.name) || 'this person')}?</button>` : ''}
    </li>`;
  };
  const enquiryBlocks = enquiries
    .map((e) => {
      const mine = leads.filter((i) => i.enquiry_id === e.id);
      const opener = mine.find((i) => !['duplicate', 'reply'].includes(i.outcome));
      const visit = e.stage === 'booked' ? visitOf(db, e.id) : null;
      return `<li class="enq">
        <button type="button" class="enq-head" data-focus="${e.id}" title="Open the conversation">
          <strong>${esc(SERVICES[e.service] ?? 'Service unclear')}</strong>
          <span class="pill stage-${e.stage}">${esc(STAGES[e.stage])}</span>
          <span class="enq-go" aria-hidden="true">→</span>
        </button>
        <p class="enq-sub dim">${e.zip ? `ZIP ${esc(e.zip)}${e.area ? ` · ${esc(e.area)}` : ' · outside the area'}` : 'no ZIP'}${visit ? ` · visit ${esc(fmtNear(visit.start_at, t))}` : ''}</p>
        <ul class="leads">${mine.map((i) => leadRow(i, i === opener)).join('')}</ul>
      </li>`;
    })
    .join('');
  const waiting = leads.filter((i) => !i.enquiry_id);
  return `<div class="contact-detail">
    <div class="table-wrap"><table class="fields"><thead><tr><th></th><th>Value</th><th>Taken from</th></tr></thead><tbody>${fieldRows}</tbody></table></div>
    <h4>Enquiries <span class="count">${enquiries.length}</span></h4>
    <ul class="enqs">${enquiryBlocks || '<li class="dim small">None yet</li>'}</ul>
    ${waiting.length ? `<p class="dim small">${waiting.length === 1 ? 'One message is' : `${waiting.length} messages are`} waiting for you to say who ${waiting.length === 1 ? 'it is' : 'they are'} from.</p>` : ''}
  </div>`;
}

async function onContacts(e) {
  const db = ctx.db;
  if (!db || ctx.busy) return;
  const focusBtn = e.target.closest('[data-focus]');
  const splitBtn = e.target.closest('[data-split]');
  const fixBtn = e.target.closest('[data-correct]');
  const row = e.target.closest('.contact-row');
  if (e.target.closest('[data-all]')) {
    showAll = !showAll;
    renderContacts();
    return;
  }
  const id = Number(e.target.closest('[data-contact]')?.dataset.contact);
  try {
    if (focusBtn) {
      ctx.focusEnquiry(Number(focusBtn.dataset.focus));
      return;
    }
    if (splitBtn) {
      const inboundId = Number(splitBtn.dataset.split);
      const out = tx(db, () =>
        as('owner', () => {
          const res = split(db, inboundId);
          // A message moved into a conversation of its own gets the agent's reply there.
          if (res.opened) respond(db, inboundId);
          return res;
        }),
      );
      touch(out.contactId, true);
    } else if (fixBtn) {
      tx(db, () => as('owner', () => correct(db, id, fixBtn.dataset.correct, fixBtn.dataset.value)));
    } else if (row) {
      openContact = openContact === id ? null : id;
      renderContacts();
      return;
    } else return;
    notice = null;
  } catch (err) {
    notice = { text: err.message, bad: true };
  }
  await ctx.changed();
}
