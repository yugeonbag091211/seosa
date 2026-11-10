'use strict';
// Manufacturer-confirmed model identity is a narrow exception to noisy seller
// vocabulary. Never use it to revive a stale Neon catalog price.
// Source: https://kr.jbl.com/TUNE770NC.html
const flat=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g,'');
function freshOfficialHeadphone({title,requestedText,category,source}={}){
  if(category!=='헤드폰'||!['api','cache'].includes(source))return false;
  const q=flat(requestedText),t=flat(title);
  if(!/(?:jbltune770nc|jbl770nc)/.test(q))return false;
  if(!/(?:jbltune770nc|jbl770nc)/.test(t))return false;
  if(!/(?:헤드폰|헤드셋|headphones?|overear|오버이어)/i.test(String(title)))return false;
  // Seller may use '이어폰' generically for Bluetooth head-worn products.
  // This is ONLY safe when the exact official model is clearly the product.
  if(/(?:케이스|커버|보호필름|이어패드|교체패드|이어쿠션|거치대|스탠드|충전기|이어팁|호환용|호환제품|이어폰팁|수리부품|케이블\s*단품)/i.test(String(title)))return false;
  return true;
}
module.exports={freshOfficialHeadphone};
