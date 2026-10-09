// Reference data and the week of history the page opens with. The history is replayed through the
// same code as the inbox, at the times it happened: each message is matched, the agent replies,
// customers pick times, check-ins fall due and the owner steps in where needed. Days count from the
// Monday the records start (day 0); the clock opens on day 7, this Monday, at 09:00.
import { run, one, as } from './db.js';
import { DAY, START } from './time.js';
import { advance } from './engine.js';
import { ownerSend, ownerClose } from './agent.js';
import { ingest } from './intake/match.js';

const SERVICE_AREA = [
  ['North', ['78727', '78728', '78729', '78750', '78758', '78759']],
  ['Central', ['78701', '78702', '78703', '78704', '78705', '78751', '78756']],
  ['South', ['78744', '78745', '78747', '78748', '78749']],
];

const SLOT_HOURS = [9, 11, 14, 16];

const at = (day, time) => {
  const [h, m] = time.split(':').map(Number);
  return day * DAY + h * 60 + m;
};

// A new message: who wrote, how, and what the agent replied. `pick` is a customer texting back the
// number of a time; `re` is an email reply in an existing thread; `owner` is the owner acting on
// the task for that person: send the draft, send it edited (`body`), or close.
const HISTORY = [
  { at: [0, '08:40'], channel: 'call', name: 'Derek Hall', phone: '+1 512 555 0126', service: 'plumbing', words: 'Toilet keeps running, please call back.', reply: 'Sorry we missed your call. We can sort out the toilet, and you can book a visit by replying to this text.' },
  { at: [0, '09:05'], channel: 'web', name: 'Derek Hall', phone: '(512) 555-0126', email: 'derek.hall@gmail.com', zip: '78747', service: 'plumbing', words: 'Toilet keeps running and the shut-off valve is stuck.', reply: 'Thanks for the details. We can look at the stuck valve on the same visit.' },
  { at: [0, '09:20'], pick: 2, phone: '+1 512 555 0126', text: '2 works' },
  { at: [0, '11:00'], channel: 'referral', name: 'Kevin Moore', phone: '512-555-0124', email: 'kevin.moore@gmail.com', zip: '78751', service: 'roofing', words: 'Hail damage inspection for an insurance claim', referredBy: 'Cedar Property Management', reply: 'Cedar Property Management passed on your details. We do hail inspections for insurance claims and write up what we find.' },
  { at: [0, '11:40'], pick: 1, phone: '512-555-0124', text: '1 please' },
  { at: [0, '14:00'], channel: 'email', name: 'Sarah Quinn', phone: '512.555.0125', email: 'sarah.quinn@gmail.com', zip: '78702', service: 'hvac', subject: 'Ductless AC for a garage office', words: "We're thinking about a ductless AC for a garage office.", reply: 'Thanks for getting in touch. A ductless unit suits a garage office well, and a visit lets us check where it would go.' },
  { at: [1, '09:30'], channel: 'web', name: 'Nina Shah', phone: '512-555-0120', email: 'nina.shah@gmail.com', zip: '78759', service: 'roofing', words: 'Skylight flashing needs resealing.', reply: 'Thanks, resealing skylight flashing is a regular job for us.' },
  { at: [1, '10:00'], pick: 3, phone: '512-555-0120', text: '3 please' },
  { at: [1, '12:00'], channel: 'web', name: 'Chris Lane', phone: '512-555-0128', email: 'chris.lane@gmail.com', zip: '78620', service: 'roofing', words: 'New metal roof for a barn.', reply: "Thanks for thinking of us. Unfortunately 78620 is outside the area we cover, so we can't take this one on." },
  { at: [1, '12:10'], owner: 'send', who: 'Chris Lane' },
  { at: [1, '15:00'], channel: 'referral', name: 'Paul Grant', phone: '512-555-0121', email: 'paul.grant@gmail.com', zip: '78744', service: 'plumbing', words: 'Replace kitchen and bathroom fixtures', referredBy: 'Northside Realty', reply: 'Northside Realty passed on your details. Happy to quote for new fixtures in both rooms.' },
  { at: [1, '15:20'], pick: 1, phone: '512-555-0121', text: '1' },
  { at: [2, '09:00'], channel: 'web', name: 'Eva Novak', phone: '(512) 555-0122', email: 'eva.novak@gmail.com', zip: '78729', service: 'hvac', words: 'New AC system quote for a three-bedroom house.', reply: 'Happy to quote for a new system. A visit lets us size it properly for the house.' },
  { at: [2, '09:45'], pick: 2, phone: '(512) 555-0122', text: 'Option 2 is good' },
  { at: [2, '10:05'], channel: 'web', name: 'Linda Park', phone: '(512) 555-0110', email: 'linda.park@gmail.com', zip: '78759', service: 'roofing', words: 'Missing shingles after the storm, would like someone to take a look.', reply: "Sorry the storm got your roof. We'll check the missing shingles and anything else it loosened." },
  { at: [2, '13:00'], channel: 'web', name: 'Hannah Scott', phone: '(512) 555-0118', email: 'hannah.scott@gmail.com', zip: '78748', service: 'hvac', words: 'Thermostat replacement and AC tune-up.', reply: 'We can do both on one visit: the new thermostat and the tune-up.' },
  { at: [2, '13:10'], pick: 1, phone: '(512) 555-0110', text: 'The first one, thanks' },
  { at: [3, '09:10'], channel: 'web', name: 'Aisha Bello', phone: '512-555-0116', email: 'aisha.bello@gmail.com', zip: '78745', service: 'plumbing', words: 'Slow drains in two bathrooms.', reply: 'Slow drains in two rooms often share a cause, so one visit should cover both.' },
  { at: [3, '09:30'], pick: 1, phone: '512-555-0116', text: '1' },
  { at: [3, '10:00'], re: 'Ductless AC for a garage office', name: 'Sarah Quinn', email: 'sarah.quinn@gmail.com', service: 'hvac', words: "We've gone with another company in the end, thanks anyway.", intent: 'declined', reply: 'Thanks for letting us know, and good luck with the new unit.' },
  { at: [3, '11:00'], channel: 'email', name: 'Ben Carter', phone: '512 555 0113', email: 'ben.carter@gmail.com', zip: '78728', service: 'hvac', subject: 'Furnace check before winter', words: 'Could someone check our furnace before winter?', reply: 'Good idea to check it before the cold sets in.' },
  { at: [3, '14:30'], channel: 'referral', name: 'Omar Haddad', phone: '512-555-0111', email: 'omar.haddad@gmail.com', zip: '78703', service: 'hvac', words: 'AC unit making a grinding noise', referredBy: 'Northside Realty', reply: 'Northside Realty passed on your details. A grinding noise is worth a look before it gets worse.' },
  { at: [3, '15:10'], pick: 3, phone: '512-555-0111', text: '3 works for me' },
  { at: [3, '16:40'], pick: 1, phone: '(512) 555-0118', text: '1 please, sorry for the slow reply' },
  { at: [3, '22:15'], channel: 'web', name: 'Grace Kim', phone: '512.555.0112', email: 'grace.kim@gmail.com', zip: '78750', service: 'roofing', words: 'Quote for a full roof replacement on a two-storey house.', reply: 'Happy to quote for a full replacement. A visit lets us measure up and check the decking.' },
  { at: [4, '07:50'], pick: 2, phone: '512.555.0112', text: 'Number 2 please' },
  { at: [4, '09:40'], channel: 'email', name: 'Paul Grant', phone: '512-555-0121', email: 'paul.grant@gmail.com', zip: '78744', service: 'roofing', subject: 'Garage roof', words: 'Separate job: the roof over the garage is sagging, could someone take a look?', reply: 'A sagging roof is worth a look soon, so here are the next times we can come.' },
  { at: [4, '10:00'], channel: 'email', name: 'Luis Romero', phone: '512.555.0117', email: 'luis.romero@gmail.com', zip: '78704', service: 'roofing', subject: 'Roof inspection', words: "We're listing the house next month and need a roof inspection first. What do you charge for one?", intent: 'question', flags: ['price_question'], reply: 'Thanks for asking. The owner will get back to you about the cost directly.' },
  { at: [4, '10:30'], owner: 'edit', who: 'Luis Romero', body: "Hi Luis,\nA pre-listing roof inspection is $195, with a written report the same day. Reply here if you'd like to book one.\n— Owner" },
  { at: [4, '10:50'], re: 'Roof inspection', name: 'Luis Romero', email: 'luis.romero@gmail.com', service: 'roofing', words: "Yes please, let's book it.", intent: 'follow_up', reply: 'Great, here are the next times we can do the inspection.' },
  { at: [4, '11:05'], re: 'Roof inspection', name: 'Luis Romero', email: 'luis.romero@gmail.com', words: 'Number 2, please.', intent: 'choose_time', option: 2 },
  { at: [4, '11:30'], channel: 'email', name: 'Mark Ellis', phone: '512 555 0119', email: 'mark.ellis@gmail.com', zip: '78749', service: 'plumbing', subject: 'Outdoor faucet', words: 'Our outdoor faucet is leaking against the wall.', reply: 'A leak against the wall is worth catching early.' },
  { at: [4, '15:20'], channel: 'web', name: 'Rosa Diaz', phone: '(512) 555-0114', email: 'rosa.diaz@gmail.com', zip: '78758', service: 'plumbing', words: 'Water heater replacement quote.', reply: 'Happy to quote for a new water heater. A short visit lets us check the size and the fittings first.' },
  { at: [4, '16:00'], pick: 1, phone: '(512) 555-0114', text: '1 is great' },
  { at: [4, '16:45'], channel: 'referral', name: 'Tom Becker', phone: '512-555-0115', email: 'tom.becker@gmail.com', zip: '78727', service: 'roofing', words: 'Gutter and fascia repair on the north side', referredBy: 'Cedar Property Management', reply: 'Cedar Property Management passed on your details. We can look at the gutters and fascia together.' },
];

const callerId = (name) => {
  const parts = name.trim().split(/\s+/);
  return `${parts.at(-1)} ${parts[0][0]}`.toUpperCase();
};

// The message as the channel would have delivered it.
function compose(h) {
  if (h.pick) return { channel: 'sms', raw: `Text message\nFrom: ${h.phone}\nText: ${h.text}` };
  if (h.re) return { channel: 'email', raw: `From: ${h.name} <${h.email}>\nSubject: Re: ${h.re}\n\n${h.words}\n\n${h.name.split(' ')[0]}` };
  if (h.channel === 'web') {
    return {
      channel: 'web',
      raw: ['Form: Request an estimate', `Name: ${h.name}`, `Phone: ${h.phone}`, `Email: ${h.email}`, `ZIP: ${h.zip}`, `Message: ${h.words}`].join('\n'),
    };
  }
  if (h.channel === 'call') return { channel: 'call', raw: `Missed call\nFrom: ${h.phone}\nCaller ID: ${callerId(h.name)}\nVoicemail: "${h.words}"` };
  if (h.channel === 'email') {
    return {
      channel: 'email',
      raw: `From: ${h.name} <${h.email}>\nSubject: ${h.subject}\n\nHi,\n\n${h.words} We're in ${h.zip}.\n\nThanks,\n${h.name}\nMobile ${h.phone}`,
    };
  }
  const cell = (v) => (/[",]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ''));
  return { channel: 'referral', raw: `referred_by,client_name,phone,email,zip,need,ok_to_text\n${[h.referredBy, h.name, h.phone, h.email, h.zip, h.words, 'yes'].map(cell).join(',')}` };
}

// The agent's reading of a history message, in the same shape as the inbox samples.
function sample(h) {
  const { channel, raw } = compose(h);
  const name = h.pick ? null : h.channel === 'call' ? callerId(h.name) : h.name;
  return {
    channel,
    raw,
    agent: {
      contact: { name, phone: h.re ? null : (h.phone ?? null), email: h.email ?? null },
      job: { service: h.service ?? null, zip: h.zip ?? null, urgent: false, summary: h.words ?? h.text },
      intent: h.pick ? 'choose_time' : (h.intent ?? (h.re ? 'follow_up' : 'new_request')),
      option: h.pick ?? h.option ?? null,
      tone: 'neutral',
      confidence: 0.95,
      flags: h.flags ?? [],
      reply: h.reply ?? null,
    },
  };
}

function ownerActs(db, h) {
  const task = one(
    db,
    `SELECT k.id FROM tasks k JOIN enquiries e ON e.id = k.enquiry_id JOIN contacts c ON c.id = e.contact_id
      WHERE c.name = ? AND k.status = 'open' ORDER BY k.id DESC LIMIT 1`,
    [h.who],
  );
  if (h.owner === 'close') ownerClose(db, task.id);
  else ownerSend(db, task.id, h.owner === 'edit' ? h.body : null);
}

export function seed(db) {
  run(db, 'INSERT INTO clock (id, now) VALUES (1, 0)');
  run(db, `INSERT INTO settings (id, mode) VALUES (1, 'routine')`);
  for (const [area, zips] of SERVICE_AREA) for (const zip of zips) run(db, 'INSERT INTO service_area (zip, area) VALUES (?, ?)', [zip, area]);
  // Four estimate visits each weekday, from the week the records start to three weeks out.
  for (let d = 0; d < 28; d++) {
    if (d % 7 >= 5) continue;
    for (const h of SLOT_HOURS) run(db, 'INSERT INTO slots (start_at) VALUES (?)', [d * DAY + h * 60]);
  }
  for (const h of [...HISTORY].sort((a, b) => at(...a.at) - at(...b.at))) {
    advance(db, at(...h.at), { quiet: true });
    if (h.owner) ownerActs(db, h);
    else as('automation', () => ingest(db, sample(h)));
  }
  advance(db, START, { quiet: true });
  // The audit triggers come later (installAudit), but code writes a few entries directly.
  run(db, 'DELETE FROM audit_log');
}
