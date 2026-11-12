-- SEOSA AI v3.4 — pgvector schema for HYBRID retrieval experiments.
--
-- ISOLATED DATABASES ONLY: a Neon development branch created for this work,
-- or a local PGlite instance. NEVER apply this file to the production Neon
-- branch. scripts/ai-v34/embed-products.js refuses any host that is not on its
-- explicit allow-list and refuses the production endpoint by name.
--
-- Everything lives in its own schema (ai_v34). Nothing here alters the shared
-- `products` table; embeddings reference products by (mall, product_id).
-- Rollback: DROP SCHEMA ai_v34 CASCADE;  (the extension may stay installed)

create extension if not exists vector;
create schema if not exists ai_v34;

-- One row per (product, embedder). content_hash = sha256(lexicon version +
-- embedder id + dims + normalized product document): a product is re-embedded
-- only when its document, the lexicon or the model changes.
create table if not exists ai_v34.product_embeddings (
  mall            text        not null,
  product_id      text        not null,
  embedder_id     text        not null,
  dims            integer     not null check (dims = 256),
  lexicon_version text        not null,
  content_hash    text        not null,
  embedding       vector(256) not null,
  embedded_at     timestamptz not null default now(),
  primary key (mall, product_id, embedder_id)
);

-- Pipeline audit trail: model, dimensions, version and counts of every run.
create table if not exists ai_v34.embedding_runs (
  run_id          text        primary key,
  embedder_id     text        not null,
  dims            integer     not null,
  lexicon_version text        not null,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  scanned         integer     not null default 0,
  embedded        integer     not null default 0,
  unchanged       integer     not null default 0,
  pruned          integer     not null default 0,
  cost_usd        numeric(12,6) not null default 0,
  note            text
);

-- Approximate nearest neighbour index (cosine). m / ef_construction were
-- chosen from scripts/ai-v34/pgvector-bench.js measurements (HNSW vs IVFFlat
-- vs exact scan); see docs/ai-v34-test-results.md.
create index if not exists product_embeddings_hnsw
  on ai_v34.product_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Minimal, de-identified retrieval failure signals (feedback loop, design
-- only — written by nothing in production). No free text, no account id, no
-- card titles: category, constraint kinds, rejection counters, and lexicon
-- tokens/model codes that matched the versioned whitelist.
create table if not exists ai_v34.retrieval_feedback (
  id               bigserial   primary key,
  day              date        not null,
  signal           text        not null check (signal in ('reject', 'retry', 'refine', 'report')),
  session_hash     text        not null,
  strategy         text        not null,
  category         text,
  card_count       integer     not null default 0,
  no_result        text,
  constraint_kinds text[]      not null default '{}',
  rejected_reasons jsonb       not null default '{}'::jsonb,
  terms            text[]      not null default '{}',
  lexicon_version  text        not null
);
