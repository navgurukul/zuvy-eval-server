-- Manual SQL helper (if you don't use Drizzle migrations)
-- Adds org_id to main.zuvy_questions so generated questions can be mapped to an org.

ALTER TABLE zuvy_questions
ALTER COLUMN "orgId" TYPE integer
USING "orgId"::integer;
ALTER TABLE zuvy_questions
ADD CONSTRAINT zuvy_questions_org_id_fkey
FOREIGN KEY ("orgId")
REFERENCES zuvy_organizations(id)
ON DELETE CASCADE;

SELECT DISTINCT q."orgId"
FROM zuvy_questions q
LEFT JOIN zuvy_organizations o
  ON q."orgId" = o.id
WHERE o.id IS NULL;


SELECT
    q."orgId",
    COUNT(*) AS question_count
FROM zuvy_questions q
GROUP BY q."orgId"
ORDER BY q."orgId";

DELETE FROM zuvy_questions q
WHERE NOT EXISTS (
    SELECT 1
    FROM zuvy_organizations o
    WHERE o.id = q."orgId"
);
