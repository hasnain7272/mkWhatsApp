-- Create a table to store contact lists
create table lists (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  name text not null,
  contacts jsonb not null -- This stores your [{name, number}] array
);

-- Enable security (Row Level Security)
alter table lists enable row level security;

-- For now, allow public access (Simplest for MVP)
-- WARNING: In production, you would add User Auth policies here.
create policy "Public Access" on lists for all using (true);


-- 1. Campaign Metadata
create table campaigns (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now(),
  name text not null,
  message text,
  status text default 'paused', -- 'running', 'completed', 'paused'
  total_count int default 0,
  sent_count int default 0,
  failed_count int default 0
);

-- 2. The Execution Queue (The heavy lifter)
create table queue (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid references campaigns(id) on delete cascade,
  number text not null,
  name text,
  status text default 'pending', -- 'pending', 'sent', 'failed'
  updated_at timestamp with time zone
);

-- 3. Speed Index (Crucial for performance)
create index idx_queue_status on queue(campaign_id, status);

-- 4. Enable Access
alter table campaigns enable row level security;
alter table queue enable row level security;
create policy "Public Access Campaigns" on campaigns for all using (true);
create policy "Public Access Queue" on queue for all using (true);
