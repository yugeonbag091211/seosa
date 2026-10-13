-- Cover the source-group foreign key and admin detail lookup.
create index if not exists identity_review_queue_source_group_idx
  on public.identity_review_queue (source_shadow_group_id);
