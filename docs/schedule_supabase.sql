-- 1. Create the Cron Job
select
  cron.schedule(
    'engine-heartbeat', -- Job Name
    '* * * * *',                     -- Cron Syntax (Every Minute)
    $$
    select
      net.http_post(
          url:='https://upvprcemxefhviwptqnb.supabase.co/functions/v1/bright-worker',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdnByY2VteGVmaHZpd3B0cW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NTY5MzQsImV4cCI6MjA4MjEzMjkzNH0.yhaJUoNjflw0_cgjuk6HCFA7XIUiWTaG7tZBM4CfCGk"}'::jsonb,
          body:='{}'::jsonb
      ) as request_id;
    $$
  );


select
  cron.schedule(
    'weekly-cleanup',
    '0 0 * * 0', -- Every Sunday at 00:00
    $$
    DELETE FROM campaign_queue 
    WHERE status IN ('sent', 'failed') 
    AND created_at < NOW() - INTERVAL '30 days';
    $$
  );
