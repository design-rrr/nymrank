-- Reset last_activity_check to NULL so all users get re-checked
-- This preserves last_activity_timestamp (the actual activity data we found)
-- Run: docker exec -i nymrank_postgres psql -U nymrank_user -d nymrank < reset-activity-checks.sql

UPDATE profile_refresh_queue 
SET last_activity_check = NULL
WHERE last_activity_check IS NOT NULL;

-- Show summary
SELECT 
  COUNT(*) as total_rows,
  COUNT(last_activity_timestamp) as rows_with_activity,
  COUNT(*) FILTER (WHERE last_activity_check IS NULL) as rows_with_check_reset
FROM profile_refresh_queue;


