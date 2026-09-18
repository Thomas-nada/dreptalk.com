-- migrations/0109_caps.sql
-- One row per Constitutional Amendment Proposal (CAP) or Constitutional Issue
-- Statement (CIS) mirrored from the CAP portal's CIP-100 feed by the gov-sync cron. The
-- portal is an off-chain source, so unlike governance_actions there is no
-- anchor/tally column here: a CAP is a document with a discussion, not an
-- on-chain vote. `number` is the portal's own proposal id, unique across both
-- document types. `topic_id` is NULL until the mirror opens the thread, then
-- points at the forum topic whose opening post is the CAP body and whose
-- replies are the mirrored portal comments (posts.source = 'cap'). The mirror
-- is idempotent: a re-sync upserts this row and rewrites the thread in place
-- rather than opening a second one, so `content_hash` is what a run compares to
-- decide whether the body changed since it last reconciled. `versions_json`
-- holds the CIP-100 version history verbatim (each entry with its content), the
-- source for the thread page's version switcher.
CREATE TABLE caps (
  number         INTEGER PRIMARY KEY, -- portal proposal id (CAP-N / CIS-N share one namespace)
  doc_type       TEXT NOT NULL,       -- 'CAP' or 'CIS'
  title          TEXT,
  category       TEXT,                -- Substantive / Procedural / Technical / ...
  status         TEXT,                -- consultation / ready / done / ...
  content_hash   TEXT,                -- portal content hash of the current version
  current_version INTEGER,            -- latest version number in the portal's chain
  source_url     TEXT,               -- canonical CAP portal page for this proposal
  submitted_at   INTEGER,             -- first-submission time, unix ms (the thread's post date)
  versions_json  TEXT,                -- CIP-100 versionHistory as JSON (each entry with content), or NULL
  topic_id       TEXT,                -- forum topic once the thread is opened, else NULL
  created_at     INTEGER NOT NULL,    -- when this row was first stored, unix ms
  last_synced_at INTEGER NOT NULL     -- last mirror reconciliation, unix ms
);

CREATE INDEX idx_caps_topic ON caps(topic_id);
