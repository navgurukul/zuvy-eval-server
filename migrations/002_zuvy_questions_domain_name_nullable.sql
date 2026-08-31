-- Non-breaking: keep existing domain_name values (including empty strings).
-- New rows may omit domain_name (NULL).
ALTER TABLE "__SCHEMA__"."zuvy_questions"
  ALTER COLUMN "domain_name" DROP NOT NULL;
