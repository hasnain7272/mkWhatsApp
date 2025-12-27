-- Enable the extension if not already done
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Create a table to store contact lists
create table lists (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  name text not null,
  contacts jsonb not null -- This stores your [{name, number}] array
);

-- 2. Campaign Metadata
create table campaigns (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now(),
  name text not null,
  message text,
  status text default 'paused', -- 'running', 'completed', 'paused'
  total_count int default 0,
  sent_count int default 0,
  failed_count int default 0,
  media_data text null,
  media_mime text null,
  media_name text null,
  session_id text null
);

-- 3. Each msg sent data
create table campaign_queue (
  id uuid not null default gen_random_uuid (),
  campaign_id uuid null,
  number text not null,
  status text null default 'pending'::text,
  message text null,
  sent_at timestamp with time zone null,
  created_at timestamp with time zone null default now(),
  constraint campaign_queue_pkey primary key (id),
  constraint campaign_queue_campaign_id_fkey foreign KEY (campaign_id) references campaigns (id)
) TABLESPACE pg_default;
