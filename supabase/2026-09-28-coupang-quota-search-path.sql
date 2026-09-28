-- Harden only the three Coupang RPCs introduced by the minute-quota migration.
-- This follow-up avoids rewriting an already-applied migration file.

alter function public.coupang_acquire_v2(text,text,integer,integer,integer,integer)
  set search_path = '';
alter function public.coupang_acquire(integer,text,text)
  set search_path = '';
alter function public.coupang_block_seconds(integer,text)
  set search_path = '';

notify pgrst, 'reload schema';
