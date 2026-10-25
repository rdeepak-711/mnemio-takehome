-- 003_deliverability: T22 mailboxes, pauses and the per-send delivery columns (D66–D70).
-- Times are simulated time written by the code (D33). The seed doesn't change: seeded sends keep
-- mailbox_id and recipient_domain NULL and headers '{}', so "engine send" means mailbox_id IS NOT NULL.

CREATE TABLE mailboxes (
  id int PRIMARY KEY,
  address text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,          -- sim time of creation = the first warm-up start
  warmup_started_at timestamptz NOT NULL,   -- moves to resume_at at each pause (D67)
  paused_until timestamptz NULL
);

CREATE TABLE mailbox_pauses (
  id serial PRIMARY KEY,
  mailbox_id int NOT NULL REFERENCES mailboxes (id),
  paused_at timestamptz NOT NULL,
  resume_at timestamptz NOT NULL,
  bounce_rate real NOT NULL,
  sample int NOT NULL
);

ALTER TABLE contacts ADD COLUMN mailbox_id int NULL REFERENCES mailboxes (id);

ALTER TABLE sends
  ADD COLUMN mailbox_id int NULL REFERENCES mailboxes (id),
  ADD COLUMN recipient_domain text NULL,
  ADD COLUMN headers jsonb NOT NULL DEFAULT '{}';

CREATE INDEX sends_mailbox_day_idx ON sends (mailbox_id, sent_at) WHERE mailbox_id IS NOT NULL;
CREATE INDEX sends_domain_day_idx ON sends (recipient_domain, sent_at) WHERE mailbox_id IS NOT NULL;
