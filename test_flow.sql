-- Test the exact flow contract query
SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1;