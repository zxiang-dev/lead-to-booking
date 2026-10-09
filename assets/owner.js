// The owner's queue, shared by both tabs: drafts the agent was not allowed to send, and messages
// that might be from someone already on file. Each item says why it is there. The owner sends a
// draft, edits it or closes the enquiry, and says whether a message is from the person on file.
import { all, one, tx, as } from './db.js';
import { getContact, getEnquiry, getMessage, offersOf } from './engine.js';
import { ownerSend, ownerClose } from './agent.js';
import { decideReview } from './intake/match.js';
import { fmtDur, fmtNear } from './time.js';
import { CHANNELS, SERVICES, STAGES, fmtPhone, firstName, personLabel } from './terms.js';
import { esc, channelIcon } from './ui.js';

export const RISK = { hard: 'Hard stop', soft: 'Judgement call', routine: 'Approval' };
let editing = null; // the task whose draft is open for editing

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

export function queueCount(db) {
  return one(db, `SELECT (SELECT count(*) FROM tasks WHERE status = 'open') + (SELECT count(*) FROM match_reviews WHERE status = 'open') AS n`).n;
}

export const openTaskFor = (db, enquiryId) => one(db, `SELECT * FROM tasks WHERE enquiry_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`, [enquiryId]);

// The draft and what the owner can do with it.
export function draftBlock(db, k) {
  const m = getMessage(db, k.message_id);
  const offers = offersOf(db, m.id);
  if (editing === k.id) {
    return `<label class="sr-only" for="edit-${k.id}">Reply</label>
      <textarea class="draft-edit" id="edit-${k.id}" rows="${Math.min(10, m.body.split('\n').length + 1)}">${esc(m.body)}</textarea>
      <p class="dim small">Prices allowed.</p>
      <div class="task-actions">
        <button class="btn btn-accent btn-sm" type="button" data-task-act="save" data-task="${k.id}">Send edited reply</button>
        <button class="btn btn-quiet btn-sm" type="button" data-task-act="cancel" data-task="${k.id}">Cancel</button>
      </div>`;
  }
  return `<div class="bubble out draft"><span class="bubble-tag">Agent’s draft${offers.length ? ` · ${offers.length} times offered` : ''}</span><p class="bubble-body">${esc(m.body)}</p></div>
    <div class="task-actions">
      <button class="btn btn-accent btn-sm" type="button" data-task-act="send" data-task="${k.id}">Send</button>
      <button class="btn btn-quiet btn-sm" type="button" data-task-act="edit" data-task="${k.id}">Edit</button>
      <button class="btn btn-quiet btn-sm" type="button" data-task-act="close" data-task="${k.id}">Close enquiry</button>
    </div>`;
}

function taskCard(db, k, t) {
  const e = getEnquiry(db, k.enquiry_id);
  const c = getContact(db, e.contact_id);
  const said = one(db, `SELECT body, channel FROM messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY sent_at DESC, id DESC LIMIT 1`, [e.id]);
  const held = one(
    db,
    `SELECT sent_at FROM messages WHERE enquiry_id = ? AND kind = 'holding' AND status = 'sent' AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`,
    [e.id, k.created_at],
  );
  return `<article class="task risk-${k.risk}" data-task-card="${k.id}">
    <header class="task-head">
      ${channelIcon(said?.channel ?? e.channel)}
      <button type="button" class="task-who" data-focus="${e.id}" title="Open the conversation">${esc(personLabel(c))}<span class="dim"> · ${esc(SERVICES[e.service] ?? 'service unclear')}</span></button>
      <span class="risk-pill risk-${k.risk}">${RISK[k.risk]}</span>
    </header>
    <p class="task-why">${esc(cap(k.reason))}. <span class="dim">Waiting ${esc(fmtDur(t - k.created_at))}${held ? `; holding reply sent ${esc(fmtNear(held.sent_at, t))}` : ''}.</span></p>
    ${said ? `<p class="task-said">“${esc(said.body)}”</p>` : ''}
    ${draftBlock(db, k)}
  </article>`;
}

function reviewCard(db, r) {
  const c = getContact(db, r.contact_id);
  const line = (label, a, b, fmt = (x) => x) => {
    const same = a && b && a === b;
    return `<tr><th scope="row">${label}</th><td class="${same ? 'same' : ''}">${a ? esc(fmt(a)) : '<span class="dim">—</span>'}</td><td class="${same ? 'same' : ''}">${b ? esc(fmt(b)) : '<span class="dim">—</span>'}</td></tr>`;
  };
  const jobs = all(db, 'SELECT service, stage FROM enquiries WHERE contact_id = ? ORDER BY id', [c.id]);
  const chips = JSON.parse(r.reasons)
    .map((x) => `<span class="chip ${x.pts > 0 ? 'pos' : x.pts < 0 ? 'neg' : ''}">${x.pts > 0 ? '+' : ''}${x.pts} ${esc(x.text)}</span>`)
    .join('');
  return `<article class="task review" data-review="${r.id}">
    <header class="task-head">${channelIcon(r.channel)} <span>Is this ${esc(CHANNELS[r.channel].toLowerCase())} from <strong>${esc(c.name)}</strong>?</span><span class="risk-pill risk-soft">Who is it?</span></header>
    <div class="table-wrap"><table class="compare"><thead><tr><th></th><th>Incoming</th><th>On file</th></tr></thead><tbody>
      ${line('Name', r.i_name, c.name)}
      ${line('Phone', r.i_phone, c.phone, fmtPhone)}
      ${line('Email', r.i_email, c.email)}
      ${line('ZIP', r.i_zip, c.zip)}
    </tbody></table></div>
    <div class="chips">${chips}<span class="chip">score ${r.score}</span></div>
    <dl class="review-jobs">
      <dt>Asks about</dt><dd>${esc(SERVICES[r.i_service] ?? 'unclear')}: ${esc(r.i_summary ?? '')}</dd>
      <dt>${esc(firstName(c.name))} has</dt><dd>${jobs.map((j) => `${esc(SERVICES[j.service] ?? 'unclear')} (${esc(STAGES[j.stage].toLowerCase())})`).join(', ')}</dd>
    </dl>
    <p class="dim small">The agent replies once you decide.</p>
    <div class="task-actions">
      <button class="btn btn-accent btn-sm" type="button" data-decide="same">Same person</button>
      <button class="btn btn-quiet btn-sm" type="button" data-decide="different">Different people</button>
    </div>
  </article>`;
}

// Everything waiting on the owner, oldest first.
export function renderQueue(db, t) {
  const tasks = all(db, `SELECT * FROM tasks WHERE status = 'open'`).map((k) => ({ at: k.created_at, html: () => taskCard(db, k, t) }));
  const reviews = all(
    db,
    `SELECT r.*, i.channel, i.received_at, i.name AS i_name, i.phone AS i_phone, i.email AS i_email, i.zip AS i_zip,
            i.service AS i_service, i.summary AS i_summary
       FROM match_reviews r JOIN inbound i ON i.id = r.inbound_id WHERE r.status = 'open'`,
  ).map((r) => ({ at: r.received_at, html: () => reviewCard(db, r) }));
  const items = [...tasks, ...reviews].sort((a, b) => a.at - b.at);
  return items.length
    ? items.map((x) => x.html()).join('')
    : '<p class="empty">Nothing waiting.</p>';
}

// Handles a click inside a queue item. Returns { handled, contactId?, error? }.
export function onQueueClick(ctx, target) {
  const db = ctx.db;
  const act = target.closest('[data-task-act]');
  const decide = target.closest('[data-decide]');
  try {
    if (act) {
      const id = Number(act.dataset.task);
      const kind = act.dataset.taskAct;
      if (kind === 'edit') editing = id;
      else if (kind === 'cancel') editing = null;
      else if (kind === 'send') tx(db, () => ownerSend(db, id));
      else if (kind === 'save') {
        const body = document.getElementById(`edit-${id}`)?.value ?? '';
        if (!body.trim()) throw new Error('The reply is empty');
        tx(db, () => ownerSend(db, id, body));
        editing = null;
      } else if (kind === 'close') {
        tx(db, () => ownerClose(db, id));
        if (editing === id) editing = null;
      }
      return { handled: true };
    }
    if (decide) {
      const id = Number(decide.closest('[data-review]').dataset.review);
      const out = tx(db, () => as('owner', () => decideReview(db, id, decide.dataset.decide === 'same')));
      return { handled: true, contactId: out.contactId };
    }
  } catch (err) {
    return { handled: true, error: err.message };
  }
  return { handled: false };
}

export const resetQueue = () => {
  editing = null;
};
