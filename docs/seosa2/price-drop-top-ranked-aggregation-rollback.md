# Rollback for price_drop_top ranked aggregation

The migration only replaces public.price_drop_top. It does not write or delete
application rows. To restore the previous query, run this SQL in the Supabase
SQL editor, then confirm that the view still has the same 12 columns.

    create or replace view price_drop_top as
    with ranked as (
      select product_id, mall, vendor_item_id, price, recorded_date,
             row_number() over (
               partition by product_id, mall, vendor_item_id
               order by recorded_date desc
             ) as rn
      from price_history
      where vendor_item_id <> '__LEGACY__'
        and recorded_date >= current_date - interval '30 days'
    ),
    latest as (
      select product_id, mall, vendor_item_id, price as current_price, recorded_date as latest_date
      from ranked where rn = 1
    ),
    prev as (
      select product_id, mall, vendor_item_id, price as prev_price
      from ranked where rn = 2
    ),
    agg as (
      select product_id, mall, vendor_item_id, min(price) as all_time_low
      from price_history
      where vendor_item_id <> '__LEGACY__'
      group by product_id, mall, vendor_item_id
    )
    select
      l.product_id,
      l.mall,
      p2.title,
      l.current_price,
      pv.prev_price,
      a.all_time_low,
      coalesce(pv.prev_price - l.current_price, 0) as drop_amount,
      case
        when pv.prev_price > 0 and l.current_price < pv.prev_price
        then round((1.0 - l.current_price::numeric / pv.prev_price::numeric) * 100::numeric, 1)
        else 0::numeric
      end as drop_pct,
      l.current_price <= a.all_time_low as is_all_time_low,
      p2.link,
      p2.image,
      p2.mall_label
    from latest l
    join prev pv using (product_id, mall, vendor_item_id)
    left join agg a using (product_id, mall, vendor_item_id)
    join products p2 on p2.product_id = l.product_id and p2.mall = l.mall;

    notify pgrst, 'reload schema';