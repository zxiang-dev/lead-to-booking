// One incoming message, end to end. Code runs first and last; the model sits in the middle:
//   1. a repeat delivery is caught from the raw text, before any model call;
//   2. the agent reads the message (its answer is replayed from samples.js) and code checks it;
//   3. a reply to one of our messages joins that conversation; anything else is matched to a person
//      on the evidence (same email, same phone, compatible names, same ZIP, conflicting details);
//   4. it joins one of their open enquiries or opens a new one (engine.placeLead);
//   5. the agent replies, within what the database allows (agent.respond).
import { all, one, run, lastId, as } from '../db.js';
import { now, createContact, linkToContact, placeLead, openEnquiry, addToEnquiry, processDue, areaOf, getEnquiry, getContact } from '../engine.js';
import { personLabel } from '../terms.js';
import { respond } from '../agent.js';
import { fmtTime } from '../time.js';
import { headers, wordsOf, check } from './check.js';

const REPEAT_WINDOW = 30; // minutes within which an identical delivery is treated as a repeat
// Match scores: 90 or more is the same person; 50 to 89 goes to the owner; below that, someone new.
const POLICY = { auto: 90, review: 50 };

const tokens = (name) =>
  (name ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Names are compared as sets of words, so "TAN J" (caller ID) and "Jason Tan" line up.
function nameEvidence(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return null;
  const common = ta.filter((t) => t.length > 1 && tb.includes(t));
  if (!common.length) return null;
  const ra = ta.filter((t) => !common.includes(t));
  const rb = tb.filter((t) => !common.includes(t));
  if (!ra.length && !rb.length) return { pts: 25, text: 'same name' };
  if (!ra.length || !rb.length) return { pts: 10, text: 'same surname' };
  const [x, y] = [ra[0], rb[0]];
  if (x.length === 1 || y.length === 1) {
    return x[0] === y[0] ? { pts: 20, text: 'initial and surname match' } : { pts: -30, text: 'different first initial' };
  }
  return { pts: -30, text: 'different first names' };
}

// Every phone, email, name and ZIP each contact has been seen with, across all its sources.
function identities(db) {
  const rows = all(
    db,
    `SELECT cs.contact_id, i.name, i.phone, i.email, i.zip FROM contact_sources cs JOIN inbound i ON i.id = cs.inbound_id
     UNION ALL
     SELECT contact_id, CASE field WHEN 'name' THEN value END, NULL, CASE field WHEN 'email' THEN value END, NULL FROM corrections`,
  );
  const byContact = new Map();
  for (const r of rows) {
    const id = byContact.get(r.contact_id) ?? { names: new Set(), phones: new Set(), emails: new Set(), zips: new Set() };
    if (r.name) id.names.add(r.name);
    if (r.phone) id.phones.add(r.phone);
    if (r.email) id.emails.add(r.email);
    if (r.zip) id.zips.add(r.zip);
    byContact.set(r.contact_id, id);
  }
  return byContact;
}

function candidates(db, f) {
  const contacts = all(db, 'SELECT id, name FROM contacts');
  const ids = identities(db);
  const out = [];
  for (const c of contacts) {
    const id = ids.get(c.id);
    if (!id) continue;
    const reasons = [];
    if (f.email && id.emails.has(f.email)) reasons.push({ pts: 100, text: 'same email' });
    else if (f.email && id.emails.size) reasons.push({ pts: -15, text: 'different email' });
    if (f.phone && id.phones.has(f.phone)) reasons.push({ pts: 70, text: 'same phone' });
    const names = [...id.names].map((n) => nameEvidence(f.name, n)).filter(Boolean);
    if (names.length) reasons.push(names.sort((a, b) => b.pts - a.pts)[0]);
    if (f.zip && id.zips.has(f.zip)) reasons.push({ pts: 10, text: 'same ZIP' });
    else if (f.zip && id.zips.size) reasons.push({ pts: 0, text: 'different ZIP' });
    const evidence = reasons.some((r) => r.pts > 0 && r.text !== 'same ZIP');
    const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)));
    if (evidence && score > 0) out.push({ contact: c, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

const reasonText = (reasons) => reasons.map((r) => `${r.pts > 0 ? '+' : ''}${r.pts} ${r.text}`).join(', ');

// The conversation a message answers. A text from a number we texted in an open conversation is a
// reply to it; an email is a reply when its subject is "Re:" the subject of one of their emails or ours.
function findThread(db, channel, head) {
  let enquiryId = null;
  if (channel === 'sms' && head.phone) {
    enquiryId = one(
      db,
      `SELECT m.enquiry_id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id
        WHERE m.direction = 'out' AND m.status = 'sent' AND m.channel = 'sms' AND e.stage IN ('open', 'owner') AND e.reply_to = ?
        ORDER BY m.sent_at DESC, m.id DESC LIMIT 1`,
      [head.phone],
    )?.enquiry_id;
  } else if (channel === 'email' && head.replyTo && head.email) {
    const theirs = all(
      db,
      `SELECT i.raw, i.enquiry_id FROM inbound i JOIN enquiries e ON e.id = i.enquiry_id
        WHERE i.channel = 'email' AND i.email = ? AND e.stage IN ('open', 'owner') ORDER BY i.id DESC`,
      [head.email],
    );
    enquiryId = theirs.find((r) => headers('email', r.raw).subject.toLowerCase() === head.replyTo.toLowerCase())?.enquiry_id
      // or "Re:" the subject of an email we started, to a referral.
      ?? one(
        db,
        `SELECT id FROM enquiries WHERE reply_via = 'email' AND reply_to = ? AND lower(subject) = lower(?) AND stage IN ('open', 'owner')
          ORDER BY id DESC LIMIT 1`,
        [head.email, head.replyTo],
      )?.id;
  }
  if (!enquiryId) return null;
  const e = getEnquiry(db, enquiryId);
  const last = one(db, `SELECT * FROM messages WHERE enquiry_id = ? AND direction = 'out' AND status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT 1`, [enquiryId]);
  return last ? { enquiry: e, last } : null;
}

// Whether a reply in the inbox can arrive yet: the conversation it answers must exist, be with the
// agent, and, for a pick, have times on offer.
export function ready(db, sample) {
  if (!sample.reply) return true;
  const th = findThread(db, sample.channel, headers(sample.channel, sample.raw));
  if (!th || th.enquiry.stage !== 'open') return false;
  if (!sample.needsOffer) return true;
  return !!one(
    db,
    `SELECT 1 FROM offers o JOIN messages m ON m.id = o.message_id WHERE o.enquiry_id = ? AND m.status = 'sent' LIMIT 1`,
    [th.enquiry.id],
  );
}

const area = (db) => (zip) => areaOf(db, zip);

export function ingest(db, sample) {
  const t = now(db);
  const { channel, raw } = sample;
  const head = headers(channel, raw);
  const repeat = one(
    db,
    `SELECT id, contact_id, enquiry_id, received_at FROM inbound
      WHERE channel = ? AND raw = ? AND received_at >= ? AND contact_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [channel, raw, t - REPEAT_WINDOW],
  );
  run(db, 'INSERT INTO inbound (channel, received_at, raw, words, text_ok) VALUES (?, ?, ?, ?, ?)', [
    channel,
    t,
    raw,
    wordsOf(channel, raw),
    channel === 'referral' ? (head.textOk ? 1 : 0) : null,
  ]);
  const inboundId = lastId(db);
  const result = { inboundId, channel, at: t, candidates: [], policy: POLICY };

  if (repeat) {
    run(db, `UPDATE inbound SET outcome = 'duplicate', contact_id = ?, enquiry_id = ? WHERE id = ?`, [repeat.contact_id, repeat.enquiry_id, inboundId]);
    return { ...result, person: 'duplicate', repeat, contactId: repeat.contact_id, enquiryId: repeat.enquiry_id };
  }

  // The agent's reading, then code's checks on it.
  const out = sample.agent;
  const { fields: f, rows } = check(out, area(db));
  run(
    db,
    `UPDATE inbound SET name = ?, phone = ?, email = ?, email_suggestion = ?, zip = ?, service = ?, summary = ?, urgent = ?, intent = ?, agent_output = ?
      WHERE id = ?`,
    [f.name, f.phone, f.email, f.emailSuggestion, f.zip, f.service, f.summary, f.urgent ? 1 : 0, out.intent, JSON.stringify(out), inboundId],
  );
  Object.assign(result, { out, rows, fields: f });

  const thread = findThread(db, channel, head);
  if (thread) {
    const e = thread.enquiry;
    linkToContact(db, inboundId, e.contact_id, {
      rule: 'reply',
      reason: `reply to our ${thread.last.channel === 'sms' ? 'text' : 'email'} of ${fmtTime(thread.last.sent_at)}`,
    });
    const placement = { action: 'reply', ...addToEnquiry(db, e.id, inboundId) };
    const agent = respond(db, inboundId);
    processDue(db);
    return { ...result, person: 'reply', thread, contactId: e.contact_id, placement, agent };
  }

  const cands = candidates(db, f);
  result.candidates = cands;
  const top = cands[0];
  if (top && top.score >= POLICY.auto) {
    linkToContact(db, inboundId, top.contact.id, { rule: 'auto-merge', score: top.score, reason: `score ${top.score}: ${reasonText(top.reasons)}` });
    const placement = placeLead(db, inboundId, top.contact.id);
    const agent = respond(db, inboundId);
    processDue(db);
    return { ...result, person: 'merged', contactId: top.contact.id, placement, agent };
  }
  if (top && top.score >= POLICY.review) {
    run(db, 'INSERT INTO match_reviews (inbound_id, contact_id, score, reasons) VALUES (?, ?, ?, ?)', [
      inboundId,
      top.contact.id,
      top.score,
      JSON.stringify(top.reasons),
    ]);
    run(db, `UPDATE inbound SET outcome = 'review' WHERE id = ?`, [inboundId]);
    return { ...result, person: 'review', contactId: top.contact.id };
  }
  const contactId = createContact(db, inboundId);
  const placement = { action: 'opened', why: 'First enquiry from this person.', ...openEnquiry(db, contactId, inboundId) };
  const agent = respond(db, inboundId);
  processDue(db);
  return { ...result, person: 'new', contactId, placement, agent };
}

// The owner's answer to "is this the same person?". The agent replies once it is known.
export function decideReview(db, reviewId, same) {
  const r = one(db, 'SELECT * FROM match_reviews WHERE id = ?', [reviewId]);
  if (!r || r.status !== 'open') throw new Error('This has already been decided');
  run(db, 'UPDATE match_reviews SET status = ?, decided_at = ? WHERE id = ?', [same ? 'merged' : 'separate', now(db), reviewId]);
  let contactId = r.contact_id;
  if (same) {
    linkToContact(db, r.inbound_id, r.contact_id, {
      rule: 'owner-merge',
      score: r.score,
      reason: `confirmed by the owner (score ${r.score}: ${reasonText(JSON.parse(r.reasons))})`,
    });
  } else {
    contactId = as('automation', () => createContact(db, r.inbound_id, { outcome: 'separate', reason: `The owner ruled it is not ${personLabel(getContact(db, r.contact_id))}` }));
  }
  const placement = as('automation', () => placeLead(db, r.inbound_id, contactId));
  const agent = respond(db, r.inbound_id);
  processDue(db);
  return { contactId, placement, agent };
}
