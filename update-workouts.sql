-- ONE-TIME — run in Supabase SQL Editor (Dashboard -> SQL Editor -> Run).
-- Enables workout notes ("Cardio workout") and photo proof screenshots
-- (e.g. from Apple Health) on the Workouts tab.

-- 1. New columns on workouts
alter table public.workouts
  add column if not exists note text,
  add column if not exists photo_path text;

-- 2. Private storage bucket for the screenshots
insert into storage.buckets (id, name, public)
  values ('workout-proofs', 'workout-proofs', false)
  on conflict (id) do nothing;

-- 3. Storage rules: both of you can view; each person can only upload/delete
--    inside their own folder (folder name = their auth user id)
create policy "wlc_proofs_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'workout-proofs');

create policy "wlc_proofs_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'workout-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "wlc_proofs_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'workout-proofs' and (storage.foldername(name))[1] = auth.uid()::text);
