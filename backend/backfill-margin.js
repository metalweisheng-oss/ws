const https = require('https')
require('dotenv').config()
const { getPool, sql } = require('./db')

const fetchUrl = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let raw = ''
    r.on('data', c => raw += c)
    r.on('end', () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
  }).on('error', reject)
})

const n = s => +(s?.replace(/,/g, '') || 0)

const TWSE_STOCKS = ['2059', '3008', '9105']
const OTC_STOCKS  = ['3293']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchMarginForDate(dateStr) {
  // dateStr = 'YYYYMMDD'
  const y = +dateStr.slice(0,4), m = dateStr.slice(4,6), d = dateStr.slice(6,8)
  const result = {}

  // TWSE 上市
  try {
    const data = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr}&selectType=STOCK&response=json`
    )
    for (const row of data.tables?.[1]?.data || []) {
      if (TWSE_STOCKS.includes(row[0])) result[row[0]] = n(row[6])
    }
  } catch(e) { console.error(`  TWSE margin ${dateStr} 失敗:`, e.message) }

  // TPEX 上櫃
  try {
    const minguo = y - 1911
    const tpexDate = `${minguo}/${m}/${d}`
    const data = await fetchUrl(
      `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${tpexDate}`
    )
    for (const row of data.tables?.[0]?.data || []) {
      if (OTC_STOCKS.includes(row[0])) result[row[0]] = n(row[6])
    }
  } catch(e) { console.error(`  TPEX margin ${dateStr} 失敗:`, e.message) }

  return result
}

async function main() {
  const pool = await getPool()

  // 取 daily_summary 近 30 日有資料的日期（各股）
  const res = await pool.request().query(`
    SELECT DISTINCT stock_no,
      CONVERT(VARCHAR(8), trade_date, 112) AS dateStr
    FROM daily_summary
    WHERE trade_date >= DATEADD(day, -30, GETDATE())
    ORDER BY dateStr ASC
  `)

  // 依日期分組
  const byDate = {}
  for (const { stock_no, dateStr } of res.recordset) {
    if (!byDate[dateStr]) byDate[dateStr] = []
    byDate[dateStr].push(stock_no)
  }

  const dates = Object.keys(byDate).sort()
  console.log(`共 ${dates.length} 個交易日需更新`)

  for (const dateStr of dates) {
    console.log(`\n處理 ${dateStr}...`)
    const margins = await fetchMarginForDate(dateStr)
    console.log('  融資:', margins)

    for (const [stockNo, balance] of Object.entries(margins)) {
      await pool.request()
        .input('sn', sql.VarChar(10), stockNo)
        .input('dt', sql.VarChar(8),  dateStr)
        .input('mb', sql.Int,         balance)
        .query(`
          UPDATE daily_summary
          SET margin_balance = @mb
          WHERE stock_no = @sn
            AND CONVERT(VARCHAR(8), trade_date, 112) = @dt
        `)
      console.log(`  ${stockNo} margin_balance = ${balance}`)
    }

    await sleep(400)
  }

  console.log('\n回填完成')
  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
