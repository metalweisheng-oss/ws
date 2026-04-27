// 執行方式：DATABASE_URL=<supabase連線字串> node import-to-pg.js
require('dotenv').config()
const { Pool } = require('pg')
const fs = require('fs')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('開始匯入資料...')

  // signals
  const signals = JSON.parse(fs.readFileSync('_export_signals.json'))
  let ok = 0
  for (const r of signals) {
    try {
      await pool.query(
        `INSERT INTO signals (stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [r.stock_no, r.stock_name, r.signal_time, r.signal_type,
         r.price, r.vol_ratio, r.day_low, r.day_high, r.message,
         r.macd_line, r.macd_hist, r.macd_div, r.source]
      )
      ok++
    } catch(e) { console.error('signal err:', e.message) }
  }
  console.log(`signals: ${ok}/${signals.length} 筆`)

  // daily_summary
  const daily = JSON.parse(fs.readFileSync('_export_daily.json'))
  ok = 0
  for (const r of daily) {
    try {
      await pool.query(
        `INSERT INTO daily_summary (stock_no,stock_name,trade_date,open_price,high_price,low_price,close_price,total_volume,inst_foreign,inst_trust,inst_dealer,major_net,buyer_count,seller_count,concentration_5d,concentration_20d,margin_balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
        [r.stock_no, r.stock_name, r.trade_date,
         r.open_price, r.high_price, r.low_price, r.close_price, r.total_volume,
         r.inst_foreign, r.inst_trust, r.inst_dealer,
         r.major_net, r.buyer_count, r.seller_count,
         r.concentration_5d, r.concentration_20d, r.margin_balance]
      )
      ok++
    } catch(e) { console.error('daily err:', e.message) }
  }
  console.log(`daily_summary: ${ok}/${daily.length} 筆`)

  // intraday（最多，分批）
  const intraday = JSON.parse(fs.readFileSync('_export_intraday.json'))
  ok = 0
  for (let i = 0; i < intraday.length; i++) {
    const r = intraday[i]
    try {
      await pool.query(
        `INSERT INTO intraday (stock_no,stock_name,bar_time,open_price,high_price,low_price,close_price,volume)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [r.stock_no, r.stock_name, r.bar_time,
         r.open_price, r.high_price, r.low_price, r.close_price, r.volume]
      )
      ok++
    } catch(e) { console.error('intraday err:', e.message) }
    if (i % 500 === 0) process.stdout.write(`\r  intraday: ${i}/${intraday.length}`)
  }
  console.log(`\nintraday: ${ok}/${intraday.length} 筆`)

  console.log('\n✅ 匯入完成')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
