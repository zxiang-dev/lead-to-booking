# Lead to Booking

An AI agent replies to every enquiry within a minute, day or night, and books visits onto the calendar. Code checks its work, the database decides what it may send, and only the exceptions reach the owner. Runs in the browser on in-memory SQLite (sql.js) and a simulated clock.

## The model call

One call per incoming message. The model reads the message into fields and drafts a short reply, returned as JSON. Everything around it is code:

- **Before:** repeat deliveries are caught from the raw text. Replies are threaded to the conversation they answer.
- **After:** phone numbers are normalised, email domains checked for typos, ZIP codes checked against the service area, the service checked against the list.
- **Matching:** each message is matched to a person (email, phone, name, ZIP) and to a job. Uncertain matches go to the owner.
- **Times:** taken from the calendar. The model never writes them.

On the page, the model's answers were generated in advance from `assets/intake/prompt.js` and are replayed, so no API key is needed. In use, the call is live.

## What the agent may send

Each reply is graded:

- **Routine:** high confidence, in the area, no flags.
- **Judgement call:** low confidence, or outside the area.
- **Hard stop:** a price question, a complaint, instructions to the agent, or no way to reach the customer.

A database trigger then allows or refuses the send, by mode:

- **Approve every reply:** nothing goes out alone.
- **Send routine replies:** routine replies go out.
- **Send all it safely can:** everything but hard stops.

The trigger also refuses any agent reply containing a price. Refused drafts go to the owner to send, edit or close. If nobody acts within 15 business minutes, a holding reply goes out. Confirmations and reminders are fixed templates and go out in every mode.

## Consent to text

Referral sheets have an `ok_to_text` column, read by code. Without a yes, the agent emails instead. With no email either, the reply waits for the owner to call; sending it records consent. A trigger refuses any automated text without consent.

## Bookings and check-ins

Customers book by replying with the number of a time. The database refuses a clash, a past time or a time not offered; the customer then gets fresh times. Urgent jobs get the first free time; others start two workdays out. If the customer goes quiet: fresh times after a day, a last check-in after three days, long-term follow-up after seven. Check-ins stop on booking and restart when the customer writes.

Triggers write the audit log, so no action can skip it.

## Files

- `assets/db.js`: schema, send rules, booking rules, audit triggers
- `assets/time.js`: simulated clock, office hours
- `assets/engine.js`: contacts, enquiries, messages, bookings, check-ins
- `assets/agent.js`: checks, grading, the agent's turn, the owner's decisions
- `assets/owner.js`: the "Needs you" queue
- `assets/seed.js`: service area, calendar, a week of history
- `assets/intake/`: envelope and field checks, matching, prompt, sample messages, tab view
- `assets/convo/view.js`: reporting, conversations, visit calendar
- `assets/app.js`, `assets/ui.js`: tabs, agent mode, clock, Reset, shared helpers

## Run locally

```bash
python -m http.server 8766
```

Open http://localhost:8766/. ES modules need HTTP, so opening `index.html` from disk won't work.
