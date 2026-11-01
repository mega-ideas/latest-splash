-- A person belongs to ONE business (v2 Phase 3 review, High).
--
-- The invitation and add-directly paths checked "is this person already on a
-- business?" and then inserted. Under READ COMMITTED two requests at the same
-- moment cannot see each other's uncommitted row, so both checks passed and
-- both committed. The database now refuses the second row, whatever the code
-- checked, and the code takes a per-person lock as well (lockPerson).
--
-- If any person already holds more than one membership, this migration stops
-- and says so instead of choosing one for them: which business a person
-- stays on is a decision for the owners and Splash support, not a script.
-- Resolve those rows (remove the extra membership through the team page or the
-- support console), then run the migration again.
--
-- The plain index on user_id is replaced by the unique one: it serves the same
-- lookups.

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (SELECT user_id FROM memberships GROUP BY user_id HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'memberships_user_unique: % people hold more than one membership; resolve them before this migration (SELECT user_id, count(*) FROM memberships GROUP BY user_id HAVING count(*) > 1)', n;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_user_unique" ON "memberships" ("user_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "memberships_user_idx";
