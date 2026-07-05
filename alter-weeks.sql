-- ONE-TIME — run in Supabase SQL Editor.
-- The original schema capped weigh-ins at week 4 (4-week months). The
-- Summer 2026 challenge (6 Jul -> 2 Sep) runs 9 weeks, so relax the cap.
-- Drops whatever the check constraint on weigh_ins is named, then recreates
-- it with a generous upper bound.

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.weigh_ins'::regclass and contype = 'c'
  loop
    execute format('alter table public.weigh_ins drop constraint %I', c);
  end loop;
end $$;

alter table public.weigh_ins
  add constraint weigh_ins_week_no_check check (week_no between 1 and 26);
