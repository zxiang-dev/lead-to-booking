// What the agent does once a message is matched to a person and a conversation. It drafts a reply
// from its reading of the message; checks in code grade the risk; then it tries to send. Whether it
// may is decided by the database (the send and consent guards in db.js), so nothing in a message can
// talk it past the rules. Anything refused becomes a task for the owner, with the draft ready to
// send, edit or discard.
import { one, run, as, audit } from './db.js';
import {
  now, getContact, getEnquiry, getInbound, getMessage, draft, trySend, bookOption, openTask, closeEnquiry, scheduleFollowups, CLOSED,
} from './engine.js';
import { personLabel } from './terms.js';

const CONFIDENCE = 0.8;

// Plain rules on the customer's own words, run alongside the agent's flags.
const PRICE_WORDS = /\bhow much\b|\bballpark\b|\bprices?\b|\bcosts?\b|\bwhat do you charge\b|\bdiscount|\bfree of charge\b|\bno charge\b|\bfor free\b/i;
const INSTRUCTION_WORDS =
  /\bignore (?:all |any |your |the )?(?:previous |prior |earlier )?instructions\b|\b(?:note|message) to the (?:ai|assistant|bot|agent)\b|\bsystem prompt\b|\byou are now\b/i;

// One line per check: level ok | soft (a judgement call) | hard (only the owner may send).
function checksFor(i, e, out) {
  const flags = out.flags ?? [];
  const words = i.words ?? '';
  const by = (flag, re) => {
    const model = flags.includes(flag);
    const rule = re.test(words);
    if (!model && !rule) return null;
    return model && rule ? 'by the agent and by a rule' : model ? 'by the agent' : 'by a rule';
  };
  const list = [];
  const conf = out.confidence ?? 0;
  list.push(
    conf >= CONFIDENCE
      ? { level: 'ok', text: `Read with confidence ${conf.toFixed(2)} (${CONFIDENCE.toFixed(2)} needed)` }
      : { level: 'soft', text: `Confidence ${conf.toFixed(2)}, below ${CONFIDENCE.toFixed(2)}`, reason: 'job unclear' },
  );
  if (e.zip && !e.area) list.push({ level: 'soft', text: `ZIP ${e.zip} is outside the service area`, reason: 'outside the service area' });
  else if (e.area) list.push({ level: 'ok', text: `ZIP ${e.zip} in the service area (${e.area})` });
  else list.push({ level: 'ok', text: 'No ZIP; the reply asks for it' });
  const price = by('price_question', PRICE_WORDS);
  list.push(price ? { level: 'hard', text: `Asks about price, flagged ${price}`, reason: 'asks about price' } : { level: 'ok', text: 'No price question' });
  const instr = by('instructions_in_message', INSTRUCTION_WORDS);
  list.push(
    instr
      ? { level: 'hard', text: `Instructions to the agent, flagged ${instr}`, reason: 'instructions to the agent' }
      : { level: 'ok', text: 'No instructions to the agent' },
  );
  if (flags.includes('complaint')) list.push({ level: 'hard', text: 'A complaint, flagged by the agent', reason: 'a complaint' });
  if (i.channel === 'referral') {
    if (e.text_ok) list.push({ level: 'ok', text: 'Agreed to texts' });
    else if (e.reply_via === 'email') list.push({ level: 'ok', text: 'No consent to text; reply by email' });
    else list.push({ level: 'hard', text: 'No consent to text, no email', reason: 'no consent to text, no email. Call first; sending records their consent', consent: true });
  }
  return list;
}

const riskOf = (checks) => (checks.some((c) => c.level === 'hard') ? 'hard' : checks.some((c) => c.level === 'soft') ? 'soft' : 'routine');

// Why a draft waits for the owner: the checks that failed, or the mode.
function reasonFor(checks, blocked) {
  const failed = checks.filter((c) => c.reason);
  const hard = failed.filter((c) => c.level === 'hard');
  return (hard.length ? hard : failed).map((c) => c.reason).join('; ') || blocked;
}

// After a reply goes out, by the agent or the owner: a decline or a closing reply ends the
// conversation; anything else starts the check-ins.
function afterSend(db, messageId) {
  const m = getMessage(db, messageId);
  const e = getEnquiry(db, m.enquiry_id);
  if (m.kind === 'decline') return closeEnquiry(db, e.id, 'lost', 'outside the service area');
  if (m.kind === 'closing') {
    const intent = m.inbound_id ? getInbound(db, m.inbound_id).intent : null;
    return intent === 'declined'
      ? closeEnquiry(db, e.id, 'lost', 'went with someone else')
      : closeEnquiry(db, e.id, 'nurture', 'the customer will come back to it later');
  }
  if (e.stage === 'owner') run(db, `UPDATE enquiries SET stage = 'open' WHERE id = ?`, [e.id]);
  scheduleFollowups(db, e.id, now(db));
}

// The agent's turn on one incoming message. Returns what happened, for the trace.
export function respond(db, inboundId) {
  const i = getInbound(db, inboundId);
  const out = JSON.parse(i.agent_output);
  const e = getEnquiry(db, i.enquiry_id);
  if (e.stage === 'owner') return { action: 'waiting', enquiryId: e.id };
  if (CLOSED.includes(e.stage)) return { action: 'closed', enquiryId: e.id };

  if (out.intent === 'choose_time') {
    const res = bookOption(db, e.id, out.option);
    return { action: res.ok ? 'booked' : 'clash', enquiryId: e.id, ...res };
  }

  const checks = checksFor(i, e, out);
  const risk = riskOf(checks);
  let kind;
  let addon = null;
  // A hard stop gets a holding reply, unless the only one is consent: then the owner gets the real
  // reply, to send once they've asked.
  if (checks.some((c) => c.level === 'hard' && !c.consent)) kind = 'holding';
  else if (['not_now', 'declined'].includes(out.intent)) kind = 'closing';
  else if (e.zip && !e.area) kind = 'decline';
  else if (!e.service) kind = 'clarify';
  else {
    kind = out.intent === 'question' ? 'answer' : 'reply';
    addon = e.zip ? 'times' : 'zip';
  }
  const messageId = as('agent', () => draft(db, e.id, { kind, words: out.reply, addon, risk, inboundId }));
  const res = trySend(db, messageId, 'agent');
  if (res.sent) {
    as('agent', () => afterSend(db, messageId));
    return { action: 'sent', enquiryId: e.id, checks, risk, kind, messageId };
  }
  const taskId = as('automation', () => openTask(db, e.id, messageId, risk, reasonFor(checks, res.blocked)));
  return { action: 'held', enquiryId: e.id, checks, risk, kind, messageId, blocked: res.blocked, taskId };
}

// ---- the owner's decisions on a task ----

const openTaskRow = (db, taskId) => {
  const k = one(db, 'SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!k || k.status !== 'open') throw new Error('This has already been dealt with');
  return k;
};

// Sends the agent's draft, or the owner's edit of it. The owner may write anything, prices included.
export function ownerSend(db, taskId, editedBody = null) {
  const k = openTaskRow(db, taskId);
  as('owner', () => {
    const m = getMessage(db, k.message_id);
    const edited = editedBody != null && editedBody.trim() !== m.body.trim();
    if (edited) {
      // The owner rewrote it: the times listed are theirs to keep or drop, so the offer stands only if they kept the list.
      const kind = ['decline', 'closing'].includes(m.kind) ? m.kind : 'owner';
      run(db, `UPDATE messages SET body = ?, author = 'owner', kind = ? WHERE id = ?`, [editedBody.trim(), kind, m.id]);
      if (!/Reply 1/.test(editedBody)) run(db, 'DELETE FROM offers WHERE message_id = ?', [m.id]);
    }
    // The task asked the owner to text only once they'd agreed, so sending records their consent.
    const e = getEnquiry(db, m.enquiry_id);
    if (m.channel === 'sms' && !e.text_ok) {
      run(db, 'UPDATE enquiries SET text_ok = 1 WHERE id = ?', [e.id]);
      audit(db, 'consent.recorded', `${personLabel(getContact(db, e.contact_id))}: agreed to texts, confirmed by the owner`);
    }
    const res = trySend(db, m.id, 'owner');
    if (!res.sent) throw new Error(res.blocked);
    run(db, 'UPDATE tasks SET status = ?, done_at = ? WHERE id = ?', [edited ? 'edited' : 'sent', now(db), taskId]);
    afterSend(db, m.id);
  });
}

// Discards the draft and closes the enquiry: spam, or work the owner won't take.
export function ownerClose(db, taskId) {
  const k = openTaskRow(db, taskId);
  as('owner', () => {
    run(db, `UPDATE messages SET status = 'discarded' WHERE id = ?`, [k.message_id]);
    run(db, `UPDATE tasks SET status = 'closed', done_at = ? WHERE id = ?`, [now(db), taskId]);
    closeEnquiry(db, k.enquiry_id, 'lost', 'closed by the owner');
  });
}

