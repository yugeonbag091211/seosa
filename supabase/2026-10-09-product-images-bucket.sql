-- ADPICK 상품 사진 원본 캐시용 Storage 버킷 (api/_imagecache.js).
--
-- ★ 비파괴: 버킷 하나를 «없을 때만» 만든다. 표·행·정책을 지우거나 바꾸지 않는다.
-- ★ 적용 전 확인: ADPICK 이용 안내의 «상품 정보 저장·가공 불허» 문구. 코드는
--   ADPICK_IMAGE_CACHE=1 일 때만 이 버킷에 쓴다(기본 꺼짐).
--
-- public = true   → 카드가 /storage/v1/object/public/product-images/… 로 바로 읽는다.
--                    쓰기는 service role(수집기)만 한다 — 익명 쓰기 정책을 만들지 않는다.
-- file_size_limit → 코드 상한(2MB)과 같다. 실측 ADPICK 사진은 25–115KB(640x640).
-- allowed_mime_types → 코드가 받는 형식과 같다.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images', 'product-images', true, 2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do nothing;

-- VERIFY
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images';
--   → 1행, public = true, 2097152
--
-- 사용량 확인
--   select count(*), pg_size_pretty(sum((metadata->>'size')::bigint))
--   from storage.objects where bucket_id = 'product-images';
--
-- ROLLBACK (버킷을 비운 뒤에만 가능 — 사진을 지우는 결정은 따로 한다)
--   ADPICK_IMAGE_CACHE 를 끄면 새로 쓰지 않는다. products.image 의 Storage 주소는
--   그대로 열리므로 버킷을 지우기 전에 그 행들의 image 처리부터 정해야 한다.
