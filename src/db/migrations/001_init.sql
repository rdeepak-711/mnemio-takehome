-- 001_init: every table from the data model (spec/site.md), constraints per tasks/T08-schema.md.
-- No DEFAULT now() on business tables: their timestamps are simulated time written by the code (D33).
-- Only llm_cache and llm_usage (and schema_migrations, created by migrate.ts) use real time.

CREATE TABLE contacts (
  id serial PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  industry text NOT NULL,
  role text NOT NULL,
  role_family text NOT NULL,
  timezone text NOT NULL,
  segment text NOT NULL,
  priority boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  next_action text NULL,
  next_action_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT contacts_email_key UNIQUE (email),
  CONSTRAINT contacts_status_check CHECK (
    status IN (
      'new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent',
      'replied', 'bounced', 'unsubscribed', 'deactivated'
    )
  ),
  CONSTRAINT contacts_next_action_check CHECK (
    next_action IN ('first', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'deactivate')
  ),
  CONSTRAINT contacts_industry_check CHECK (
    industry IN ('saas', 'ecommerce', 'fintech', 'healthcare', 'logistics')
  ),
  CONSTRAINT contacts_role_family_check CHECK (role_family IN ('founder', 'sales', 'ops_finance', 'tech')),
  CONSTRAINT contacts_segment_check CHECK (segment = role_family || ':' || industry),
  CONSTRAINT contacts_next_action_pair_check CHECK ((next_action IS NULL) = (next_action_at IS NULL)),
  -- Written as CASE so a NULL next_action on an in-sequence status evaluates to false, not NULL
  -- (a CHECK that evaluates to NULL passes).
  CONSTRAINT contacts_status_next_action_check CHECK (
    CASE
      WHEN status IN ('replied', 'bounced', 'unsubscribed', 'deactivated') THEN next_action IS NULL
      ELSE next_action IS NOT NULL
        AND (status, next_action) IN (
          ('new', 'first'),
          ('first_sent', 'follow_up_1'),
          ('follow_up_1_sent', 'follow_up_2'),
          ('follow_up_2_sent', 'follow_up_3'),
          ('follow_up_3_sent', 'deactivate')
        )
    END
  )
);

CREATE INDEX contacts_next_action_at_idx ON contacts (next_action_at) WHERE next_action_at IS NOT NULL;

CREATE TABLE sends (
  id serial PRIMARY KEY,
  contact_id int NOT NULL REFERENCES contacts (id),
  step text NOT NULL,
  idempotency_key text NOT NULL,
  outcome text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  template_source text NOT NULL,
  sent_at timestamptz NOT NULL,
  CONSTRAINT sends_step_check CHECK (step IN ('first', 'follow_up_1', 'follow_up_2', 'follow_up_3')),
  -- The double-send guard.
  CONSTRAINT sends_contact_id_step_key UNIQUE (contact_id, step),
  CONSTRAINT sends_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT sends_idempotency_key_check CHECK (idempotency_key = contact_id::text || ':' || step),
  CONSTRAINT sends_outcome_check CHECK (outcome IN ('accepted', 'bounced')),
  CONSTRAINT sends_template_source_check CHECK (template_source IN ('cache', 'ai', 'fallback'))
);

CREATE TABLE replies (
  id serial PRIMARY KEY,
  contact_id int NOT NULL REFERENCES contacts (id),
  send_id int NOT NULL REFERENCES sends (id),
  body text NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL,
  true_label text NOT NULL,
  label text NULL,
  label_source text NULL,
  return_date date NULL,
  classified_at timestamptz NULL,
  CONSTRAINT replies_true_label_check CHECK (
    true_label IN ('interested', 'not_interested', 'out_of_office', 'unsubscribe')
  ),
  CONSTRAINT replies_label_check CHECK (
    label IN ('interested', 'not_interested', 'out_of_office', 'unsubscribe', 'needs_review')
  ),
  CONSTRAINT replies_label_source_check CHECK (label_source IN ('rule', 'ai', 'fallback'))
);

CREATE INDEX replies_unlabelled_idx ON replies (id) WHERE label IS NULL;

CREATE TABLE suppression (
  email text PRIMARY KEY,
  reason text NOT NULL,
  added_at timestamptz NOT NULL,
  CONSTRAINT suppression_reason_check CHECK (reason IN ('unsubscribed', 'bounced'))
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  contact_id int NOT NULL REFERENCES contacts (id),
  type text NOT NULL,
  data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT events_type_check CHECK (type IN ('status_changed', 'sent', 'reply_received', 'rescheduled'))
);

CREATE INDEX events_contact_id_idx ON events (contact_id);
CREATE INDEX events_occurred_at_idx ON events (occurred_at);

CREATE TABLE sim_clock (
  id int PRIMARY KEY,
  now timestamptz NOT NULL,
  CONSTRAINT sim_clock_id_check CHECK (id = 1)
);

-- The mock provider's own memory. It stands in for an outside service, so it references nothing (D31).
CREATE TABLE mock_outbox (
  idempotency_key text PRIMARY KEY,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL,
  CONSTRAINT mock_outbox_outcome_check CHECK (outcome IN ('accepted', 'bounced'))
);

CREATE TABLE mock_inbox (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  body text NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  true_label text NOT NULL,
  deliver_at timestamptz NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  CONSTRAINT mock_inbox_true_label_check CHECK (
    true_label IN ('interested', 'not_interested', 'out_of_office', 'unsubscribe')
  )
);

CREATE INDEX mock_inbox_due_idx ON mock_inbox (deliver_at) WHERE NOT delivered;

CREATE TABLE llm_cache (
  key text PRIMARY KEY,
  kind text NOT NULL,
  response jsonb NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_cache_kind_check CHECK (kind IN ('sequence', 'classification'))
);

CREATE TABLE llm_usage (
  day date PRIMARY KEY,
  calls int NOT NULL DEFAULT 0,
  CONSTRAINT llm_usage_calls_check CHECK (calls >= 0)
);
