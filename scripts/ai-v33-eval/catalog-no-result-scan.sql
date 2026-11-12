-- Catalog-only negative product-evidence scan; no mutations, no merchant API calls.
-- Every id is paired with its frozen maximum budget and broad brand/model title probes.
WITH probes(id, cap, brand_regex, model_regex, other_regex) AS (
  VALUES ('D01',1000,'로지텍|logitech','g[[:space:]_-]*304',''),
('D02',20000,'로지텍|logitech','g[[:space:]_-]*502[[:space:]_-]*x|g502x',''),
('D03',40000,'삼성|samsung','g[[:space:]_-]*5|오디세이|odyssey','27|180'),
('D04',50000,'삼성|samsung','g[[:space:]_-]*5|오디세이|odyssey','32|165'),
('D05',30000,'위닉스|winix','제로[[:space:]_-]*s|zero[[:space:]_-]*s',''),
('D06',50000,'lg|엘지','에어로[[:space:]_-]*미니|aeromini',''),
('D07',50000,'마샬|marshall','엠버튼[[:space:]_-]*3|emberton[[:space:]_-]*3',''),
('D08',100000,'로보락|roborock','s[[:space:]_-]*8[[:space:]_-]*pro',''),
('D09',50000,'키크론|keychron','k[[:space:]_-]*2[[:space:]_-]*he',''),
('D10',10000,'브리츠|britz','bt[[:space:]_-]*20[[:space:]_-]*anc',''),
('D11',10000,'jbl','770[[:space:]_-]*nc',''),
('D12',30000,'제논','기타|guitar',''),
('D13',50000,'콜트|cort','베이스|bass',''),
('D14',100000,'삼성|samsung','a[[:space:]_-]*56',''),
('D15',20000,'삼성|samsung','버즈[[:space:]_-]*3[[:space:]_-]*fe|buds[[:space:]_-]*3[[:space:]_-]*fe',''),
('D16',150000,'애플|apple|아이폰|iphone','16[[:space:]_-]*e',''),
('D17',30000,'위닉스|winix','제로[[:space:]_-]*4|zero[[:space:]_-]*4',''),
('D18',50000,'샤오미|xiaomi|레드미|redmi','패드[[:space:]_-]*2|pad[[:space:]_-]*2',''),
('D19',1000,'로지텍|logitech','m[[:space:]_-]*170',''),
('D20',400000,'다이슨|dyson','퓨어[[:space:]_-]*쿨|pure[[:space:]_-]*cool','')
),
stats AS (
  SELECT count(*)::int total_products, max(collected_at) AS latest_collected_at FROM products
), matches AS (
  SELECT q.id, p.title, p.lprice, p.mall, p.product_id, p.collected_at
  FROM probes q JOIN products p ON p.lprice>0 AND p.lprice<=q.cap
    AND p.title ~* q.brand_regex AND p.title ~* q.model_regex
    AND (q.other_regex='' OR p.title ~* q.other_regex)
)
SELECT q.id, q.cap, q.brand_regex, q.model_regex, q.other_regex,
  COUNT(m.title)::int AS matched_title_count,
  COALESCE(jsonb_agg(jsonb_build_object('title',m.title,'price',m.lprice,
      'mall',m.mall,'productId',m.product_id,'collectedAt',m.collected_at)
      ORDER BY m.lprice,m.title) FILTER (WHERE m.title IS NOT NULL),'[]'::jsonb) AS matches,
  (SELECT total_products FROM stats) AS scanned_rows,
  (SELECT latest_collected_at FROM stats) AS latest_collected_at,
  CURRENT_TIMESTAMP AS queried_at
FROM probes q LEFT JOIN matches m ON m.id=q.id
GROUP BY q.id,q.cap,q.brand_regex,q.model_regex,q.other_regex
ORDER BY q.id
