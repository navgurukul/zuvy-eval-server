-- Run before deploying the org-scoped Topic APIs.
-- Existing rows need a valid organization value before enforcing NOT NULL.
ALTER TABLE topic
ALTER COLUMN org_id TYPE integer
USING org_id::integer;

ALTER TABLE topic
ADD CONSTRAINT topic_org_id_fkey
FOREIGN KEY (org_id)
REFERENCES zuvy_organizations(id)
ON DELETE CASCADE;