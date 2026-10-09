// The life of an enquiry on the simulated clock. A contact is a person; an enquiry is one job and the
// conversation about it. Once a message is matched to a person (intake/match.js) it is added to one of
// their open enquiries or opens a new one. Replies are drafted here and sent if the database allows
// (agent.js decides what to draft); visits are booked from the times offered; check-ins run until the
// customer books. Every write goes through the database, whose triggers enforce the rules and keep
// the audit trail.
import { all, one, run, as, audit, lastId, isBlocked, blockedText } from './db.js';
import { nextOpen, DAY, fmtTime, fmtDur, workdaysAfter, eveBefore, addBusiness } from './time.js';
import { SERVICES, greetName, serviceWord, personLabel } from './terms.js';

export const OPEN = ['open', 'owner'];
export const CLOSED = ['booked', 'lost', 'nurture'];
const HOLD_AFTER = 15; // business minutes the owner has before a holding reply goes out
const URGENT_LEAD = 60; // an urgent job can be offered any time from an hour ahead
const SIGN_OFF = '— Booking assistant';
const HOLDING = 'Thanks for your message. The owner has it and will get back to you shortly.';

// Check-ins while a customer has times but hasn't picked one. They restart whenever the customer writes.
const STEPS = [
  { step: 1, kind: 'nudge', label: 'Check-in with new times', at: (t) => nextOpen(t + DAY) },
  { step: 2, kind: 'last', label: 'Last check-in', at: (t) => nextOpen(t + 3 * DAY) },
  { step: 3, kind: 'close', label: 'Move to long-term', at: (t) => nextOpen(t + 7 * DAY) },
];
export const stepLabel = (kind) => (kind === 'reminder' ? 'Visit reminder' : (STEPS.find((s) => s.kind === kind)?.label ?? kind));

export const now = (db) => one(db, 'SELECT now FROM clock').now;
const setNow = (db, t) => run(db, 'UPDATE clock SET now = ?', [t]);
export const mode = (db) => one(db, 'SELECT mode FROM settings').mode;
export const setMode = (db, m) => as('owner', () => run(db, 'UPDATE settings SET mode = ?', [m]));

export const getContact = (db, id) => one(db, 'SELECT * FROM contacts WHERE id = ?', [id]);
export const getEnquiry = (db, id) => one(db, 'SELECT * FROM enquiries WHERE id = ?', [id]);
export const getInbound = (db, id) => one(db, 'SELECT * FROM inbound WHERE id = ?', [id]);
export const getMessage = (db, id) => one(db, 'SELECT * FROM messages WHERE id = ?', [id]);
export const areaOf = (db, zip) => (zip ? (one(db, 'SELECT area FROM service_area WHERE zip = ?', [zip])?.area ?? null) : null);

// ---- people: details resolved from the inbound records linked to a contact ----

export function sources(db, contactId) {
  return all(
    db,
    `SELECT i.*, cs.rule, cs.reason
       FROM contact_sources cs JOIN inbound i ON i.id = cs.inbound_id
      WHERE cs.contact_id = ? ORDER BY i.received_at, i.id`,
    [contactId],
  );
}

const PERSON_FIELDS = ['name', 'phone', 'email', 'zip'];
const fullness = (n) => n.trim().split(/\s+/).filter((t) => t.replace(/\W/g, '').length > 1).length * 100 + n.length;

// The earliest source with a value wins, except the name, where the fullest one wins.
// The owner's correction beats every source. `from` says where each value came from.
export function resolveContact(db, contactId) {
  const src = sources(db, contactId);
  const fixes = all(db, 'SELECT field, value, original FROM corrections WHERE contact_id = ?', [contactId]);
  const fields = {};
  const from = {};
  for (const f of PERSON_FIELDS) {
    const withValue = src.filter((s) => s[f]);
    let pick = withValue[0];
    if (f === 'name' && pick) pick = withValue.reduce((best, s) => (fullness(s.name) > fullness(best.name) ? s : best));
    fields[f] = pick ? pick[f] : null;
    from[f] = pick ? pick.id : null;
  }
  for (const c of fixes) {
    fields[c.field] = c.value;
    from[c.field] = 'correction';
  }
  return { fields, from, sources: src, fixes };
}

function rebuildContact(db, contactId) {
  const f = resolveContact(db, contactId).fields;
  run(db, 'UPDATE contacts SET name = ?, phone = ?, email = ?, zip = ? WHERE id = ?', [f.name, f.phone, f.email, f.zip, contactId]);
}

export function createContact(db, inboundId, { outcome = 'new', reason = 'First record for this person' } = {}) {
  const i = getInbound(db, inboundId);
  run(db, 'INSERT INTO contacts (name, phone, email, zip, created_at) VALUES (?, ?, ?, ?, ?)', [i.name, i.phone, i.email, i.zip, i.received_at]);
  const id = lastId(db);
  run(db, `INSERT INTO contact_sources (inbound_id, contact_id, rule, reason, linked_at) VALUES (?, ?, 'first', ?, ?)`, [inboundId, id, reason, now(db)]);
  run(db, 'UPDATE inbound SET outcome = ?, contact_id = ? WHERE id = ?', [outcome, id, inboundId]);
  return id;
}

// Records that a message came from a person already on file.
export function linkToContact(db, inboundId, contactId, { rule, score = null, reason }) {
  run(db, 'INSERT INTO contact_sources (inbound_id, contact_id, rule, score, reason, linked_at) VALUES (?, ?, ?, ?, ?, ?)', [
    inboundId,
    contactId,
    rule,
    score,
    reason,
    now(db),
  ]);
  run(db, 'UPDATE inbound SET outcome = ?, contact_id = ? WHERE id = ?', [rule === 'reply' ? 'reply' : 'merged', contactId, inboundId]);
  rebuildContact(db, contactId);
}

export function correct(db, contactId, field, value) {
  const original = getContact(db, contactId)[field];
  run(db, 'INSERT OR REPLACE INTO corrections (contact_id, field, value, original, at) VALUES (?, ?, ?, ?, ?)', [contactId, field, value, original, now(db)]);
  rebuildContact(db, contactId);
}

// ---- enquiries: which job a message is about ----

export const visitOf = (db, enquiryId) =>
  one(db, 'SELECT s.start_at FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.enquiry_id = ?', [enquiryId]);

// Same service as an open enquiry: a follow-up about that job. No service mentioned: it belongs to the
// latest open job. A booked job with a visit still to come takes messages about the same service.
// Anything else is a new job, with its own conversation, times and check-ins.
export function placeLead(db, inboundId, contactId) {
  const i = getInbound(db, inboundId);
  const enquiries = all(db, 'SELECT * FROM enquiries WHERE contact_id = ? ORDER BY created_at DESC, id DESC', [contactId]);
  const open = enquiries.filter((e) => OPEN.includes(e.stage));
  const t = now(db);
  let target = null;
  let why = '';
  if (i.service && open.some((e) => e.service === i.service)) {
    target = open.find((e) => e.service === i.service);
    why = `Same job as their open ${serviceWord(i.service)} enquiry.`;
  } else if (!i.service && open.length) {
    target = open[0];
    why = 'No job named; joins their latest open enquiry.';
  } else if (i.service && open.some((e) => !e.service)) {
    target = open.find((e) => !e.service);
    why = 'Names the job for their open enquiry.';
  } else if (i.service) {
    const booked = enquiries.find((e) => e.stage === 'booked' && e.service === i.service && (visitOf(db, e.id)?.start_at ?? 0) > t);
    if (booked) {
      target = booked;
      why = `About their booked ${serviceWord(i.service)} visit.`;
    }
  }
  if (target) return { action: 'added', why, ...addToEnquiry(db, target.id, inboundId) };

  if (!enquiries.length) why = 'First enquiry from this person.';
  else if (open.length) {
    const kinds = [...new Set(open.map((e) => (e.service ? serviceWord(e.service) : 'unclear')))].join(' and ');
    why = `A different job from their open ${kinds} enquiry.`;
  } else why = 'Earlier enquiries closed; a new job.';
  return { action: 'opened', why, ...openEnquiry(db, contactId, inboundId) };
}

export function openEnquiry(db, contactId, inboundId) {
  const i = getInbound(db, inboundId);
  const c = getContact(db, contactId);
  // A job with no address of its own is assumed to be at the address the person gave before.
  const zip = i.zip ?? c.zip;
  const zipFrom = i.zip ? 'message' : c.zip ? 'contact' : null;
  // Reply the way they wrote, to the number or address they wrote from; a form or a call with a
  // phone number gets a text. A referral's client never wrote to us, so they get a text only if the
  // sheet says they agreed to one, and an email otherwise.
  const textOk = i.channel === 'referral' ? i.text_ok : 1;
  const phone = i.phone ?? c.phone;
  const email = i.email ?? c.email;
  const via = i.channel === 'email' || !phone || (!textOk && email) ? 'email' : 'sms';
  const to = via === 'sms' ? phone : email;
  const subject = via === 'email' && i.channel !== 'email' ? `Your ${i.service ? `${serviceWord(i.service)} ` : ''}estimate` : null;
  run(
    db,
    `INSERT INTO enquiries (contact_id, service, summary, zip, area, channel, reply_via, reply_to, subject, text_ok, urgent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [contactId, i.service, i.summary, zip, areaOf(db, zip), i.channel, via, to, subject, textOk, i.urgent, i.received_at],
  );
  const id = lastId(db);
  run(db, 'UPDATE inbound SET enquiry_id = ? WHERE id = ?', [id, inboundId]);
  addCustomerMessage(db, id, inboundId);
  return { enquiryId: id, zipFrom };
}

// Adds the message to the conversation and fills gaps in the enquiry from it.
export function addToEnquiry(db, enquiryId, inboundId) {
  const i = getInbound(db, inboundId);
  const e = getEnquiry(db, enquiryId);
  run(db, 'UPDATE inbound SET enquiry_id = ? WHERE id = ?', [enquiryId, inboundId]);
  addCustomerMessage(db, enquiryId, inboundId);
  const filled = [];
  if (!e.zip && i.zip) {
    run(db, 'UPDATE enquiries SET zip = ?, area = ? WHERE id = ?', [i.zip, areaOf(db, i.zip), enquiryId]);
    filled.push(`ZIP ${i.zip}`);
  }
  if (!e.service && i.service) {
    run(db, 'UPDATE enquiries SET service = ?, summary = coalesce(summary, ?) WHERE id = ?', [i.service, i.summary, enquiryId]);
    filled.push(SERVICES[i.service]);
  }
  if (i.urgent && !e.urgent) run(db, 'UPDATE enquiries SET urgent = 1 WHERE id = ?', [enquiryId]);
  return { enquiryId, filled };
}

function addCustomerMessage(db, enquiryId, inboundId) {
  const i = getInbound(db, inboundId);
  run(
    db,
    `INSERT INTO messages (enquiry_id, direction, author, channel, kind, body, inbound_id, status, created_at, sent_at)
     VALUES (?, 'in', 'customer', ?, 'message', ?, ?, 'received', ?, ?)`,
    [enquiryId, i.channel, i.words || i.summary || '(no message)', inboundId, i.received_at, i.received_at],
  );
}

// Takes one message back out of a contact. It becomes a new contact; the job it opened goes with it,
// or, if it was a message in someone else's conversation, it opens one of its own (`opened`).
export function split(db, inboundId) {
  const src = one(db, 'SELECT * FROM contact_sources WHERE inbound_id = ?', [inboundId]);
  if (!src || !['auto-merge', 'owner-merge'].includes(src.rule)) throw new Error('Only a matched message can be split out');
  run(db, 'DELETE FROM contact_sources WHERE inbound_id = ?', [inboundId]);
  rebuildContact(db, src.contact_id);
  return as('automation', () => {
    const contactId = createContact(db, inboundId, { outcome: 'separate', reason: `Taken out of ${personLabel(getContact(db, src.contact_id))}’s record by the owner` });
    const i = getInbound(db, inboundId);
    if (!i.enquiry_id) return { contactId, opened: true, ...openEnquiry(db, contactId, inboundId) };
    const others = one(db, `SELECT count(*) AS n FROM inbound WHERE enquiry_id = ? AND id <> ? AND outcome NOT IN ('duplicate', 'reply')`, [i.enquiry_id, inboundId]).n;
    if (!others) {
      run(db, 'UPDATE enquiries SET contact_id = ? WHERE id = ?', [contactId, i.enquiry_id]);
      run(db, `UPDATE inbound SET contact_id = ? WHERE enquiry_id = ? AND outcome IN ('duplicate', 'reply')`, [contactId, i.enquiry_id]);
      run(db, `UPDATE contact_sources SET contact_id = ? WHERE inbound_id IN (SELECT id FROM inbound WHERE enquiry_id = ? AND outcome = 'reply')`, [contactId, i.enquiry_id]);
      audit(db, 'enquiry.moved', `${SERVICES[getEnquiry(db, i.enquiry_id).service] ?? 'Service unclear'} enquiry moved to ${personLabel(getContact(db, contactId))} with the message that opened it`);
      return { contactId, enquiryId: i.enquiry_id, opened: false };
    }
    // The message leaves the old conversation. A reply already sent stays there, since the customer
    // has it; an unsent draft goes, with its offered times and any wait on the owner.
    const drafts = `SELECT id FROM messages WHERE inbound_id = ? AND direction = 'out' AND status = 'draft'`;
    run(db, `DELETE FROM offers WHERE message_id IN (${drafts})`, [inboundId]);
    run(db, `DELETE FROM tasks WHERE message_id IN (${drafts})`, [inboundId]);
    run(db, `DELETE FROM messages WHERE id IN (${drafts}) OR (inbound_id = ? AND direction = 'in')`, [inboundId, inboundId]);
    run(db, `UPDATE messages SET inbound_id = NULL WHERE inbound_id = ?`, [inboundId]);
    run(
      db,
      `UPDATE enquiries SET stage = 'open' WHERE id = ? AND stage = 'owner'
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE enquiry_id = ? AND status = 'open')`,
      [i.enquiry_id, i.enquiry_id],
    );
    run(db, 'UPDATE inbound SET enquiry_id = NULL WHERE id = ?', [inboundId]);
    return { contactId, opened: true, ...openEnquiry(db, contactId, inboundId) };
  });
}

// ---- messages and visit times ----

// Urgent jobs can have the first free time from an hour ahead; everything else starts two workdays
// out, which keeps the near days free for urgent work.
const earliestVisit = (t, urgent) => (urgent ? t + URGENT_LEAD : workdaysAfter(t, 2));

const openSlots = (db, from, limit = 3) =>
  all(
    db,
    `SELECT s.* FROM slots s WHERE s.start_at >= ? AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id)
      ORDER BY s.start_at LIMIT ?`,
    [from, limit],
  );

export const offersOf = (db, messageId) =>
  all(db, 'SELECT o.option, o.slot_id, s.start_at FROM offers o JOIN slots s ON s.id = o.slot_id WHERE o.message_id = ? ORDER BY o.option', [messageId]);

const choices = (n) => (n === 1 ? '1' : `${Array.from({ length: n - 1 }, (_, i) => i + 1).join(', ')} or ${n}`);

// What the customer sees: a greeting, the model's words, then what code adds (visit times from the
// calendar, or a question for a missing ZIP), and the sign-off. The model never writes times.
function compose(db, e, words, addon) {
  const c = getContact(db, e.contact_id);
  const hi = greetName(c.name);
  const parts = [hi ? `Hi ${hi},` : 'Hi,'];
  if (words) parts.push(words);
  let slots = [];
  if (addon === 'times') {
    slots = openSlots(db, earliestVisit(now(db), !!e.urgent));
    parts.push(
      slots.length
        ? `Next open visits:\n${slots.map((s, n) => `${n + 1} · ${fmtTime(s.start_at)}`).join('\n')}\nReply ${choices(slots.length)} to book.`
        : 'The calendar is full for now; the owner will be in touch with a time.',
    );
  }
  if (addon === 'zip') parts.push("What's the ZIP code where the work is?");
  parts.push(SIGN_OFF);
  return { body: parts.join('\n'), slots };
}

function insertOffers(db, messageId, enquiryId, slots) {
  slots.forEach((s, n) => run(db, 'INSERT INTO offers (message_id, enquiry_id, option, slot_id) VALUES (?, ?, ?, ?)', [messageId, enquiryId, n + 1, s.id]));
}

// A reply waiting to be sent, by the agent or the owner. addon: 'times' | 'zip' | null.
export function draft(db, enquiryId, { author = 'agent', kind, words, addon = null, risk = 'routine', inboundId = null }) {
  const e = getEnquiry(db, enquiryId);
  const { body, slots } = compose(db, e, words, addon);
  run(
    db,
    `INSERT INTO messages (enquiry_id, direction, author, channel, kind, words, body, inbound_id, risk, status, created_at)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    [enquiryId, author, e.reply_via, kind, words, body, inboundId, risk, now(db)],
  );
  const id = lastId(db);
  insertOffers(db, id, enquiryId, slots);
  return id;
}

// A draft that waited may list times that have since gone; it is rewritten with current ones.
function refreshOffers(db, messageId) {
  const m = getMessage(db, messageId);
  const offers = offersOf(db, messageId);
  if (!offers.length) return false;
  const gone = one(
    db,
    `SELECT count(*) AS n FROM offers o JOIN slots s ON s.id = o.slot_id
      WHERE o.message_id = ? AND (s.start_at <= ? OR EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = o.slot_id))`,
    [messageId, now(db)],
  ).n;
  if (!gone) return false;
  const e = getEnquiry(db, m.enquiry_id);
  const { body, slots } = compose(db, e, m.words, 'times');
  run(db, 'DELETE FROM offers WHERE message_id = ?', [messageId]);
  run(db, 'UPDATE messages SET body = ? WHERE id = ?', [body, messageId]);
  insertOffers(db, messageId, m.enquiry_id, slots);
  return true;
}

// Tries to send a draft as `who`. The database decides; a refusal comes back as `blocked`.
export function trySend(db, messageId, who) {
  if (getMessage(db, messageId).author !== 'owner') refreshOffers(db, messageId);
  try {
    as(who, () => run(db, `UPDATE messages SET status = 'sent', sent_at = ?, sent_by = ? WHERE id = ?`, [now(db), who, messageId]));
    return { sent: true };
  } catch (err) {
    if (!isBlocked(err)) throw err;
    return { sent: false, blocked: blockedText(err) };
  }
}

// A fixed message from code, not the model, so it goes out in every mode (though never as a text
// to someone who hasn't agreed to texts: the database refuses that).
function sendTemplate(db, e, kind, words, addon = null) {
  const { body, slots } = compose(db, e, words, addon);
  const t = now(db);
  run(
    db,
    `INSERT INTO messages (enquiry_id, direction, author, channel, kind, words, body, status, created_at, sent_at, sent_by)
     VALUES (?, 'out', 'automation', ?, ?, ?, ?, 'sent', ?, ?, 'automation')`,
    [e.id, e.reply_via, kind, words, body, t, t],
  );
  const id = lastId(db);
  insertOffers(db, id, e.id, slots);
  return id;
}

// The times in the latest message that listed any; option is the number the customer picked.
function latestOffer(db, enquiryId) {
  const m = one(
    db,
    `SELECT m.* FROM messages m WHERE m.enquiry_id = ? AND m.status = 'sent' AND EXISTS (SELECT 1 FROM offers o WHERE o.message_id = m.id)
      ORDER BY m.sent_at DESC, m.id DESC LIMIT 1`,
    [enquiryId],
  );
  return m ? { message: m, offers: offersOf(db, m.id) } : null;
}

// Books the time the customer picked. The database refuses a clash, a time that has passed, or a
// time this customer was never offered; a refusal sends them fresh times instead.
export function bookOption(db, enquiryId, option) {
  const latest = latestOffer(db, enquiryId);
  const offer = latest?.offers.find((o) => o.option === option);
  const e = getEnquiry(db, enquiryId);
  if (!offer) {
    const id = as('automation', () => sendTemplate(db, e, 'retry', `Sorry, there was no option ${option} in our last message.`, 'times'));
    scheduleFollowups(db, enquiryId, now(db));
    return { ok: false, why: `there was no option ${option} on offer`, messageId: id, latest };
  }
  try {
    as('agent', () => run(db, 'INSERT INTO appointments (enquiry_id, slot_id, booked_at) VALUES (?, ?, ?)', [enquiryId, offer.slot_id, now(db)]));
  } catch (err) {
    if (!isBlocked(err)) throw err;
    const id = as('automation', () => sendTemplate(db, e, 'retry', 'Sorry, that time was taken a moment ago.', 'times'));
    scheduleFollowups(db, enquiryId, now(db));
    return { ok: false, why: blockedText(err), offer, messageId: id, latest };
  }
  const id = as('automation', () => {
    scheduleReminder(db, enquiryId, offer.start_at);
    return sendTemplate(db, e, 'confirm', `You're booked for ${fmtTime(offer.start_at)}: a free estimate visit of about 45 minutes. We'll send a reminder the day before.`);
  });
  return { ok: true, offer, messageId: id, latest };
}

// ---- the owner's queue ----

export function openTask(db, enquiryId, messageId, risk, reason) {
  const t = now(db);
  run(db, 'INSERT INTO tasks (enquiry_id, message_id, risk, reason, created_at, hold_at) VALUES (?, ?, ?, ?, ?, ?)', [
    enquiryId,
    messageId,
    risk,
    reason,
    t,
    canMessage(getEnquiry(db, enquiryId)) ? addBusiness(t, HOLD_AFTER) : null, // no holding text without consent
  ]);
  run(db, `UPDATE enquiries SET stage = 'owner', owner_needed = 1 WHERE id = ?`, [enquiryId]);
  pauseFollowups(db, enquiryId);
  return lastId(db);
}

export function closeEnquiry(db, enquiryId, stage, reason) {
  const t = now(db);
  run(db, `UPDATE followups SET status = 'cancelled', done_at = ?, note = 'Stopped: enquiry closed' WHERE enquiry_id = ? AND status IN ('scheduled', 'paused')`, [t, enquiryId]);
  run(db, 'UPDATE enquiries SET stage = ?, closed_at = ?, close_reason = ? WHERE id = ?', [stage, t, reason, enquiryId]);
}

// ---- check-ins ----

export function scheduleFollowups(db, enquiryId, from) {
  run(db, `DELETE FROM followups WHERE enquiry_id = ? AND status IN ('scheduled', 'paused') AND kind <> 'reminder'`, [enquiryId]);
  for (const s of STEPS) run(db, 'INSERT INTO followups (enquiry_id, step, kind, due_at) VALUES (?, ?, ?, ?)', [enquiryId, s.step, s.kind, s.at(from)]);
}

function pauseFollowups(db, enquiryId) {
  run(db, `UPDATE followups SET status = 'paused', note = 'Paused: waiting for the owner' WHERE enquiry_id = ? AND status = 'scheduled' AND kind <> 'reminder'`, [enquiryId]);
}

function scheduleReminder(db, enquiryId, startAt) {
  const at = eveBefore(startAt);
  if (at > now(db)) run(db, `INSERT INTO followups (enquiry_id, step, kind, due_at) VALUES (?, 4, 'reminder', ?)`, [enquiryId, at]);
}

const viaWord = (e) => (e.reply_via === 'sms' ? 'text' : 'email');

// Whether automation may write to this conversation: never a text without consent.
export const canMessage = (e) => e.reply_via !== 'sms' || e.text_ok === 1;

// Everything due at or before the current time: holding replies, check-ins and visit reminders.
export function processDue(db) {
  as('automation', () => {
    const t = now(db);
    for (const k of all(db, `SELECT * FROM tasks WHERE status = 'open' AND held_at IS NULL AND hold_at <= ? ORDER BY hold_at, id`, [t])) {
      run(db, 'UPDATE tasks SET held_at = ? WHERE id = ?', [t, k.id]);
      const w = one(
        db,
        `SELECT (SELECT max(sent_at) FROM messages WHERE enquiry_id = ? AND direction = 'in') AS last_in,
                (SELECT max(sent_at) FROM messages WHERE enquiry_id = ? AND direction = 'out' AND status = 'sent') AS last_out`,
        [k.enquiry_id, k.enquiry_id],
      );
      const e = getEnquiry(db, k.enquiry_id);
      if ((w.last_out == null || w.last_out < w.last_in) && canMessage(e)) sendTemplate(db, e, 'holding', HOLDING);
    }
    for (const f of all(db, `SELECT * FROM followups WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at, id`, [t])) {
      const e = getEnquiry(db, f.enquiry_id);
      const done = (note) => run(db, `UPDATE followups SET status = 'sent', done_at = ?, note = ? WHERE id = ?`, [t, note, f.id]);
      if (!canMessage(e)) {
        run(db, `UPDATE followups SET status = 'cancelled', done_at = ?, note = 'Stopped: no consent to text' WHERE id = ?`, [t, f.id]);
        continue;
      }
      if (f.kind === 'reminder') {
        if (e.stage !== 'booked') {
          run(db, `UPDATE followups SET status = 'cancelled', done_at = ?, note = 'Stopped: no visit booked' WHERE id = ?`, [t, f.id]);
          continue;
        }
        const visit = visitOf(db, e.id);
        sendTemplate(db, e, 'reminder', `A reminder of your estimate visit on ${fmtTime(visit.start_at)}. Reply here if you need to change it.`);
        done(`Sent by ${viaWord(e)}`);
      } else if (CLOSED.includes(e.stage)) {
        run(db, `UPDATE followups SET status = 'cancelled', done_at = ?, note = 'Stopped: enquiry closed' WHERE id = ?`, [t, f.id]);
      } else if (f.kind === 'close') {
        done('No booking after 7 days');
        closeEnquiry(db, e.id, 'nurture', 'no reply after 7 days');
      } else {
        const offering = e.service && e.area;
        const words =
          f.kind === 'nudge'
            ? 'Just checking in. Would you still like someone to take a look?'
            : "Last check-in from us. If the timing isn't right, no problem: reply whenever suits.";
        const id = sendTemplate(db, e, f.kind, words, offering ? 'times' : null);
        const n = offersOf(db, id).length;
        done(`Sent by ${viaWord(e)}${n ? ` with ${n} new times` : ''}`);
      }
    }
  });
}

// The next moment something is due to happen, with a short description.
export function nextEvent(db) {
  const rows = [
    ...all(
      db,
      `SELECT f.due_at AS t, f.kind, c.name, c.phone FROM followups f JOIN enquiries e ON e.id = f.enquiry_id JOIN contacts c ON c.id = e.contact_id
        WHERE f.status = 'scheduled' ORDER BY f.due_at LIMIT 1`,
    ).map((r) => ({ t: r.t, text: `${stepLabel(r.kind)} for ${personLabel(r)}` })),
    ...all(
      db,
      `SELECT k.hold_at AS t, c.name, c.phone FROM tasks k JOIN enquiries e ON e.id = k.enquiry_id JOIN contacts c ON c.id = e.contact_id
        WHERE k.status = 'open' AND k.held_at IS NULL AND k.hold_at IS NOT NULL ORDER BY k.hold_at LIMIT 1`,
    ).map((r) => ({ t: r.t, text: `Holding reply to ${personLabel(r)} if still waiting` })),
  ];
  return rows.sort((a, b) => a.t - b.t)[0] ?? null;
}

// Moves the clock to target, handling every event on the way at the time it falls due. quiet: no
// audit entry for the move (used while the seed replays history).
export function advance(db, target, { quiet = false } = {}) {
  const start = now(db);
  for (let i = 0; i < 1000; i++) {
    const next = nextEvent(db);
    if (!next || next.t > target) break;
    setNow(db, Math.max(next.t, now(db)));
    processDue(db);
  }
  setNow(db, Math.max(target, now(db)));
  processDue(db);
  if (target > start && !quiet) as('clock', () => audit(db, 'clock.moved', `${fmtDur(target - start)} on, to ${fmtTime(target)}`));
}

