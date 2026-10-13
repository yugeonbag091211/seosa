-- Cover foreign-key lookups on Phase 3 audit and source-run references.
create index if not exists canonical_product_groups_source_run_idx
  on public.canonical_product_groups (source_shadow_run_id);

create index if not exists canonical_product_members_source_run_idx
  on public.canonical_product_members (source_shadow_run_id);

create index if not exists canonical_product_promotions_shadow_group_idx
  on public.canonical_product_promotions (shadow_group_id);

notify pgrst, 'reload schema';
