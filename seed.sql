-- ONE-TIME SEED — run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- The schema + RLS SQL has already been run; this just registers the two players.
-- Everything else (months, targets, logs) is created inside the app itself.

insert into participants (auth_uid, name) values
  ('7da3a9ea-6d83-463e-b175-b1701e173d3b', 'Tony'),
  ('21b1cdbe-f40c-4530-b9b5-a5f462564745', 'Amber')
on conflict (auth_uid) do update set name = excluded.name;
