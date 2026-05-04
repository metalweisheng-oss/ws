const express = require('express')
const cors = require('cors')
const https = require('https')
const http  = require('http')
const zlib  = require('zlib')
const cron  = require('node-cron')
require('dotenv').config()
const { pool } = require('./db')

const app = express()
app.use(cors())
app.use(express.json())

// 抓 Yahoo Finance 分時資料
app.get('/api/stock/intraday', async (req, res) => {
  const { stockNo = '2059', date = '2026-04-24' } = req.query
  const symbol = getSymbol(stockNo)

  const [y, m, d] = date.split('-').map(Number)
  const { DateTime } = await import('luxon').catch(() => null) || {}

  // 直接算 CST timestamp
  const tzOffset = 8 * 3600
  const open  = Date.UTC(y, m - 1, d, 9, 0, 0) / 1000 - tzOffset
  const close = Date.UTC(y, m - 1, d, 13, 30, 0) / 1000 - tzOffset

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&period1=${open}&period2=${close}`

  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (yRes) => {
    let raw = ''
    yRes.on('data', chunk => raw += chunk)
    yRes.on('end', () => {
      try {
        const json = JSON.parse(raw)
        const result = json.chart.result[0]
        const timestamps = result.timestamp
        const q = result.indicators.quote[0]

        const rows = timestamps.map((ts, i) => {
          const dt = new Date(ts * 1000)
          const hh = String(dt.getUTCHours() + 8).padStart(2, '0')
          const mm = String(dt.getUTCMinutes()).padStart(2, '0')
          return {
            time: `${hh}:${mm}`,
            open: q.open[i],
            high: q.high[i],
            low: q.low[i],
            close: q.close[i],
            volume: q.volume[i],
          }
        }).filter(r => r.close !== null)

        res.json({ stock: stockNo, date, data: rows })
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    })
  }).on('error', e => res.status(500).json({ error: e.message }))
})

app.get('/', (req, res) => {
  res.json({ message: 'my-app backend is running' })
})

// 測試 DB 連線
app.get('/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1 AS ok')
    res.json({ db: 'connected' })
  } catch (err) {
    res.status(500).json({ db: 'error', message: err.message })
  }
})

// 主力分析
app.get('/api/stock/analysis', async (req, res) => {
  const { stockNo = '2059', date = '2026-04-24' } = req.query
  const symbol = getSymbol(stockNo)
  const [y, m, d] = date.split('-').map(Number)
  const tzOffset = 8 * 3600
  const open  = Date.UTC(y, m - 1, d, 9, 0, 0) / 1000 - tzOffset
  const close = Date.UTC(y, m - 1, d, 13, 30, 0) / 1000 - tzOffset

  // 並行抓分時 + 三大法人
  const fetchUrl = (url, headers = {}) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (r) => {
      let raw = ''
      r.on('data', c => raw += c)
      r.on('end', () => { try { resolve(JSON.parse(raw)) } catch(e) { reject(e) } })
    }).on('error', reject)
  })

  const dateStr = `${y}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}`

  const [yahoo, twse] = await Promise.all([
    fetchUrl(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&period1=${open}&period2=${close}`),
    fetchUrl(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALLBUT0999&response=json`)
  ])

  // 解析分時資料
  const result = yahoo.chart.result[0]
  const timestamps = result.timestamp
  const q = result.indicators.quote[0]
  const rows = timestamps.map((ts, i) => {
    const dt = new Date(ts * 1000)
    const hh = String(dt.getUTCHours() + 8).padStart(2, '0')
    const mm = String(dt.getUTCMinutes()).padStart(2, '0')
    return { time: `${hh}:${mm}`, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }
  }).filter(r => r.close !== null && r.volume !== null)

  // 解析三大法人
  const instRow = twse.data?.find(r => r[0] === stockNo) || []
  const n = s => +(s?.replace(/,/g,'') || 0)
  const institutional = {
    foreign: { buy: n(instRow[2]),  sell: n(instRow[3]),  net: n(instRow[4])  },
    trust:   { buy: n(instRow[8]),  sell: n(instRow[9]),  net: n(instRow[10]) },
    dealer:  { buy: n(instRow[12]), sell: n(instRow[13]), net: n(instRow[11]) },
    totalNet: n(instRow[18])
  }

  // 統計
  const allVol = rows.map(r => r.volume)
  const avgVol = allVol.reduce((a,b) => a+b, 0) / allVol.length
  const dayLow  = Math.min(...rows.map(r => r.low))
  const dayHigh = Math.max(...rows.map(r => r.high))
  const vwapNum = rows.reduce((s,r) => s + ((r.high+r.low+r.close)/3) * r.volume, 0)
  const vwapDen = rows.reduce((s,r) => s + r.volume, 0)
  const vwap = vwapNum / vwapDen

  // 量能異常時段 (>2x 平均量)
  const spikes = rows.filter(r => r.volume > avgVol * 2).map(r => ({ ...r, volRatio: +(r.volume/avgVol).toFixed(1) }))

  // 主力進場低點：成交量異常 + 價格在日低 5% 以內 + 後續 5 分鐘收盤高於當下
  const threshold = dayLow * 1.05
  const entryPoints = rows
    .map((r, i) => {
      if (r.volume < avgVol * 1.5) return null
      if (r.low > threshold) return null
      const next5 = rows.slice(i+1, i+6)
      const recovery = next5.length > 0 && next5[next5.length-1].close > r.close
      return recovery ? { ...r, volRatio: +(r.volume/avgVol).toFixed(1), priceFromLow: +(((r.low - dayLow)/dayLow)*100).toFixed(2) } : null
    })
    .filter(Boolean)
    .sort((a,b) => b.volume - a.volume)

  // 主力方向判斷
  const mainPlayer = institutional.trust.net > 0 ? '投信（主要買方）' : institutional.foreign.net > 0 ? '外資（主要買方）' : '散戶/自營'
  const majorBuyer = institutional.trust.net > institutional.foreign.net ? 'trust' : 'foreign'

  // 寫入每日摘要
  saveDailySummary({
    stockNo, stockName: STOCK_NAMES[stockNo] || stockNo,
    tradeDate: new Date(date),
    open:  rows[0]?.open,
    high:  dayHigh,
    low:   dayLow,
    close: rows[rows.length-1]?.close,
    volume: vwapDen,
    instForeign: institutional.foreign.net,
    instTrust:   institutional.trust.net,
    instDealer:  institutional.dealer.net,
  })

  res.json({
    stock: stockNo, date,
    summary: { dayOpen: rows[0]?.open, dayHigh, dayLow, dayClose: rows[rows.length-1]?.close, totalVolume: vwapDen, vwap: +vwap.toFixed(0), avgMinuteVol: +avgVol.toFixed(0) },
    institutional,
    mainPlayer,
    majorBuyer,
    volumeSpikes: spikes,
    entryPoints,
  })
})

// Telegram 通知
function sendTelegram(text) {
  const token  = process.env.TELEGRAM_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId || token.startsWith('填入')) return

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {})
  req.on('error', () => {})
  req.write(body)
  req.end()
}

// ── 集保大戶持股（全市場） ────────────────────────────
async function ensureConcentrationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS concentration (
      stock_no     VARCHAR(10),
      data_date    DATE,
      stock_name   VARCHAR(50),
      large_pct    NUMERIC(8,4),
      large_count  INT,
      total_shares BIGINT,
      PRIMARY KEY (stock_no, data_date)
    )
  `)
  // 補欄位（舊表相容）
  await pool.query(`ALTER TABLE concentration ADD COLUMN IF NOT EXISTS stock_name VARCHAR(50)`).catch(()=>{})
}
ensureConcentrationTable().catch(e => console.error('[concentration] 建表失敗:', e.message))

async function syncConcentration() {
  console.log('[concentration] 開始抓取全市場集保大戶持股...')
  try {
    // 同時抓 TDCC CSV + TWSE 個股名稱
    const [csvText, twseDay] = await Promise.all([
      new Promise((resolve, reject) => {
        https.get('https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5',
          { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
          (r) => { const c=[]; r.on('data',d=>c.push(d)); r.on('end',()=>resolve(Buffer.concat(c).toString('utf8'))); r.on('error',reject) }
        ).on('error', reject)
      }),
      fetchUrl('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json').catch(()=>null),
    ])

    // 建立股票名稱 map（TWSE 上市）
    const nameMap = {}
    for (const row of twseDay?.data || []) {
      const no = row[0]?.trim()
      const nm = row[1]?.trim()
      if (/^\d{4}$/.test(no) && nm) nameMap[no] = nm
    }

    // 解析 TDCC CSV：只保留 4 位數字代號（一般股票）
    const byStock = {}
    for (const line of csvText.split('\n').slice(1)) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const dateStr = parts[0].trim()
      const stockNo = parts[1].trim()
      if (!/^\d{4,6}$/.test(stockNo)) continue   // 只要數字代號
      if (stockNo.length !== 4) continue           // 只要 4 位一般股
      const level  = parseInt(parts[2])
      const pct    = parseFloat(parts[5]) || 0
      const count  = parseInt(parts[3])   || 0
      const shares = parseInt(parts[4])   || 0
      if (!byStock[stockNo]) byStock[stockNo] = { dateStr, levels: {} }
      byStock[stockNo].levels[level] = { pct, count, shares }
    }

    console.log(`[concentration] 解析完成，共 ${Object.keys(byStock).length} 檔個股`)

    // 批次寫入（每批 100 檔，用 VALUES 批次 INSERT 避免逐筆慢）
    const stockNos = Object.keys(byStock)
    let saved = 0
    for (let i = 0; i < stockNos.length; i += 100) {
      const batch = stockNos.slice(i, i + 100)
      const vals = [], params = []
      let p = 1
      for (const stockNo of batch) {
        const { dateStr, levels } = byStock[stockNo]
        const largePct   = [12,13,14,15].reduce((s,l)=>s+(levels[l]?.pct  ||0),0)
        const largeCount = [12,13,14,15].reduce((s,l)=>s+(levels[l]?.count||0),0)
        const totalShares = levels[17]?.shares || 0
        const dataDate   = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`
        const stockName  = nameMap[stockNo] || STOCK_NAMES[stockNo] || null
        vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5})`)
        params.push(stockNo, dataDate, stockName, +largePct.toFixed(4), largeCount, totalShares)
        p += 6
      }
      await pool.query(`
        INSERT INTO concentration (stock_no,data_date,stock_name,large_pct,large_count,total_shares)
        VALUES ${vals.join(',')}
        ON CONFLICT (stock_no,data_date) DO UPDATE SET
          stock_name=EXCLUDED.stock_name,
          large_pct=EXCLUDED.large_pct,
          large_count=EXCLUDED.large_count,
          total_shares=EXCLUDED.total_shares
      `, params)
      saved += batch.length
    }
    console.log(`[concentration] 寫入 ${saved} 筆完成`)
  } catch(e) {
    console.error('[concentration] 同步失敗:', e.message)
  }
}

// 大戶持股連續增加排行榜
app.get('/api/concentration/ranking', async (req, res) => {
  try {
    const minStreak = parseInt(req.query.minStreak) || 1
    const limit     = Math.min(parseInt(req.query.limit) || 50, 200)

    const { rows } = await pool.query(`
      SELECT stock_no, stock_name, data_date, large_pct, large_count
      FROM concentration
      WHERE data_date >= CURRENT_DATE - 90
        AND stock_name IS NOT NULL
        AND large_pct < 99.9
        AND large_pct > 0
      ORDER BY stock_no, data_date ASC
    `)

    // 取得最新資料日期
    let latestDate = null
    for (const r of rows) {
      if (!latestDate || r.data_date > latestDate) latestDate = r.data_date
    }

    const grouped = {}
    for (const r of rows) {
      if (!grouped[r.stock_no]) grouped[r.stock_no] = []
      grouped[r.stock_no].push(r)
    }

    const result = []
    for (const [stockNo, days] of Object.entries(grouped)) {
      const latest = days[days.length - 1]
      // 只處理最新日期的股票（排除已下市或資料太舊的）
      if (latestDate && latest.data_date < latestDate) continue

      let streak = 0, totalChange = 0, latestChange = null

      if (days.length >= 2) {
        for (let i = days.length - 1; i >= 1; i--) {
          const change = +(days[i].large_pct - days[i-1].large_pct).toFixed(4)
          if (i === days.length - 1) latestChange = change
          if (change > 0) { streak++; totalChange += change }
          else break
        }
      }

      const hasHistory = days.length >= 2
      if (hasHistory && streak < minStreak) continue
      if (!hasHistory && minStreak > 1) continue  // 嚴格模式下不顯示無歷史股票

      result.push({
        stock_no:      stockNo,
        stock_name:    latest.stock_name,
        streak_days:   streak,
        latest_pct:    +latest.large_pct,
        latest_change: latestChange != null ? +latestChange.toFixed(4) : null,
        total_change:  +totalChange.toFixed(4),
        large_count:   latest.large_count,
        data_date:     latest.data_date,
        has_history:   hasHistory,
      })
    }

    const hasAnyStreak = result.some(r => r.streak_days > 0)
    if (hasAnyStreak) {
      // 有多週資料：streak 天數 → 累計增加幅度
      result.sort((a,b) =>
        b.streak_days - a.streak_days ||
        b.total_change - a.total_change ||
        b.latest_pct - a.latest_pct
      )
    } else {
      // 只有單週：按大戶人數排序（卡位人越多越值得關注）
      result.sort((a,b) => b.large_count - a.large_count || b.latest_pct - a.latest_pct)
    }

    res.json({
      total: result.length,
      rows: result.slice(0, limit),
      latest_date: latestDate,
      has_multi_week: result.some(r => r.has_history),
    })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// 保留舊 /api/concentration 給監控個股頁（8 檔）
app.get('/api/concentration', async (req, res) => {
  try {
    const { rows: concRows } = await pool.query(`
      SELECT c.*, LAG(c.large_pct) OVER (PARTITION BY c.stock_no ORDER BY c.data_date) AS prev_pct
      FROM concentration c
      WHERE c.stock_no = ANY($1::text[])
      ORDER BY c.stock_no, c.data_date DESC
    `, [Object.keys(STOCK_NAMES)])

    const { rows: priceRows } = await pool.query(`
      SELECT DISTINCT ON (stock_no)
        stock_no, close_price, open_price,
        close_price - open_price AS change_price,
        ROUND((close_price - open_price) / NULLIF(open_price,0) * 100, 2) AS change_pct_price
      FROM daily_summary
      WHERE stock_no = ANY($1::text[])
      ORDER BY stock_no, trade_date DESC
    `, [Object.keys(STOCK_NAMES)])
    const priceMap = Object.fromEntries(priceRows.map(r => [r.stock_no, r]))

    const seen = {}
    const result = []
    for (const row of concRows) {
      if (seen[row.stock_no]) continue
      seen[row.stock_no] = true
      const price = priceMap[row.stock_no] || {}
      result.push({
        stock_no:       row.stock_no,
        stock_name:     STOCK_NAMES[row.stock_no],
        data_date:      row.data_date,
        large_pct:      +row.large_pct,
        prev_pct:       row.prev_pct != null ? +row.prev_pct : null,
        change_pct:     row.prev_pct != null ? +(row.large_pct - row.prev_pct).toFixed(4) : null,
        large_count:    row.large_count,
        total_shares:   row.total_shares,
        close_price:    price.close_price != null ? +price.close_price : null,
        change_price:   price.change_price != null ? +price.change_price : null,
        change_pct_price: price.change_pct_price != null ? +price.change_pct_price : null,
      })
    }
    res.json({ rows: result })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/sync/concentration', async (req, res) => {
  res.json({ ok: true, message: '集保大戶持股同步已開始' })
  syncConcentration()
})

// ── DB 寫入 ───────────────────────────────────────
async function saveSignal({ stockNo, stockName, signalTime, signalType, price, volRatio, dayLow, dayHigh, message, macd, source = 'realtime' }) {
  try {
    await pool.query(
      `INSERT INTO signals
        (stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (stock_no,signal_time,signal_type,source) DO NOTHING`,
      [stockNo, stockName, signalTime, signalType,
       price ?? null, volRatio ?? null, dayLow ?? null, dayHigh ?? null,
       message ?? null, macd?.line ?? null, macd?.hist ?? null,
       macd?.divergence ? true : false, source]
    )
  } catch (e) {
    console.error('[saveSignal]', e.message)
  }
}

async function saveDailySummary({ stockNo, stockName, tradeDate, open, high, low, close, volume, instForeign, instTrust, instDealer, marginBalance }) {
  try {
    const majorNet    = (instForeign != null || instTrust != null || instDealer != null)
      ? (instForeign ?? 0) + (instTrust ?? 0) + (instDealer ?? 0) : null
    const buyerCount  = majorNet != null
      ? [instForeign, instTrust, instDealer].filter(v => v != null && v > 0).length : null
    const sellerCount = majorNet != null
      ? [instForeign, instTrust, instDealer].filter(v => v != null && v < 0).length : null

    await pool.query(
      `INSERT INTO daily_summary
        (stock_no,stock_name,trade_date,open_price,high_price,low_price,close_price,total_volume,
         inst_foreign,inst_trust,inst_dealer,major_net,buyer_count,seller_count,margin_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (stock_no,trade_date) DO UPDATE SET
         open_price=$4, high_price=$5, low_price=$6, close_price=$7, total_volume=$8,
         inst_foreign=$9, inst_trust=$10, inst_dealer=$11,
         major_net=$12, buyer_count=$13, seller_count=$14,
         margin_balance=COALESCE($15, daily_summary.margin_balance)`,
      [stockNo, stockName, tradeDate,
       open ?? null, high ?? null, low ?? null, close ?? null, volume ?? null,
       instForeign ?? null, instTrust ?? null, instDealer ?? null,
       majorNet ?? null, buyerCount ?? null, sellerCount ?? null, marginBalance ?? null]
    )

    if (majorNet != null) {
      await pool.query(
        `UPDATE daily_summary SET
           concentration_5d = (
             SELECT SUM(major_net::FLOAT) / NULLIF(SUM(total_volume::FLOAT),0) * 100
             FROM (SELECT major_net, total_volume FROM daily_summary
                   WHERE stock_no=$1 AND trade_date<=$2 AND major_net IS NOT NULL
                   ORDER BY trade_date DESC LIMIT 5) x
           ),
           concentration_20d = (
             SELECT SUM(major_net::FLOAT) / NULLIF(SUM(total_volume::FLOAT),0) * 100
             FROM (SELECT major_net, total_volume FROM daily_summary
                   WHERE stock_no=$1 AND trade_date<=$2 AND major_net IS NOT NULL
                   ORDER BY trade_date DESC LIMIT 20) x
           )
         WHERE stock_no=$1 AND trade_date=$2`,
        [stockNo, tradeDate]
      )
    }
  } catch (e) {
    console.error('[saveDailySummary]', e.message)
  }
}

// 共用抓 URL（支援 redirect / 詳細錯誤日誌；不送 Accept-Encoding 避免壓縮）
const fetchUrl = (url, _depth = 0) => new Promise((resolve, reject) => {
  if (_depth > 5) return reject(new Error('Too many redirects'))
  const lib = url.startsWith('https') ? https : http
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  }
  lib.get(url, { headers }, (r) => {
    // 跟隨跳轉
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume()
      const next = r.headers.location.startsWith('http')
        ? r.headers.location
        : new URL(r.headers.location, url).href
      return fetchUrl(next, _depth + 1).then(resolve).catch(reject)
    }
    const chunks = []
    r.on('data', c => chunks.push(c))
    r.on('end', () => {
      const raw = Buffer.concat(chunks)
      try {
        const text = raw.toString('utf8').trim()
        if (!text) return reject(new Error(`Empty response HTTP ${r.statusCode} from ${url.slice(-60)}`))
        resolve(JSON.parse(text))
      } catch(e) {
        console.error(`[fetchUrl] 解析失敗 status=${r.statusCode} bytes=${raw.length} preview="${raw.slice(0,100).toString('utf8').replace(/\n/g,' ')}" url=${url.slice(-60)}`)
        reject(e)
      }
    })
  }).on('error', reject)
})

// 判斷台股是否開盤中（CST 09:00-13:30，週一到週五）
function isMarketOpen() {
  const now = new Date()
  const day = new Date(now.getTime() + 8 * 3600000).getUTCDay() // CST 的星期
  if (day === 0 || day === 6) return false
  const cstH = (now.getUTCHours() + 8) % 24
  const cstM = now.getUTCMinutes()
  const mins = cstH * 60 + cstM
  return mins >= 9 * 60 && mins < 13 * 60 + 30
}

function cstNow() {
  const now = new Date()
  const h = String((now.getUTCHours() + 8) % 24).padStart(2, '0')
  const m = String(now.getUTCMinutes()).padStart(2, '0')
  const s = String(now.getUTCSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

const STOCK_NAMES = {
  '2059': '川湖科技',
  '3293': '鈊象',
  '3008': '大立光',
  '9105': '泰金寶',
  '6274': '台燿',
  '3017': '奇鋐',
  '3037': '欣興',
  '8046': '南電',
}
// 部分個股在興櫃/上櫃市場，Yahoo Finance 需用 .TWO 後綴
const STOCK_SYMBOLS = {
  '2059': '2059.TW',
  '3293': '3293.TWO',
  '3008': '3008.TW',
  '9105': '9105.TW',
  '6274': '6274.TWO',
  '3017': '3017.TW',
  '3037': '3037.TW',
  '8046': '8046.TW',
}
function getSymbol(stockNo) { return STOCK_SYMBOLS[stockNo] || `${stockNo}.TW` }

const STOCKS_LIST = Object.entries(STOCK_NAMES).map(([no, name]) => ({ no, name }))

// ── MACD 計算 ──────────────────────────────────────
function calcEMA(values, period) {
  const k = 2 / (period + 1)
  let ema = values[0]
  const out = [ema]
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    out.push(ema)
  }
  return out
}

function calcMACD(closes) {
  if (closes.length < 34) return null  // 26 + 9 - 1
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const macdForSig = macdLine.slice(25)
  if (macdForSig.length < 9) return null
  const sigLine = calcEMA(macdForSig, 9)
  const hist = macdForSig.map((v, i) => v - sigLine[i])
  return {
    line:    +macdLine[macdLine.length - 1].toFixed(3),
    sig:     +sigLine[sigLine.length - 1].toFixed(3),
    hist:    +hist[hist.length - 1].toFixed(3),
    histArr: hist,
    offset:  25,
  }
}

// 底背離：找最近兩個價格低谷，若價格創低但 MACD 柱未創低 → 底背離
function detectDivergence(rows, macdResult) {
  if (!macdResult) return false
  const { histArr, offset } = macdResult
  const aligned = rows.slice(offset)
  if (aligned.length < 5) return false

  const troughs = []
  for (let i = 1; i < aligned.length - 1; i++) {
    if (aligned[i].low < aligned[i - 1].low && aligned[i].low < aligned[i + 1].low) {
      troughs.push({ price: aligned[i].low, hist: histArr[i] })
    }
  }
  if (troughs.length < 2) return false

  const t1 = troughs[troughs.length - 2]
  const t2 = troughs[troughs.length - 1]
  return t2.price <= t1.price && t2.hist > t1.hist
}

// 頂背離：找最近兩個價格高峰，若價格創高但 MACD 柱未創高 → 頂背離（出貨訊號）
function detectTopDivergence(rows, macdResult) {
  if (!macdResult) return false
  const { histArr, offset } = macdResult
  const aligned = rows.slice(offset)
  if (aligned.length < 5) return false

  const peaks = []
  for (let i = 1; i < aligned.length - 1; i++) {
    if (aligned[i].high > aligned[i - 1].high && aligned[i].high > aligned[i + 1].high) {
      peaks.push({ price: aligned[i].high, hist: histArr[i] })
    }
  }
  if (peaks.length < 2) return false

  const p1 = peaks[peaks.length - 2]
  const p2 = peaks[peaks.length - 1]
  return p2.price >= p1.price && p2.hist < p1.hist
}

// 長下影線：下影線 > 總波動 35% 且 > 實體 1.5 倍
function hasLongLowerShadow(bar) {
  if (!bar) return false
  const lowerShadow = Math.min(bar.open, bar.close) - bar.low
  const totalRange  = bar.high - bar.low
  const body        = Math.abs(bar.close - bar.open)
  return totalRange > 0 && lowerShadow > totalRange * 0.35 && (body === 0 || lowerShadow > body * 1.5)
}

// 現價是否站回 5 根 K 棒收盤均線
function isAboveMa5(rows) {
  if (rows.length < 6) return false
  const ma5 = rows.slice(-6, -1).reduce((s, r) => s + r.close, 0) / 5
  return rows[rows.length - 1].close > ma5
}

// ── 四級訊號判斷 ──────────────────────────────────────
// L1 主力抄底  → signal: 'entry'
// L2 趨勢轉折  → signal: 'warning'
// L3 量能警戒  → signal: 'watch'
// L4 異動提醒  → signal: 'exit_warning'
function classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv,
                          dayLow, dayHigh, periodLow, periodHigh, longLowerShadow, aboveMa5 }) {
  const refLow  = periodLow  ?? dayLow
  const refHigh = periodHigh ?? dayHigh

  // 【一級：主力抄底】量比 ≥ 3x + 接近日低 + 長下影線
  if (volRatio >= 3 && nearLow && longLowerShadow) {
    const extras = [reversal ? '出現反彈' : null, macdDiv ? 'MACD底背離' : null].filter(Boolean)
    return { signal: 'entry', message: `【一級】主力抄底！量比 ${volRatio}x + 接近日低 ${+refLow.toFixed(0)} + 長下影線` + (extras.length ? `（${extras.join('、')}）` : '') }
  }

  // 【二級：趨勢轉折】MACD 底背離 + 站回 5MA，或 底背離 + 接近日低
  if (macdDiv && aboveMa5) {
    return { signal: 'warning', message: `【二級】趨勢轉折！MACD底背離 + 站上5MA，可分批布局` }
  }
  if (macdDiv && nearLow) {
    return { signal: 'warning', message: `【二級】趨勢轉折！MACD底背離 + 接近日低 ${+refLow.toFixed(0)}，觀察族群連動` }
  }

  // 【三級：量能警戒】量比 ≥ 2x + 接近日低（放入追蹤清單）
  if (volRatio >= 2 && nearLow) {
    return { signal: 'watch', message: `【三級】量能警戒！量比 ${volRatio}x + 接近日低 ${+refLow.toFixed(0)}，等待反彈訊號` }
  }

  // 【四級：異動提醒】量比 ≥ 2x + 接近日高（警惕高檔換手）
  if (volRatio >= 2 && nearHigh) {
    const extras = [macdTopDiv ? 'MACD頂背離' : null, !reversal ? '下跌走勢' : null].filter(Boolean)
    return { signal: 'exit_warning', message: `【四級】異動提醒！量比 ${volRatio}x + 高位換手 ${+refHigh.toFixed(0)}，警惕出貨` + (extras.length ? `（${extras.join('、')}）` : '') }
  }

  return { signal: 'normal', message: '正常，無異常量能' }
}

// SSE 即時監控
app.get('/api/stock/monitor/stream', (req, res) => {
  const { stockNo = '2059' } = req.query
  const stockName = STOCK_NAMES[stockNo] || stockNo

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  // 防重複通知：同訊號同小時只發一次
  let lastNotifyKey = ''

  const check = async () => {
    const checkTime = cstNow()

    if (!isMarketOpen()) {
      send({ type: 'check', checkTime, signal: 'closed', message: '盤後 / 休市中', price: null })
      return
    }

    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(stockNo)}?interval=1m&range=1d`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) { send({ type: 'check', checkTime, signal: 'no_data', message: '無資料' }); return }

      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)

      if (!rows.length) { send({ type: 'check', checkTime, signal: 'no_data', message: '今日尚無成交' }); return }

      const avgVol  = rows.reduce((s, r) => s + r.volume, 0) / rows.length
      const dayLow  = Math.min(...rows.map(r => r.low))
      const dayHigh = Math.max(...rows.map(r => r.high))
      const last    = rows[rows.length - 1]
      const prev    = rows[rows.length - 2]

      const dt = new Date(last.ts * 1000)
      const dataTime = `${String((dt.getUTCHours() + 8) % 24).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`

      const volRatio   = +(last.volume / avgVol).toFixed(2)
      const nearLow    = (last.low  - dayLow)  / dayLow  < 0.05
      const nearHigh   = (dayHigh   - last.high) / dayHigh < 0.05
      const reversal   = prev && last.close > prev.close

      const macdResult   = calcMACD(rows.map(r => r.close))
      const macdDiv      = detectDivergence(rows, macdResult)
      const macdTopDiv   = detectTopDivergence(rows, macdResult)
      const macdPayload  = macdResult ? {
        line: macdResult.line, sig: macdResult.sig, hist: macdResult.hist,
        divergence: macdDiv, topDivergence: macdTopDiv,
      } : null

      const longLowerShadow = hasLongLowerShadow(last)
      const aboveMa5        = isAboveMa5(rows)
      const { signal, message } = classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh, longLowerShadow, aboveMa5 })

      const payload = { type: 'check', checkTime, dataTime, signal, message,
                        price: last.close, dayHigh, dayLow,
                        volume: last.volume, avgVolume: Math.round(avgVol), volRatio,
                        macd: macdPayload }
      send(payload)

      // Telegram 通知 + DB 寫入（同小時同訊號不重複）
      const notifySignals = ['entry', 'warning', 'exit_warning']
      if (notifySignals.includes(signal)) {
        const notifyKey = `${new Date().getUTCHours()}-${signal}`
        if (notifyKey !== lastNotifyKey) {
          lastNotifyKey = notifyKey
          const emoji = { entry: '🚨', warning: '⚠️', exit_warning: '🟠' }[signal] || '📢'
          sendTelegram(
            `${emoji} <b>${stockName} ${stockNo} 訊號</b>\n` +
            `${message}\n\n` +
            `現價：<b>${last.close}</b>\n` +
            `量比：<b>${volRatio}x</b>\n` +
            `日低：${dayLow}　日高：${dayHigh}\n` +
            `資料時間：${dataTime}`
          )
        }
        saveSignal({
          stockNo, stockName,
          signalTime: new Date(last.ts * 1000),
          signalType: signal,
          price: last.close, volRatio, dayLow, dayHigh, message,
          macd: macdPayload, source: 'realtime',
        })
      }

    } catch (e) {
      send({ type: 'error', checkTime, message: e.message })
    }
  }

  check()
  const timer = setInterval(check, 30 * 1000)
  req.on('close', () => clearInterval(timer))
})

// ── 回測：逐根模擬監控邏輯 ───────────────────────────
function simulateDay(rows) {
  const signals = []
  let prevSignal = 'normal'

  for (let i = 1; i < rows.length; i++) {
    const win     = rows.slice(0, i + 1)
    const last    = win[win.length - 1]
    const prev    = win[win.length - 2]
    const avgVol  = win.reduce((s, r) => s + r.volume, 0) / win.length
    const dayLow  = Math.min(...win.map(r => r.low))
    const dayHigh = Math.max(...win.map(r => r.high))
    const volRatio = +(last.volume / avgVol).toFixed(2)
    const nearLow  = (last.low  - dayLow)  / dayLow  < 0.05
    const nearHigh = (dayHigh   - last.high) / dayHigh < 0.05
    const reversal = last.close > prev.close

    const macdResult  = calcMACD(win.map(r => r.close))
    const macdDiv     = detectDivergence(win, macdResult)
    const macdTopDiv  = detectTopDivergence(win, macdResult)
    const macdInfo    = macdResult
      ? { line: macdResult.line, sig: macdResult.sig, hist: macdResult.hist, divergence: macdDiv, topDivergence: macdTopDiv }
      : null

    const longLowerShadow = hasLongLowerShadow(last)
    const aboveMa5        = isAboveMa5(win)
    const { signal, message } = classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh, longLowerShadow, aboveMa5 })

    if (signal !== 'normal' && signal !== prevSignal) {
      const dt   = new Date(last.ts * 1000)
      const time = `${String((dt.getUTCHours() + 8) % 24).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`
      signals.push({
        time, signal, message,
        price:    +last.close.toFixed(2),
        dayLow:   +dayLow.toFixed(2),
        dayHigh:  +dayHigh.toFixed(2),
        volRatio,
        macd: macdInfo,
      })
    }
    prevSignal = signal
  }
  return signals
}

// K線圖資料：近 N 日分時 K 棒 + 訊號
app.get('/api/intraday/chart', async (req, res) => {
  const { stockNo = '2059', days = 3 } = req.query
  try {
    const datesRes = await pool.query(
      `SELECT DISTINCT bar_time::DATE AS trade_date
       FROM intraday WHERE stock_no = $1
       ORDER BY trade_date DESC LIMIT $2`,
      [stockNo, +days]
    )
    if (!datesRes.rows.length) return res.json({ bars: [], signals: [] })

    const minDate = datesRes.rows[datesRes.rows.length - 1].trade_date
    const maxDate = datesRes.rows[0].trade_date

    const barsRes = await pool.query(
      `SELECT bar_time, open_price, high_price, low_price, close_price, volume
       FROM intraday
       WHERE stock_no = $1 AND bar_time::DATE >= $2 AND bar_time::DATE <= $3
       ORDER BY bar_time ASC`,
      [stockNo, minDate, maxDate]
    )
    const bars = barsRes.rows.map(r => ({
      time:   Math.floor(new Date(r.bar_time).getTime() / 1000),
      open:   +r.open_price, high: +r.high_price,
      low:    +r.low_price,  close: +r.close_price,
      volume: +r.volume,
    }))

    const maxTime = new Date(new Date(maxDate).getTime() + 86400000)
    const sigsRes = await pool.query(
      `SELECT signal_time, signal_type, message, price
       FROM signals
       WHERE stock_no = $1 AND signal_time >= $2 AND signal_time < $3
         AND signal_type IN ('entry','warning','exit','exit_warning')
       ORDER BY signal_time ASC`,
      [stockNo, minDate, maxTime]
    )
    const signals = sigsRes.rows.map(r => ({
      time:    Math.floor(new Date(r.signal_time).getTime() / 1000),
      type:    r.signal_type, message: r.message,
      price:   r.price != null ? +r.price : null,
    }))

    res.json({ stockNo, bars, signals })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/stock/backtest', async (req, res) => {
  const { stockNo = '2059' } = req.query
  try {
    const json = await fetchUrl(
      `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(stockNo)}?interval=1m&range=5d`
    )
    const result = json.chart.result?.[0]
    if (!result?.timestamp) return res.status(500).json({ error: '無資料' })

    const q = result.indicators.quote[0]
    const allRows = result.timestamp
      .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
      .filter(r => r.close != null && r.volume > 0)

    // 依 CST 日期分組
    const byDate = {}
    for (const row of allRows) {
      const cst = new Date((row.ts + 8 * 3600) * 1000)
      const key = `${cst.getUTCFullYear()}-${String(cst.getUTCMonth()+1).padStart(2,'0')}-${String(cst.getUTCDate()).padStart(2,'0')}`
      if (!byDate[key]) byDate[key] = []
      byDate[key].push(row)
    }

    const dates = {}
    for (const [date, rows] of Object.entries(byDate).sort()) {
      dates[date] = simulateDay(rows)
    }

    res.json({ stock: stockNo, stockName: STOCK_NAMES[stockNo] || stockNo, dates })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
// 查詢訊號歷史
app.get('/api/signals', async (req, res) => {
  const { stockNo, days = 7, date } = req.query
  try {
    let result
    if (date) {
      const start = new Date(date + 'T00:00:00+08:00')
      const end   = new Date(date + 'T23:59:59+08:00')
      result = stockNo
        ? await pool.query(`SELECT id,stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source FROM signals WHERE stock_no=$1 AND signal_time>=$2 AND signal_time<=$3 ORDER BY signal_time ASC`, [stockNo, start, end])
        : await pool.query(`SELECT id,stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source FROM signals WHERE signal_time>=$1 AND signal_time<=$2 ORDER BY signal_time ASC`, [start, end])
    } else {
      result = stockNo
        ? await pool.query(`SELECT id,stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source FROM signals WHERE stock_no=$1 AND signal_time>=NOW()-INTERVAL '1 day'*$2 ORDER BY signal_time ASC`, [stockNo, +days])
        : await pool.query(`SELECT id,stock_no,stock_name,signal_time,signal_type,price,vol_ratio,day_low,day_high,message,macd_line,macd_hist,macd_div,source FROM signals WHERE signal_time>=NOW()-INTERVAL '1 day'*$1 ORDER BY signal_time ASC`, [+days])
    }
    res.json({ rows: result.rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 查詢每日行情摘要
app.get('/api/daily-summary', async (req, res) => {
  const { stockNo, days = 30 } = req.query
  try {
    const result = stockNo
      ? await pool.query(
          `SELECT stock_no,stock_name,trade_date,open_price,high_price,low_price,close_price,
                  total_volume,inst_foreign,inst_trust,inst_dealer,
                  major_net,buyer_count,seller_count,concentration_5d,concentration_20d,margin_balance
           FROM daily_summary WHERE stock_no=$1 AND trade_date>=NOW()-INTERVAL '1 day'*$2
           ORDER BY trade_date DESC, stock_no`, [stockNo, +days])
      : await pool.query(
          `SELECT stock_no,stock_name,trade_date,open_price,high_price,low_price,close_price,
                  total_volume,inst_foreign,inst_trust,inst_dealer,
                  major_net,buyer_count,seller_count,concentration_5d,concentration_20d,margin_balance
           FROM daily_summary WHERE trade_date>=NOW()-INTERVAL '1 day'*$1
           ORDER BY trade_date DESC, stock_no`, [+days])
    res.json({ rows: result.rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 查詢分時明細
app.get('/api/intraday', async (req, res) => {
  const { stockNo, date } = req.query
  if (!stockNo || !date) return res.status(400).json({ error: '需要 stockNo 和 date 參數' })
  try {
    const result = await pool.query(
      `SELECT bar_time, open_price, high_price, low_price, close_price, volume
       FROM intraday WHERE stock_no=$1 AND bar_time::DATE=$2 ORDER BY bar_time`,
      [stockNo, date]
    )
    res.json({ rows: result.rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 查詢 intraday 有資料的日期清單
app.get('/api/intraday/dates', async (req, res) => {
  const { stockNo } = req.query
  if (!stockNo) return res.status(400).json({ error: '需要 stockNo' })
  try {
    const result = await pool.query(
      `SELECT DISTINCT bar_time::DATE AS trade_date FROM intraday
       WHERE stock_no=$1 ORDER BY trade_date DESC`,
      [stockNo]
    )
    res.json({ dates: result.rows.map(r => new Date(r.trade_date).toISOString().slice(0, 10)) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 每日自動存檔 ──────────────────────────────────
async function syncDailyData() {
  console.log('[sync] 開始存入每日行情...')

  // 抓今日 TWSE 三大法人（一次抓全部個股）
  const now = new Date()
  const cstNowDate = new Date(now.getTime() + 8 * 3600000)
  const y = cstNowDate.getUTCFullYear()
  const m = String(cstNowDate.getUTCMonth() + 1).padStart(2, '0')
  const d = String(cstNowDate.getUTCDate()).padStart(2, '0')
  const todayStr = `${y}${m}${d}`

  const n = s => +(s?.replace(/,/g, '') || 0)

  const instMap = {}
  try {
    const twse = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${todayStr}&selectType=ALLBUT0999&response=json`
    )
    for (const row of twse.data || []) {
      instMap[row[0]] = { foreign: n(row[4]), trust: n(row[10]), dealer: n(row[11]) }
    }
    console.log(`[sync] TWSE 三大法人 ${Object.keys(instMap).length} 檔 ✓`)
  } catch (e) {
    console.error('[sync] TWSE 三大法人抓取失敗:', e.message)
  }

  // 抓融資餘額（TWSE 上市 + TPEX 上櫃）
  const marginMap = {}
  try {
    const twseM = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${todayStr}&selectType=STOCK&response=json`
    )
    for (const row of twseM.tables?.[1]?.data || []) {
      marginMap[row[0]] = n(row[6])
    }
    console.log(`[sync] TWSE 融資 ${Object.keys(marginMap).length} 檔 ✓`)
  } catch (e) {
    console.error('[sync] TWSE 融資抓取失敗:', e.message)
  }
  try {
    const cst = new Date(now.getTime() + 8 * 3600000)
    const minguo = cst.getUTCFullYear() - 1911
    const tpexDate = `${minguo}/${m}/${d}`
    const tpex = await fetchUrl(
      `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${tpexDate}`
    )
    for (const row of tpex.tables?.[0]?.data || []) {
      marginMap[row[0]] = n(row[6])
    }
    console.log(`[sync] TPEX 融資 ✓`)
  } catch (e) {
    console.error('[sync] TPEX 融資抓取失敗:', e.message)
  }

  for (const { no, name } of STOCKS_LIST) {
    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1d&range=5d`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) continue
      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)
      for (const row of rows) {
        const dt = new Date(row.ts * 1000)
        const rowDate = `${dt.getUTCFullYear()}${String(dt.getUTCMonth()+1).padStart(2,'0')}${String(dt.getUTCDate()).padStart(2,'0')}`
        const inst   = rowDate === todayStr ? instMap[no]   : null
        const margin = rowDate === todayStr ? marginMap[no] : null
        await saveDailySummary({
          stockNo: no, stockName: name,
          tradeDate: new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())),
          open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
          instForeign:   inst?.foreign ?? null,
          instTrust:     inst?.trust   ?? null,
          instDealer:    inst?.dealer  ?? null,
          marginBalance: margin ?? null,
        })
      }
      console.log(`[sync] ${name} 日線 ${rows.length} 筆 ✓`)
    } catch (e) { console.error(`[sync] ${name} 日線失敗:`, e.message) }
  }
}

async function syncIntradayData() {
  console.log('[sync] 開始存入分時明細...')
  for (const { no, name } of STOCKS_LIST) {
    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1m&range=1d`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) continue
      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)
      let saved = 0
      for (const row of rows) {
        try {
          await pool.query(
            `INSERT INTO intraday (stock_no,stock_name,bar_time,open_price,high_price,low_price,close_price,volume)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (stock_no,bar_time) DO UPDATE SET
               open_price=EXCLUDED.open_price, high_price=EXCLUDED.high_price,
               low_price=EXCLUDED.low_price, close_price=EXCLUDED.close_price,
               volume=EXCLUDED.volume`,
            [no, name, new Date(row.ts * 1000),
             row.open ?? null, row.high ?? null, row.low ?? null, row.close ?? null, row.volume ?? null]
          )
          saved++
        } catch (e) { /* 略過 */ }
      }
      console.log(`[sync] ${name} 分時 ${saved} 根 ✓`)
    } catch (e) { console.error(`[sync] ${name} 分時失敗:`, e.message) }
  }
}

async function syncSignalsToday() {
  console.log('[sync] 開始生成今日訊號...')
  for (const { no, name } of STOCKS_LIST) {
    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1m&range=1d`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) continue
      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)
      if (!rows.length) continue

      const detectedSignals = simulateDay(rows)
      let saved = 0
      for (const sig of detectedSignals) {
        if (!['entry', 'warning', 'exit', 'exit_warning'].includes(sig.signal)) continue
        const matchRow = rows.find(r => {
          const dt = new Date(r.ts * 1000)
          const t = `${String((dt.getUTCHours()+8)%24).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`
          return t === sig.time
        })
        await saveSignal({
          stockNo: no, stockName: name,
          signalTime: new Date((matchRow?.ts ?? rows[rows.length - 1].ts) * 1000),
          signalType: sig.signal,
          price: sig.price, volRatio: sig.volRatio,
          dayLow: sig.dayLow, dayHigh: sig.dayHigh,
          message: sig.message, macd: sig.macd,
          source: 'daily_sim',
        })
        saved++
      }
      console.log(`[sync] ${name} 今日訊號 ${saved} 筆 ✓`)
    } catch (e) { console.error(`[sync] ${name} 訊號失敗:`, e.message) }
  }
}

async function runDailySync() {
  try {
    await syncDailyData()
    await syncIntradayData()
    await syncSignalsToday()
    const now = new Date()
    const cst = `${String((now.getUTCHours()+8)%24).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`
    sendTelegram(`✅ <b>每日自動存檔完成</b> ${cst}\n四檔個股日線 + 分時 + 訊號已同步至資料庫`)
    console.log('[sync] 完成')
  } catch (e) { console.error('[sync] 失敗:', e.message) }
}

// 手動觸發同步
app.post('/api/sync/run', (req, res) => {
  res.json({ message: '同步已啟動，請查看 console 輸出' })
  runDailySync()
})

// 補抓指定個股的近 N 日分時明細 + 日線
app.post('/api/sync/intraday-range', async (req, res) => {
  const { stockNos, range = '7d' } = req.body
  const targets = stockNos?.length
    ? STOCKS_LIST.filter(s => stockNos.includes(s.no))
    : STOCKS_LIST
  res.json({ message: `開始補抓 ${targets.map(s=>s.no).join(',')} 近 ${range} 分時明細...` })

  for (const { no, name } of targets) {
    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1m&range=${range}`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) { console.log(`[intraday-range] ${name} 無資料`); continue }
      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)
      let saved = 0
      for (const row of rows) {
        try {
          await pool.query(
            `INSERT INTO intraday (stock_no,stock_name,bar_time,open_price,high_price,low_price,close_price,volume)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (stock_no,bar_time) DO UPDATE SET
               open_price=EXCLUDED.open_price, high_price=EXCLUDED.high_price,
               low_price=EXCLUDED.low_price, close_price=EXCLUDED.close_price,
               volume=EXCLUDED.volume`,
            [no, name, new Date(row.ts * 1000),
             row.open ?? null, row.high ?? null, row.low ?? null, row.close ?? null, row.volume ?? null]
          )
          saved++
        } catch(e) { /* skip duplicate */ }
      }
      console.log(`[intraday-range] ${name} 分時補抓 ${saved} 根 ✓`)
    } catch(e) { console.error(`[intraday-range] ${name} 失敗:`, e.message) }
  }

  // 同時補日線摘要（近 7 日）
  for (const { no, name } of targets) {
    try {
      const json = await fetchUrl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1d&range=10d`
      )
      const result = json.chart.result?.[0]
      if (!result?.timestamp) continue
      const q = result.indicators.quote[0]
      const rows = result.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter(r => r.close != null && r.volume > 0)
      for (const row of rows) {
        const dt = new Date(row.ts * 1000)
        await saveDailySummary({
          stockNo: no, stockName: name,
          tradeDate: new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())),
          open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
          instForeign: null, instTrust: null, instDealer: null, marginBalance: null,
        })
      }
      console.log(`[intraday-range] ${name} 日線補抓 ${rows.length} 筆 ✓`)
    } catch(e) { console.error(`[intraday-range] ${name} 日線失敗:`, e.message) }
  }
  console.log('[intraday-range] 補抓完成')
})

app.post('/api/sync/backfill', async (req, res) => {
  const { date } = req.body  // 格式: "20260428"
  if (!date) return res.status(400).json({ error: '需要提供 date 參數（格式：YYYYMMDD）' })
  res.json({ message: `開始補抓 ${date} 的資料...` })

  const n = s => +(s?.replace(/,/g, '') || 0)
  const y = date.slice(0, 4), m = date.slice(4, 6), d = date.slice(6, 8)

  const instMap = {}
  try {
    const twse = await fetchUrl(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`)
    for (const row of twse.data || []) instMap[row[0]] = { foreign: n(row[4]), trust: n(row[10]), dealer: n(row[11]) }
    console.log(`[backfill ${date}] 三大法人 ${Object.keys(instMap).length} 檔 ✓`)
  } catch (e) { console.error(`[backfill] 三大法人失敗:`, e.message) }

  const marginMap = {}
  try {
    const twseM = await fetchUrl(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${date}&selectType=STOCK&response=json`)
    for (const row of twseM.tables?.[1]?.data || []) marginMap[row[0]] = n(row[6])
  } catch (e) {}
  try {
    const minguo = +y - 1911
    const tpex = await fetchUrl(`https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${minguo}/${m}/${d}`)
    for (const row of tpex.tables?.[0]?.data || []) marginMap[row[0]] = n(row[6])
  } catch (e) {}

  for (const { no, name } of STOCKS_LIST) {
    try {
      const inst = instMap[no]
      const margin = marginMap[no] ?? null
      if (inst || margin !== null) {
        await pool.query(
          `UPDATE daily_summary SET
             inst_foreign = COALESCE($3, inst_foreign),
             inst_trust   = COALESCE($4, inst_trust),
             inst_dealer  = COALESCE($5, inst_dealer),
             margin_balance = COALESCE($6, margin_balance)
           WHERE stock_no=$1 AND trade_date=$2`,
          [no, `${y}-${m}-${d}`, inst?.foreign ?? null, inst?.trust ?? null, inst?.dealer ?? null, margin]
        )
        console.log(`[backfill ${date}] ${name} 補齊 ✓`)
      }
    } catch (e) { console.error(`[backfill] ${name} 失敗:`, e.message) }
  }
})

// 產業代碼對照表（依 t187ap03_L 實際代碼驗證）
const TWSE_SECTOR_NAMES = {
  '01':'水泥工業','02':'食品工業','03':'塑膠工業','04':'紡織纖維','05':'電機機械',
  '06':'電器電纜','08':'玻璃陶瓷','09':'造紙工業','10':'鋼鐵工業','11':'橡膠工業',
  '12':'汽車工業','14':'建材營造','15':'航運業','16':'觀光餐旅','17':'金融保險',
  '18':'貿易百貨','20':'其他','21':'化學工業','22':'生技醫療','23':'油電燃氣',
  '24':'半導體業','25':'電腦週邊','26':'光電業','27':'通信網路','28':'電子零組件',
  '29':'電子通路','30':'資訊服務','31':'其他電子','35':'綜合企業',
  '36':'文化創意業','37':'運動休閒業','38':'其他','91':'存託憑證',
}

// 快取（當日有效）
let sectorCache = { date: '', data: null }

// sector_snapshots 資料表
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sector_snapshots (
        trade_date DATE PRIMARY KEY,
        data       JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('[sector_snapshots] 資料表就緒')
  } catch(e) { console.error('[sector_snapshots] 建表失敗:', e.message) }
})()

async function computeSectorData() {
  const today  = new Date(Date.now() + 8*3600000).toISOString().slice(0,10).replace(/-/g,'')
  const allDay = await fetchUrl('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json')
  if (allDay.stat !== 'OK' || !allDay.data?.length) throw new Error('今日行情尚未收盤或休市')

  const compList = await fetchUrl('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')
  const sectorMap = {}
  for (const c of compList) {
    if (c['公司代號'] && c['產業別']) sectorMap[c['公司代號'].trim()] = c['產業別'].trim()
  }

  const stocks = []
  for (const row of allDay.data) {
    try {
      const no   = row[0].trim()
      if (!/^\d{4}$/.test(no)) continue
      const name = row[1].trim()
      const vol  = parseInt(row[2].replace(/,/g,''))
      const close= parseFloat(row[7].replace(/,/g,''))
      const chg  = parseFloat(row[8].replace(/,/g,'').trim()) || 0
      const prev = close - chg
      const pct  = prev !== 0 ? Math.round(chg / prev * 10000) / 100 : 0
      const sec  = sectorMap[no] || '29'
      stocks.push({ no, name, vol, close, pct, sector: sec, sectorName: TWSE_SECTOR_NAMES[sec] || '其他' })
    } catch(e) {}
  }

  const top50 = stocks.sort((a,b) => b.vol - a.vol).slice(0, 50)
  const groups = {}
  for (const s of top50) {
    if (!groups[s.sectorName]) groups[s.sectorName] = { stocks: [], totalPct: 0 }
    groups[s.sectorName].stocks.push(s)
    groups[s.sectorName].totalPct += s.pct
  }
  const sectors = Object.entries(groups)
    .map(([name, g]) => ({
      name,
      avgPct: Math.round(g.totalPct / g.stocks.length * 100) / 100,
      count:  g.stocks.length,
      maxPct: Math.max(...g.stocks.map(s => s.pct)),
      stocks: g.stocks.sort((a,b) => b.pct - a.pct),
    }))
    .sort((a,b) => b.avgPct - a.avgPct)

  return { date: today, top50Count: top50.length, sectors }
}

async function saveSectorSnapshot(result) {
  const d = result.date  // YYYYMMDD
  const dbDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
  await pool.query(
    `INSERT INTO sector_snapshots (trade_date, data) VALUES ($1, $2)
     ON CONFLICT (trade_date) DO UPDATE SET data=$2, created_at=NOW()`,
    [dbDate, JSON.stringify(result)]
  )
}

app.get('/api/sector-analysis', async (req, res) => {
  try {
    const today     = new Date(Date.now() + 8*3600000).toISOString().slice(0,10).replace(/-/g,'')
    const dateParam = (req.query.date || '').replace(/-/g,'') || today

    // 歷史日期 → 從 DB 取
    if (dateParam !== today) {
      const dbDate = `${dateParam.slice(0,4)}-${dateParam.slice(4,6)}-${dateParam.slice(6,8)}`
      const { rows } = await pool.query('SELECT data FROM sector_snapshots WHERE trade_date=$1', [dbDate])
      if (!rows.length) return res.status(404).json({ error: `無 ${dateParam} 的資料` })
      return res.json(rows[0].data)
    }

    // 今日 → 記憶體快取
    if (sectorCache.date === today && sectorCache.data) return res.json(sectorCache.data)

    const result = await computeSectorData()
    sectorCache = { date: today, data: result }
    saveSectorSnapshot(result).catch(e => console.error('[sector_snapshots] 儲存失敗:', e.message))
    res.json(result)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/sector-snapshots/dates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT trade_date FROM sector_snapshots ORDER BY trade_date DESC LIMIT 60'
    )
    res.json({ dates: rows.map(r => r.trade_date.toISOString().slice(0,10).replace(/-/g,'')) })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/daily-report', async (req, res) => {
  const { stockNo = '2059', date } = req.query
  const stockName = STOCK_NAMES[stockNo] || stockNo

  try {
    // 1. 從 DB 取當日行情
    const targetDate = date || new Date().toISOString().slice(0, 10)
    const dayRes = await pool.query(
      `SELECT * FROM daily_summary WHERE stock_no=$1 AND trade_date=$2`,
      [stockNo, targetDate]
    )
    const day = dayRes.rows[0] || null

    // 2. 取近 20 日行情（計算趨勢）
    const histRes = await pool.query(
      `SELECT * FROM daily_summary WHERE stock_no=$1 AND trade_date<=$2
       ORDER BY trade_date DESC LIMIT 20`,
      [stockNo, targetDate]
    )
    const hist = histRes.rows

    // 3. 取當日訊號
    const sigRes = await pool.query(
      `SELECT * FROM signals WHERE stock_no=$1
       AND signal_time::DATE=$2 ORDER BY signal_time`,
      [stockNo, targetDate]
    )
    const signals = sigRes.rows

    // 4. 抓鉅亨網新聞（近 5 筆台股大盤新聞 + 搜尋個股）
    let news = []
    try {
      const nowTs  = Math.floor(Date.now() / 1000)
      const fromTs = nowTs - 7 * 86400
      const newsRes = await fetchUrl(
        `https://api.cnyes.com/media/api/v1/newslist/category/tw_stock_news?limit=50&startAt=${fromTs}&endAt=${nowTs}`
      )
      const allNews = newsRes?.items?.data || []
      const keywords = [stockName, stockNo, '川湖', '滑軌', '伺服器']
      news = allNews
        .filter(n => keywords.some(k => (n.title || '').includes(k)))
        .slice(0, 5)
        .map(n => ({
          title: n.title,
          time:  new Date(n.publishAt * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
        }))
    } catch (e) { /* 新聞抓取失敗不影響報表 */ }

    // 5. 技術分析文字生成
    const fmt  = v => v != null ? (+v).toLocaleString() : '—'
    const fmtZ = v => v != null ? Math.floor(Math.abs(+v) / 1000).toLocaleString() + '張' : '—'
    const sign = v => v > 0 ? `+${fmtZ(v)}` : v < 0 ? `-${fmtZ(v)}` : '0'

    const analysis = []

    if (day) {
      // 價格分析
      const change = hist.length >= 2 ? day.close_price - hist[1].close_price : null
      const changePct = change != null && hist[1]?.close_price ? (change / hist[1].close_price * 100).toFixed(2) : null
      analysis.push(`📊 當日收盤 ${fmt(day.close_price)} 元，` +
        (changePct != null ? `較前日${change >= 0 ? '上漲' : '下跌'} ${Math.abs(changePct)}%，` : '') +
        `成交量 ${fmtZ(day.total_volume)}。`)

      // 三大法人
      if (day.inst_foreign != null || day.inst_trust != null) {
        const parts = []
        if (day.inst_foreign != null) parts.push(`外資 ${sign(day.inst_foreign)}`)
        if (day.inst_trust   != null) parts.push(`投信 ${sign(day.inst_trust)}`)
        if (day.inst_dealer  != null) parts.push(`自營商 ${sign(day.inst_dealer)}`)
        const majorNet = (day.inst_foreign||0) + (day.inst_trust||0) + (day.inst_dealer||0)
        analysis.push(`🏦 三大法人合計 ${majorNet >= 0 ? '買超' : '賣超'} ${fmtZ(Math.abs(majorNet))}（${parts.join('、')}）。`)
      }

      // 融資
      if (day.margin_balance != null)
        analysis.push(`💳 融資餘額 ${fmtZ(day.margin_balance)}。`)

      // 主力集中度
      if (day.concentration_5d != null)
        analysis.push(`📐 5日主力集中度 ${(+day.concentration_5d).toFixed(2)}%，20日 ${day.concentration_20d != null ? (+day.concentration_20d).toFixed(2) + '%' : '—'}。`)
    }

    // 趨勢分析
    if (hist.length >= 5) {
      const closes = hist.slice(0, 5).map(r => +r.close_price).filter(Boolean)
      const trend  = closes[0] > closes[closes.length - 1] ? '近 5 日股價走勢偏多' : '近 5 日股價走勢偏空'
      analysis.push(`📈 ${trend}（${closes[closes.length-1]} → ${closes[0]}）。`)
    }

    // 訊號分析
    if (signals.length > 0) {
      const sigLabels = { entry: '主力進場', warning: '進場警戒', exit: '主力出貨', exit_warning: '出貨警戒', watch: '注意量能' }
      const sigSummary = signals.map(s => `${sigLabels[s.signal_type] || s.signal_type}（${new Date(s.signal_time).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}）`).join('、')
      analysis.push(`🚨 當日偵測訊號：${sigSummary}。`)
    } else {
      analysis.push(`✅ 當日未偵測到異常訊號。`)
    }

    // 綜合評估
    const hasEntry   = signals.some(s => s.signal_type === 'entry')
    const hasExit    = signals.some(s => ['exit', 'exit_warning'].includes(s.signal_type))
    const majorBuy   = day && ((day.inst_foreign||0) + (day.inst_trust||0) + (day.inst_dealer||0)) > 0
    let assessment = ''
    if (hasEntry && majorBuy)      assessment = '法人買超配合主力進場訊號，短線偏多操作。'
    else if (hasEntry && !majorBuy) assessment = '主力進場訊號出現，但法人持保守態度，建議觀察量能變化。'
    else if (hasExit)               assessment = '出現出貨訊號，建議注意停利停損。'
    else if (majorBuy)              assessment = '法人買超，技術面無異常訊號，可持續追蹤。'
    else                            assessment = '技術面無明顯訊號，建議觀望等待明確方向。'
    analysis.push(`💡 綜合評估：${assessment}`)

    res.json({
      stockNo, stockName, date: targetDate,
      day: day || null,
      signals,
      news,
      analysis,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/test/telegram', (req, res) => {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  sendTelegram(
    `🧪 <b>測試通知</b>\n` +
    `時間：${now}\n\n` +
    `📈 <b>模擬訊號：川湖科技 (2059)</b>\n` +
    `類型：主力進場\n` +
    `價格：NT$680\n` +
    `量比：3.2x\n` +
    `訊息：成交量異常放大，主力吸籌跡象\n\n` +
    `⚡ 此為測試訊息，非真實訊號`
  )
  res.json({ ok: true, message: '測試訊息已發送到 Telegram' })
})

// ── 漲跌幅分布 ───────────────────────────────────────
const DIST_BUCKETS = [
  { key: 'limit_up',   label: '漲停',   side: 'up' },
  { key: 'b_u7_u9',   label: '+7~+9%', side: 'up' },
  { key: 'b_u5_u7',   label: '+5~+7%', side: 'up' },
  { key: 'b_u3_u5',   label: '+3~+5%', side: 'up' },
  { key: 'b_u1_u3',   label: '+1~+3%', side: 'up' },
  { key: 'b_u0_u1',   label: '0~+1%',  side: 'up' },
  { key: 'flat',      label: '持平',   side: 'flat' },
  { key: 'b_d0_d1',   label: '-1~0%',  side: 'down' },
  { key: 'b_d1_d3',   label: '-3~-1%', side: 'down' },
  { key: 'b_d3_d5',   label: '-5~-3%', side: 'down' },
  { key: 'b_d5_d7',   label: '-7~-5%', side: 'down' },
  { key: 'b_d7_d9',   label: '-9~-7%', side: 'down' },
  { key: 'limit_down', label: '跌停',  side: 'down' },
]

function assignBucket(pct) {
  if (pct >= 9.5) return 'limit_up'
  if (pct <= -9.5) return 'limit_down'
  if (Math.abs(pct) < 0.005) return 'flat'
  if (pct > 0) {
    if (pct <= 1) return 'b_u0_u1'
    if (pct <= 3) return 'b_u1_u3'
    if (pct <= 5) return 'b_u3_u5'
    if (pct <= 7) return 'b_u5_u7'
    return 'b_u7_u9'
  } else {
    if (pct >= -1) return 'b_d0_d1'
    if (pct >= -3) return 'b_d1_d3'
    if (pct >= -5) return 'b_d3_d5'
    if (pct >= -7) return 'b_d5_d7'
    return 'b_d7_d9'
  }
}

let distCache = { key: '', data: null }

app.get('/api/market-distribution', async (req, res) => {
  try {
    const cacheKey = Math.floor(Date.now() / (5 * 60 * 1000)).toString()
    if (distCache.key === cacheKey && distCache.data) return res.json(distCache.data)

    const twse = {}, tpex = {}
    for (const b of DIST_BUCKETS) { twse[b.key] = 0; tpex[b.key] = 0 }

    // TWSE
    try {
      const twseDay = await fetchUrl('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json')
      if (twseDay.stat === 'OK') {
        for (const row of twseDay.data || []) {
          const no = row[0]?.trim()
          if (!/^\d{4}$/.test(no)) continue
          const close = parseFloat(String(row[7] || '').replace(/,/g,''))
          const chg   = parseFloat(String(row[8] || '').replace(/,/g,'').trim()) || 0
          const prev  = close - chg
          if (!prev || !isFinite(prev)) continue
          twse[assignBucket(chg / prev * 100)]++
        }
      }
    } catch(e) { console.error('[dist] TWSE 失敗:', e.message) }

    // TPEX
    try {
      const now = new Date(Date.now() + 8*3600000)
      const minguo = now.getUTCFullYear() - 1911
      const mm = String(now.getUTCMonth()+1).padStart(2,'0')
      const dd = String(now.getUTCDate()).padStart(2,'0')
      const tpexDay = await fetchUrl(
        `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&o=json&d=${minguo}/${mm}/${dd}&se=EW`
      )
      for (const table of tpexDay.tables || []) {
        for (const row of table.data || []) {
          const no = row[0]?.trim()
          if (!/^\d{4,5}$/.test(no)) continue
          const chgStr = String(row[3] || '').trim()
          if (!chgStr || chgStr === '----') continue
          const close = parseFloat(String(row[2] || '').replace(/,/g,''))
          const chg   = parseFloat(chgStr.replace(/,/g,''))
          const prev  = close - chg
          if (!prev || !isFinite(prev)) continue
          tpex[assignBucket(chg / prev * 100)]++
        }
      }
    } catch(e) { console.error('[dist] TPEX 失敗:', e.message) }

    const result = {
      buckets: DIST_BUCKETS.map(b => ({ key: b.key, label: b.label, side: b.side, twse: twse[b.key], tpex: tpex[b.key] })),
      total: {
        twse: Object.values(twse).reduce((a,b) => a+b, 0),
        tpex: Object.values(tpex).reduce((a,b) => a+b, 0),
      },
      updatedAt: new Date(Date.now() + 8*3600000).toISOString().slice(0,16).replace('T',' '),
    }
    distCache = { key: cacheKey, data: result }
    res.json(result)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 上市櫃漲跌家數 ───────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_breadth (
        trade_date      DATE PRIMARY KEY,
        twse_up         INT DEFAULT 0,
        twse_up_limit   INT DEFAULT 0,
        twse_down       INT DEFAULT 0,
        twse_down_limit INT DEFAULT 0,
        twse_flat       INT DEFAULT 0,
        tpex_up         INT DEFAULT 0,
        tpex_up_limit   INT DEFAULT 0,
        tpex_down       INT DEFAULT 0,
        tpex_down_limit INT DEFAULT 0,
        tpex_flat       INT DEFAULT 0,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('[market_breadth] 資料表就緒')
  } catch (e) {
    console.error('[market_breadth] 建表失敗:', e.message)
  }
})()

async function syncMarketBreadth() {
  console.log('[market_breadth] 開始同步漲跌家數...')
  try {
    const parseCount = (s) => {
      const m = String(s || '').replace(/,/g, '').match(/(\d+)(?:\((\d+)\))?/)
      return { count: parseInt(m?.[1]) || 0, limit: parseInt(m?.[2]) || 0 }
    }

    // 1. TWSE 上市（MI_INDEX）
    const twseData = await fetchUrl('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json')
    const breadthTable = twseData.tables?.find(t => t.title === '漲跌證券數合計')
    const upRow   = breadthTable?.data?.find(r => r[0]?.includes('上漲'))
    const downRow = breadthTable?.data?.find(r => r[0]?.includes('下跌'))
    const flatRow = breadthTable?.data?.find(r => r[0]?.includes('持平'))
    const twseUp   = parseCount(upRow?.[2])
    const twseDown = parseCount(downRow?.[2])
    const twseFlat = parseInt(String(flatRow?.[2] || '0').replace(/,/g,'')) || 0

    // 取得日期（從標題 '115年04月29日 大盤統計資訊'）
    const dateTitle = twseData.tables?.find(t => t.title?.includes('大盤統計資訊'))?.title || ''
    const dm = dateTitle.match(/(\d+)年(\d+)月(\d+)日/)
    const tradeDate = dm
      ? `${parseInt(dm[1]) + 1911}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`
      : new Date(Date.now() + 8*3600000).toISOString().slice(0,10)

    // 2. TPEX 上櫃（計算漲跌）
    const tpexData = await fetchUrl(
      'https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&o=json&d=' +
      tradeDate.slice(0,4).replace(/.*/, y => (parseInt(y)-1911)) + '/' +
      tradeDate.slice(5,7) + '/' + tradeDate.slice(8,10) +
      '&se=EW'
    )
    let tpexUp=0, tpexUpLimit=0, tpexDown=0, tpexDownLimit=0, tpexFlat=0
    for (const table of tpexData.tables || []) {
      for (const row of table.data || []) {
        if (!/^\d{4}$/.test(row[0]?.trim())) continue
        const chg = row[3]?.trim() || ''
        if (chg.startsWith('+')) {
          try {
            const val = parseFloat(chg.replace('+','').replace(/,/g,''))
            const close = parseFloat(row[2]?.replace(/,/g,''))
            if ((close - val) > 0 && val/(close-val)*100 >= 9.5) tpexUpLimit++
          } catch {}
          tpexUp++
        } else if (chg.startsWith('-')) {
          try {
            const val = parseFloat(chg.replace('-','').replace(/,/g,''))
            const close = parseFloat(row[2]?.replace(/,/g,''))
            if ((close + val) > 0 && val/(close+val)*100 >= 9.5) tpexDownLimit++
          } catch {}
          tpexDown++
        } else if (row[2] !== '----') {
          tpexFlat++
        }
      }
    }

    await pool.query(`
      INSERT INTO market_breadth (
        trade_date,
        twse_up, twse_up_limit, twse_down, twse_down_limit, twse_flat,
        tpex_up, tpex_up_limit, tpex_down, tpex_down_limit, tpex_flat,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (trade_date) DO UPDATE SET
        twse_up=$2, twse_up_limit=$3, twse_down=$4, twse_down_limit=$5, twse_flat=$6,
        tpex_up=$7, tpex_up_limit=$8, tpex_down=$9, tpex_down_limit=$10, tpex_flat=$11,
        updated_at=NOW()
    `, [
      tradeDate,
      twseUp.count, twseUp.limit, twseDown.count, twseDown.limit, twseFlat,
      tpexUp, tpexUpLimit, tpexDown, tpexDownLimit, tpexFlat,
    ])
    console.log(`[market_breadth] ${tradeDate} 上市:↑${twseUp.count}(${twseUp.limit})↓${twseDown.count}(${twseDown.limit}) 上櫃:↑${tpexUp}(${tpexUpLimit})↓${tpexDown}(${tpexDownLimit})`)
  } catch (e) {
    console.error('[market_breadth] 同步失敗:', e.message)
  }
}

app.get('/api/market-breadth', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM market_breadth ORDER BY trade_date DESC LIMIT 30
    `)
    res.json({ rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/sync/market-breadth', async (req, res) => {
  res.json({ ok: true, message: '同步已開始' })
  syncMarketBreadth()
})

// ── 台指期籌碼快訊 ───────────────────────────────────
const TAIFEX_BASE = 'https://openapi.taifex.com.tw/v1'

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS futures_chips (
        trade_date      DATE PRIMARY KEY,
        foreign_tx_long  BIGINT DEFAULT 0,
        foreign_tx_short BIGINT DEFAULT 0,
        foreign_tx_net   BIGINT DEFAULT 0,
        trust_tx_long    BIGINT DEFAULT 0,
        trust_tx_short   BIGINT DEFAULT 0,
        trust_tx_net     BIGINT DEFAULT 0,
        dealer_tx_long   BIGINT DEFAULT 0,
        dealer_tx_short  BIGINT DEFAULT 0,
        dealer_tx_net    BIGINT DEFAULT 0,
        large_top5_long  BIGINT DEFAULT 0,
        large_top5_short BIGINT DEFAULT 0,
        large_top10_long BIGINT DEFAULT 0,
        large_top10_short BIGINT DEFAULT 0,
        oi_market        BIGINT DEFAULT 0,
        pc_volume_ratio  NUMERIC(6,2),
        pc_oi_ratio      NUMERIC(6,2),
        put_oi           BIGINT DEFAULT 0,
        call_oi          BIGINT DEFAULT 0,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('[futures_chips] 資料表就緒')
  } catch (e) {
    console.error('[futures_chips] 建表失敗:', e.message)
  }
})()

async function syncFuturesChips() {
  console.log('[futures_chips] 開始同步台指期籌碼...')
  try {
    const [instData, largeData, pcData] = await Promise.all([
      fetchUrl(TAIFEX_BASE + '/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate'),
      fetchUrl(TAIFEX_BASE + '/OpenInterestOfLargeTradersFutures'),
      fetchUrl(TAIFEX_BASE + '/PutCallRatio'),
    ])

    const tx = instData.filter(r => r.ContractCode === '臺股期貨')
    if (!tx.length) { console.log('[futures_chips] 無台指期資料（可能休市）'); return }

    const getInst = (item) => {
      const row = tx.find(r => r.Item === item)
      if (!row) return { long: 0, short: 0, net: 0 }
      return {
        long:  parseInt(row['OpenInterest(Long)'])  || 0,
        short: parseInt(row['OpenInterest(Short)']) || 0,
        net:   parseInt(row['OpenInterest(Net)'])   || 0,
      }
    }
    const foreign = getInst('外資及陸資')
    const trust   = getInst('投信')
    const dealer  = getInst('自營商')

    const dateStr   = tx[0].Date   // YYYYMMDD
    const tradeDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`

    const largeTX = largeData.find(r => r.Contract === 'TX' && r.SettlementMonth === '999912' && r.TypeOfTraders === '0') || {}
    const latestPC = pcData?.length ? pcData[pcData.length - 1] : null

    await pool.query(`
      INSERT INTO futures_chips (
        trade_date,
        foreign_tx_long, foreign_tx_short, foreign_tx_net,
        trust_tx_long, trust_tx_short, trust_tx_net,
        dealer_tx_long, dealer_tx_short, dealer_tx_net,
        large_top5_long, large_top5_short, large_top10_long, large_top10_short, oi_market,
        pc_volume_ratio, pc_oi_ratio, put_oi, call_oi, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
      ON CONFLICT (trade_date) DO UPDATE SET
        foreign_tx_long=$2, foreign_tx_short=$3, foreign_tx_net=$4,
        trust_tx_long=$5,   trust_tx_short=$6,   trust_tx_net=$7,
        dealer_tx_long=$8,  dealer_tx_short=$9,  dealer_tx_net=$10,
        large_top5_long=$11, large_top5_short=$12, large_top10_long=$13, large_top10_short=$14, oi_market=$15,
        pc_volume_ratio=$16, pc_oi_ratio=$17, put_oi=$18, call_oi=$19, updated_at=NOW()
    `, [
      tradeDate,
      foreign.long, foreign.short, foreign.net,
      trust.long,   trust.short,   trust.net,
      dealer.long,  dealer.short,  dealer.net,
      parseInt(largeTX.Top5Buy)    || 0,
      parseInt(largeTX.Top5Sell)   || 0,
      parseInt(largeTX.Top10Buy)   || 0,
      parseInt(largeTX.Top10Sell)  || 0,
      parseInt(largeTX.OIOfMarket) || 0,
      latestPC ? parseFloat(latestPC['PutCallVolumeRatio%']) : null,
      latestPC ? parseFloat(latestPC['PutCallOIRatio%'])     : null,
      latestPC ? parseInt(latestPC.PutOI)  : 0,
      latestPC ? parseInt(latestPC.CallOI) : 0,
    ])
    console.log(`[futures_chips] ${tradeDate} 同步完成`)
  } catch (e) {
    console.error('[futures_chips] 同步失敗:', e.message)
  }
}

app.get('/api/futures-chips', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM futures_chips ORDER BY trade_date DESC LIMIT 20
    `)
    res.json({ rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/sync/futures-chips', async (req, res) => {
  res.json({ ok: true, message: '同步已開始' })
  syncFuturesChips()
})

// PC 比率歷史回填（TAIFEX PutCallRatio 約 21 個交易日）
async function backfillPCRatio() {
  console.log('[backfill_pc] 開始 PC 比率回填...')
  try {
    const pcData = await fetchUrl(TAIFEX_BASE + '/PutCallRatio')
    if (!pcData?.length) { console.log('[backfill_pc] 無資料'); return }

    let inserted = 0, updated = 0
    for (const r of pcData) {
      const d = r.Date  // YYYYMMDD
      const tradeDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
      const pcVol = parseFloat(r['PutCallVolumeRatio%']) || null
      const pcOI  = parseFloat(r['PutCallOIRatio%'])     || null
      const putOI  = parseInt(r.PutOI)  || 0
      const callOI = parseInt(r.CallOI) || 0

      const existing = await pool.query(
        `SELECT trade_date FROM futures_chips WHERE trade_date=$1`, [tradeDate]
      )
      if (existing.rows.length) {
        await pool.query(
          `UPDATE futures_chips SET pc_volume_ratio=$2, pc_oi_ratio=$3, put_oi=$4, call_oi=$5
           WHERE trade_date=$1`,
          [tradeDate, pcVol, pcOI, putOI, callOI]
        )
        updated++
      } else {
        await pool.query(
          `INSERT INTO futures_chips (trade_date,
             foreign_tx_long, foreign_tx_short, foreign_tx_net,
             trust_tx_long, trust_tx_short, trust_tx_net,
             dealer_tx_long, dealer_tx_short, dealer_tx_net,
             pc_volume_ratio, pc_oi_ratio, put_oi, call_oi, updated_at)
           VALUES ($1,0,0,0,0,0,0,0,0,0,$2,$3,$4,$5,NOW())
           ON CONFLICT (trade_date) DO NOTHING`,
          [tradeDate, pcVol, pcOI, putOI, callOI]
        )
        inserted++
      }
    }
    console.log(`[backfill_pc] 完成：新增 ${inserted} 筆，更新 ${updated} 筆`)
  } catch(e) {
    console.error('[backfill_pc] 失敗:', e.message)
  }
}

app.post('/api/sync/backfill-pc', async (req, res) => {
  res.json({ ok: true, message: 'PC 比率回填已開始' })
  backfillPCRatio()
})

// 回填 daily_summary 三大法人 + 融資（補抓 inst_foreign IS NULL 的日期）
async function backfillDailyInst() {
  console.log('[backfill_inst] 開始補抓三大法人 + 融資...')
  // 找出缺 inst_foreign 的所有日期
  const { rows: missingRows } = await pool.query(`
    SELECT DISTINCT trade_date::DATE::TEXT AS td
    FROM daily_summary
    WHERE inst_foreign IS NULL AND trade_date < NOW()
    ORDER BY td DESC
    LIMIT 30
  `)
  if (!missingRows.length) { console.log('[backfill_inst] 無缺漏日期'); return }

  const n = s => +(s?.replace(/,/g, '') || 0)

  for (const { td } of missingRows) {
    const dateStr = td.replace(/-/g, '')  // YYYYMMDD
    console.log(`[backfill_inst] 補抓 ${td}...`)

    // 三大法人
    const instMap = {}
    try {
      const twse = await fetchUrl(
        `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr}&selectType=ALLBUT0999&response=json`
      )
      for (const row of twse.data || []) {
        instMap[row[0]] = { foreign: n(row[4]), trust: n(row[10]), dealer: n(row[11]) }
      }
      console.log(`  [inst] ${td} T86 ${Object.keys(instMap).length} 檔`)
    } catch(e) { console.error(`  [inst] ${td} T86 失敗:`, e.message) }

    // 融資餘額
    const marginMap = {}
    try {
      const twseM = await fetchUrl(
        `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr}&selectType=STOCK&response=json`
      )
      for (const row of twseM.tables?.[1]?.data || []) marginMap[row[0]] = n(row[6])
      console.log(`  [margin] ${td} TWSE ${Object.keys(marginMap).length} 檔`)
    } catch(e) { console.error(`  [margin] ${td} TWSE 失敗:`, e.message) }

    try {
      const [y, m, d] = td.split('-')
      const minguo = +y - 1911
      const tpexDate = `${minguo}/${m}/${d}`
      const tpex = await fetchUrl(
        `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${tpexDate}`
      )
      for (const row of tpex.tables?.[0]?.data || []) marginMap[row[0]] = n(row[6])
    } catch(e) { /* TPEX 選擇性補充 */ }

    // 更新 DB
    let updated = 0
    for (const { no } of STOCKS_LIST) {
      const inst   = instMap[no]
      const margin = marginMap[no]
      if (!inst && !margin) continue
      await pool.query(`
        UPDATE daily_summary SET
          inst_foreign   = COALESCE($2, inst_foreign),
          inst_trust     = COALESCE($3, inst_trust),
          inst_dealer    = COALESCE($4, inst_dealer),
          margin_balance = COALESCE($5, margin_balance)
        WHERE stock_no=$1 AND trade_date=$6
      `, [
        no,
        inst?.foreign ?? null, inst?.trust ?? null, inst?.dealer ?? null,
        margin ?? null,
        td,
      ])
      updated++
    }
    console.log(`  [backfill_inst] ${td} 更新 ${updated} 檔`)
    await new Promise(r => setTimeout(r, 500))  // 避免 API rate limit
  }
  console.log('[backfill_inst] 完成')
}

app.post('/api/sync/backfill-daily-inst', async (req, res) => {
  res.json({ ok: true, message: '三大法人回填已開始' })
  backfillDailyInst()
})

// 同步執行 concentration 並回傳結果
app.get('/api/debug/concentration-sync', async (req, res) => {
  try {
    const csvText = await new Promise((resolve, reject) => {
      https.get('https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
        (r) => {
          const chunks = []
          r.on('data', c => chunks.push(c))
          r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          r.on('error', reject)
        }
      ).on('error', reject)
    })

    const lines = csvText.split('\n').slice(1)
    const byStock = {}
    for (const line of lines) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const dateStr = parts[0].trim()
      const stockNo = parts[1].trim()
      const level   = parseInt(parts[2])
      const pct     = parseFloat(parts[5]) || 0
      const shares  = parseInt(parts[4])   || 0
      const count   = parseInt(parts[3])   || 0
      if (!STOCK_NAMES[stockNo]) continue
      if (!byStock[stockNo]) byStock[stockNo] = { dateStr, levels: {} }
      byStock[stockNo].levels[level] = { pct, shares, count }
    }

    const results = []
    for (const [stockNo, { dateStr, levels }] of Object.entries(byStock)) {
      const largePct    = [12,13,14,15].reduce((s,l) => s + (levels[l]?.pct    || 0), 0)
      const largeShares = [12,13,14,15].reduce((s,l) => s + (levels[l]?.shares || 0), 0)
      const largeCount  = [12,13,14,15].reduce((s,l) => s + (levels[l]?.count  || 0), 0)
      const totalShares = levels[17]?.shares || 0
      const dataDate    = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`
      try {
        await pool.query(`
          INSERT INTO concentration (stock_no, data_date, large_pct, large_shares, large_count, total_shares)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (stock_no, data_date) DO UPDATE SET
            large_pct=$3, large_shares=$4, large_count=$5, total_shares=$6
        `, [stockNo, dataDate, +largePct.toFixed(4), largeShares, largeCount, totalShares])
        results.push({ stockNo, dataDate, largePct: +largePct.toFixed(2), ok: true })
      } catch(e) {
        results.push({ stockNo, dataDate, error: e.message })
      }
    }
    res.json({ stocksFound: Object.keys(byStock).length, results })
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.slice(0,500) })
  }
})

// 直接測試 TDCC CSV 下載
app.get('/api/debug/tdcc-test', async (req, res) => {
  try {
    const csvText = await new Promise((resolve, reject) => {
      https.get('https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
        (r) => {
          const chunks = []
          r.on('data', c => chunks.push(c))
          r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          r.on('error', reject)
        }
      ).on('error', reject)
    })
    const lines = csvText.split('\n')
    const header = lines[0]
    const totalLines = lines.length
    const sample2059 = lines.filter(l => l.split(',')[1]?.trim() === '2059').slice(0, 5)
    res.json({ ok: true, totalLines, header, sample2059, firstLine: lines[1] })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/debug/taifex-raw', (req, res) => {
  const url = 'https://openapi.taifex.com.tw/v1/PutCallRatio'
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
  https.get(url, { headers }, (r) => {
    const chunks = []
    r.on('data', c => chunks.push(c))
    r.on('end', () => {
      const raw = Buffer.concat(chunks)
      res.json({
        status: r.statusCode,
        headers: r.headers,
        bytes: raw.length,
        preview: raw.slice(0, 200).toString('utf8'),
        encoding: r.headers['content-encoding'] || 'none',
      })
    })
  }).on('error', e => res.json({ error: e.message }))
})

app.get('/api/debug/futures-chips', async (req, res) => {
  try {
    const TAIFEX_BASE = 'https://openapi.taifex.com.tw/v1'
    const [instData, largeData, pcData] = await Promise.all([
      fetchUrl(TAIFEX_BASE + '/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate'),
      fetchUrl(TAIFEX_BASE + '/OpenInterestOfLargeTradersFutures'),
      fetchUrl(TAIFEX_BASE + '/PutCallRatio'),
    ])
    const tx = instData.filter(r => r.ContractCode === '臺股期貨')
    const dateStr = tx[0]?.Date
    const tradeDate = dateStr ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` : null
    const getInst = (item) => {
      const row = tx.find(r => r.Item === item)
      return row ? { long: parseInt(row['OpenInterest(Long)']), short: parseInt(row['OpenInterest(Short)']), net: parseInt(row['OpenInterest(Net)']) } : null
    }
    const largeTX = largeData.find(r => r.Contract === 'TX' && r.SettlementMonth === '999912' && r.TypeOfTraders === '0')
    const latestPC = pcData?.length ? pcData[pcData.length-1] : null

    // 試寫入 DB
    let dbResult = null, dbError = null
    if (tx.length && tradeDate) {
      const foreign = getInst('外資及陸資') || { long:0, short:0, net:0 }
      const trust   = getInst('投信')       || { long:0, short:0, net:0 }
      const dealer  = getInst('自營商')     || { long:0, short:0, net:0 }
      try {
        await pool.query(`
          INSERT INTO futures_chips (
            trade_date,
            foreign_tx_long, foreign_tx_short, foreign_tx_net,
            trust_tx_long, trust_tx_short, trust_tx_net,
            dealer_tx_long, dealer_tx_short, dealer_tx_net,
            large_top5_long, large_top5_short, large_top10_long, large_top10_short, oi_market,
            pc_volume_ratio, pc_oi_ratio, put_oi, call_oi, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
          ON CONFLICT (trade_date) DO UPDATE SET
            foreign_tx_long=$2, foreign_tx_short=$3, foreign_tx_net=$4,
            trust_tx_long=$5,   trust_tx_short=$6,   trust_tx_net=$7,
            dealer_tx_long=$8,  dealer_tx_short=$9,  dealer_tx_net=$10,
            large_top5_long=$11, large_top5_short=$12, large_top10_long=$13, large_top10_short=$14, oi_market=$15,
            pc_volume_ratio=$16, pc_oi_ratio=$17, put_oi=$18, call_oi=$19, updated_at=NOW()
        `, [
          tradeDate,
          foreign.long, foreign.short, foreign.net,
          trust.long,   trust.short,   trust.net,
          dealer.long,  dealer.short,  dealer.net,
          parseInt(largeTX?.Top5Buy)||0, parseInt(largeTX?.Top5Sell)||0,
          parseInt(largeTX?.Top10Buy)||0, parseInt(largeTX?.Top10Sell)||0,
          parseInt(largeTX?.OIOfMarket)||0,
          latestPC ? parseFloat(latestPC['PutCallVolumeRatio%']) : null,
          latestPC ? parseFloat(latestPC['PutCallOIRatio%'])     : null,
          latestPC ? parseInt(latestPC.PutOI)  : 0,
          latestPC ? parseInt(latestPC.CallOI) : 0,
        ])
        dbResult = 'inserted/updated ok'
      } catch(e) { dbError = e.message }
    }

    res.json({ tx: tx.length, tradeDate, foreign: getInst('外資及陸資'), trust: getInst('投信'), dealer: getInst('自營商'), largeTX, latestPC, dbResult, dbError })
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.slice(0,300) })
  }
})

// Debug: T86 原始欄位確認
app.get('/api/debug/t86-raw', async (req, res) => {
  try {
    const date = req.query.date || new Date(Date.now()+8*3600000).toISOString().slice(0,10).replace(/-/g,'')
    const data = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`
    )
    const sample = (data?.data || []).filter(r => /^\d{4}$/.test(r[0]?.trim())).slice(0, 5)
    res.json({
      stat: data?.stat, total: data?.data?.length,
      fields: data?.fields,
      sample: sample.map(r => ({
        code: r[0], name: r[1],
        r4: r[4], r8: r[8], r10: r[10], r11: r[11], r14: r[14],
        allCols: r,
      }))
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Debug: 詳細診斷選股篩選條件
app.get('/api/debug/screener-check', async (req, res) => {
  try {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS cnt, MAX(trade_date) AS latest FROM market_daily`)
    const { rows: srRows }    = await pool.query(`SELECT COUNT(*) AS cnt, MAX(run_date) AS latest FROM screener_results`)

    // 最新日期有多少股票有 inst_trust 資料（非 NULL）
    const { rows: trustRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE inst_trust IS NOT NULL) AS has_trust,
        COUNT(*) FILTER (WHERE inst_trust > 0) AS trust_positive,
        COUNT(*) FILTER (WHERE inst_trust IS NULL) AS no_trust,
        COUNT(*) FILTER (WHERE margin_bal IS NOT NULL) AS has_margin,
        trade_date
      FROM market_daily
      WHERE trade_date = (SELECT MAX(trade_date) FROM market_daily)
      GROUP BY trade_date
    `)

    // 找有多少股票連續 3 天以上 inst_trust > 0（用 SQL 直接算）
    const { rows: streakRows } = await pool.query(`
      WITH ranked AS (
        SELECT stock_no, trade_date, inst_trust,
               ROW_NUMBER() OVER (PARTITION BY stock_no ORDER BY trade_date DESC) AS rn
        FROM market_daily
        WHERE trade_date >= CURRENT_DATE - 20
      ),
      streaks AS (
        SELECT stock_no,
          SUM(CASE WHEN rn <= 3 AND inst_trust > 0 THEN 1 ELSE 0 END) AS last3_positive,
          SUM(CASE WHEN rn <= 5 AND inst_trust > 0 THEN 1 ELSE 0 END) AS last5_positive,
          COUNT(*) AS total_days
        FROM ranked
        GROUP BY stock_no
      )
      SELECT
        COUNT(*) FILTER (WHERE last3_positive >= 3) AS streak3_count,
        COUNT(*) FILTER (WHERE last5_positive >= 5) AS streak5_count,
        COUNT(*) AS total_stocks
      FROM streaks
    `)

    // 找有多少股票 5 日主力淨買 > 0
    const { rows: majorRows } = await pool.query(`
      WITH recent5 AS (
        SELECT stock_no,
          SUM(COALESCE(inst_foreign,0) + COALESCE(inst_trust,0)) AS major_net5
        FROM market_daily
        WHERE trade_date >= CURRENT_DATE - 7
        GROUP BY stock_no
      )
      SELECT COUNT(*) FILTER (WHERE major_net5 > 0) AS major_positive FROM recent5
    `)

    // 取幾筆樣本看 inst_trust 實際值
    const { rows: sampleRows } = await pool.query(`
      SELECT stock_no, stock_name, trade_date, close, inst_foreign, inst_trust, inst_dealer, margin_bal
      FROM market_daily
      WHERE trade_date = (SELECT MAX(trade_date) FROM market_daily)
        AND inst_trust IS NOT NULL
      ORDER BY inst_trust DESC NULLS LAST
      LIMIT 10
    `)

    // 各日期 inst_trust 狀況
    const { rows: perDateRows } = await pool.query(`
      SELECT trade_date::DATE::TEXT AS td,
        COUNT(*) AS stocks,
        COUNT(*) FILTER (WHERE inst_trust IS NOT NULL) AS has_trust,
        COUNT(*) FILTER (WHERE inst_trust > 0) AS trust_pos,
        COUNT(*) FILTER (WHERE margin_bal IS NOT NULL) AS has_margin
      FROM market_daily
      WHERE trade_date >= CURRENT_DATE - 20
      GROUP BY trade_date ORDER BY trade_date DESC
    `)

    res.json({
      market_daily: countRows[0],
      screener_results: srRows[0],
      latest_day_stats: trustRows[0],
      streak_stats: streakRows[0],
      major_stats: majorRows[0],
      per_date: perDateRows,
      top10_trust: sampleRows,
    })
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack?.slice(0,500) }) }
})

// ── 台股選股系統 ─────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_daily (
        stock_no     VARCHAR(10),
        trade_date   DATE,
        stock_name   VARCHAR(50),
        close        NUMERIC(10,2),
        open_p       NUMERIC(10,2),
        high         NUMERIC(10,2),
        low          NUMERIC(10,2),
        volume       BIGINT,
        inst_foreign BIGINT,
        inst_trust   BIGINT,
        inst_dealer  BIGINT,
        margin_bal   BIGINT,
        short_bal    BIGINT,
        PRIMARY KEY (stock_no, trade_date)
      )
    `)
    await pool.query(`ALTER TABLE market_daily ADD COLUMN IF NOT EXISTS short_bal BIGINT`).catch(()=>{})
    await pool.query(`
      CREATE TABLE IF NOT EXISTS screener_results (
        run_date     DATE,
        stock_no     VARCHAR(10),
        stock_name   VARCHAR(50),
        score        NUMERIC(5,1),
        phase        VARCHAR(5),
        is_stealth   BOOLEAN DEFAULT FALSE,
        trust_streak INT,
        major_net5   BIGINT,
        margin_chg5  BIGINT,
        close        NUMERIC(10,2),
        change_pct   NUMERIC(6,2),
        close_rank   NUMERIC(6,4),
        vol_ratio    NUMERIC(6,2),
        detail       JSONB,
        PRIMARY KEY (run_date, stock_no)
      )
    `)
    console.log('[screener] 資料表就緒')
  } catch(e) { console.error('[screener] 建表失敗:', e.message) }
})()

function getPastTradingDays(n) {
  const days = []
  const now = new Date(Date.now() + 8 * 3600000)
  let d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  while (days.length < n) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      const y  = d.getUTCFullYear()
      const m  = String(d.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(d.getUTCDate()).padStart(2, '0')
      days.push(`${y}${m}${dd}`)
    }
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return days
}

// TWSE 有效股票代號：4位數字（一般股）、5-6位數字（ETF）、英數混合≤7碼（槓反ETF）
const isValidStockCode = c => /^\d{4,6}$/.test(c) || /^[0-9][0-9A-Z]{4,6}$/.test(c)

async function syncMarketDailyOne(dateStr8) {
  const tradeDate = `${dateStr8.slice(0,4)}-${dateStr8.slice(4,6)}-${dateStr8.slice(6,8)}`
  const n = s => +(String(s||0).replace(/,/g,'').replace(/\+/g,'')) || 0
  // TPEX 民國年日期格式 (e.g. "115/04/30")
  const tpexD = `${parseInt(dateStr8.slice(0,4))-1911}/${dateStr8.slice(4,6)}/${dateStr8.slice(6,8)}`
  console.log(`[market_daily] 同步 ${tradeDate}...`)

  // ── TWSE 上市行情 ──────────────────────────────────────
  let priceRows = []
  try {
    const data = await fetchUrl(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${dateStr8}&response=json`)
    if (data?.stat === 'OK') {
      for (const row of data.data || []) {
        const stockNo = row[0]?.trim()
        if (!isValidStockCode(stockNo)) continue
        try {
          const vol   = n(row[2])
          const open  = parseFloat(String(row[4]||'').replace(/,/g,''))
          const high  = parseFloat(String(row[5]||'').replace(/,/g,''))
          const low   = parseFloat(String(row[6]||'').replace(/,/g,''))
          const close = parseFloat(String(row[7]||'').replace(/,/g,''))
          if (!close || !vol || isNaN(close)) continue
          priceRows.push({ stockNo, stockName: row[1]?.trim() || stockNo, vol,
            open: isNaN(open)?null:open, high: isNaN(high)?null:high,
            low: isNaN(low)?null:low, close, exchange: 'TWSE' })
        } catch {}
      }
    }
    console.log(`[market_daily] ${tradeDate} TWSE行情 ${priceRows.length} 檔`)
  } catch(e) { console.error(`[market_daily] ${tradeDate} TWSE行情失敗:`, e.message) }

  // ── TPEX 上櫃行情 ──────────────────────────────────────
  const tpexStockSet = new Set()
  try {
    const tpexInst = await fetchUrl(
      `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=${tpexD}&t=D`
    )
    for (const row of tpexInst?.tables?.[0]?.data || []) {
      const no = row[0]?.trim()
      if (no) tpexStockSet.add(no)
    }
  } catch(e) {}

  if (tpexStockSet.size > 0) {
    try {
      const tpexP = await fetchUrl(
        `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&o=json&d=${tpexD}`
      )
      for (const row of tpexP?.tables?.[0]?.data || []) {
        const stockNo = row[0]?.trim()
        if (!stockNo || !tpexStockSet.has(stockNo)) continue
        try {
          const vol   = n(row[8])
          const open  = parseFloat(String(row[4]||'').replace(/,/g,''))
          const high  = parseFloat(String(row[5]||'').replace(/,/g,''))
          const low   = parseFloat(String(row[6]||'').replace(/,/g,''))
          const close = parseFloat(String(row[2]||'').replace(/,/g,''))
          if (!close || !vol || isNaN(close)) continue
          priceRows.push({ stockNo, stockName: row[1]?.trim() || stockNo, vol,
            open: isNaN(open)?null:open, high: isNaN(high)?null:high,
            low: isNaN(low)?null:low, close, exchange: 'TPEX' })
        } catch {}
      }
      console.log(`[market_daily] ${tradeDate} TPEX行情 ${tpexStockSet.size} 檔`)
    } catch(e) { console.error(`[market_daily] ${tradeDate} TPEX行情失敗:`, e.message) }
  }

  if (!priceRows.length) { console.log(`[market_daily] ${tradeDate} 無行情（休市？）`); return 0 }

  // ── TWSE T86 三大法人 ──────────────────────────────────
  const instMap = {}
  let t86HasData = false
  let t86ApiOk = false  // true only when API returned valid JSON (not an error)
  try {
    const twse = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateStr8}&selectType=ALLBUT0999&response=json`
    )
    if (twse?.stat === 'OK') {
      t86ApiOk = true
      for (const row of twse.data || []) {
        const no = row[0]?.trim()
        if (no) instMap[no] = { foreign: n(row[4]), trust: n(row[10]), dealer: n(row[11]) }
      }
      t86HasData = Object.keys(instMap).length > 0
    } else if (twse?.stat) {
      // API responded with non-OK stat (e.g. "查詢日期無效") — genuine holiday/no-data
      t86ApiOk = true
    }
    console.log(`[market_daily] ${tradeDate} T86 ${Object.keys(instMap).length} 檔`)
  } catch(e) { console.error(`[market_daily] ${tradeDate} T86 失敗:`, e.message) }

  const nowDateStr8 = new Date(Date.now()+8*3600000).toISOString().slice(0,10).replace(/-/g,'')
  // Only delete on confirmed holiday: API responded cleanly with no data AND no TPEX data either
  const hasTpexPrices = priceRows.some(r => r.exchange === 'TPEX')
  if (!t86HasData && t86ApiOk && !hasTpexPrices && dateStr8 !== nowDateStr8) {
    console.log(`[market_daily] ${tradeDate} T86 無資料，判定為休市日，跳過寫入`)
    await pool.query(`DELETE FROM market_daily WHERE trade_date=$1`, [tradeDate]).catch(()=>{})
    return 0
  }
  // If T86 API failed but we have TPEX price data — it's a trading day, continue writing TPEX data
  if (!t86HasData && !t86ApiOk && !hasTpexPrices && dateStr8 !== nowDateStr8) {
    console.log(`[market_daily] ${tradeDate} T86 API 異常且無TPEX行情，跳過（保留現有資料）`)
    return 0
  }

  // ── TPEX 三大法人 ──────────────────────────────────────
  try {
    const tpexInst = await fetchUrl(
      `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=${tpexD}&t=D`
    )
    for (const row of tpexInst?.tables?.[0]?.data || []) {
      const no = row[0]?.trim()
      // [4]=外資超, [10]=投信超, [19]=自營合計超
      if (no) instMap[no] = { foreign: n(row[4]), trust: n(row[10]), dealer: n(row[19]) }
    }
    console.log(`[market_daily] ${tradeDate} TPEX法人 ${tpexStockSet.size} 檔`)
  } catch(e) { console.error(`[market_daily] ${tradeDate} TPEX法人失敗:`, e.message) }

  // ── TWSE 融資融券 ──────────────────────────────────────
  const marginMap = {}
  try {
    const twseM = await fetchUrl(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr8}&selectType=STOCK&response=json`
    )
    for (const row of twseM.tables?.[1]?.data || []) {
      const no = row[0]?.trim()
      if (no) marginMap[no] = { margin: n(row[6]), short: n(row[12]) }
    }
    console.log(`[market_daily] ${tradeDate} MARGN ${Object.keys(marginMap).length} 檔`)
  } catch(e) { console.error(`[market_daily] ${tradeDate} MARGN 失敗:`, e.message) }

  // ── TPEX 融資融券 ──────────────────────────────────────
  try {
    const tpexM = await fetchUrl(
      `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${tpexD}`
    )
    for (const row of tpexM?.tables?.[0]?.data || []) {
      const no = row[0]?.trim()
      // TPEX 單位已是張；[6]=資餘額(張), [14]=券餘額(張) → 統一換成股(×1000)
      if (no) marginMap[no] = { margin: n(row[6]) * 1000, short: n(row[14]) * 1000 }
    }
    console.log(`[market_daily] ${tradeDate} TPEX融資 ${tpexStockSet.size} 檔`)
  } catch(e) { console.error(`[market_daily] ${tradeDate} TPEX融資失敗:`, e.message) }

  // ── 寫入 DB ────────────────────────────────────────────
  let saved = 0
  for (let i = 0; i < priceRows.length; i += 100) {
    const batch = priceRows.slice(i, i + 100)
    const vals = [], params = []
    let p = 1
    for (const r of batch) {
      const inst = instMap[r.stockNo]
      const marg = marginMap[r.stockNo]
      vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12})`)
      params.push(
        r.stockNo, tradeDate, r.stockName,
        r.close, r.open, r.high, r.low, r.vol,
        inst ? inst.foreign : null,
        inst ? inst.trust   : null,
        inst ? inst.dealer  : null,
        marg != null ? marg.margin : null,
        marg != null ? marg.short  : null
      )
      p += 13
    }
    await pool.query(`
      INSERT INTO market_daily
        (stock_no,trade_date,stock_name,close,open_p,high,low,volume,inst_foreign,inst_trust,inst_dealer,margin_bal,short_bal)
      VALUES ${vals.join(',')}
      ON CONFLICT (stock_no,trade_date) DO UPDATE SET
        stock_name=EXCLUDED.stock_name,
        close=EXCLUDED.close, open_p=EXCLUDED.open_p, high=EXCLUDED.high, low=EXCLUDED.low, volume=EXCLUDED.volume,
        inst_foreign=COALESCE(EXCLUDED.inst_foreign, market_daily.inst_foreign),
        inst_trust=COALESCE(EXCLUDED.inst_trust,   market_daily.inst_trust),
        inst_dealer=COALESCE(EXCLUDED.inst_dealer,  market_daily.inst_dealer),
        margin_bal=COALESCE(EXCLUDED.margin_bal,   market_daily.margin_bal),
        short_bal=COALESCE(EXCLUDED.short_bal,     market_daily.short_bal)
    `, params)
    saved += batch.length
  }
  console.log(`[market_daily] ${tradeDate} 寫入 ${saved} 筆（TWSE+TPEX）`)
  return saved
}

async function syncMarketDailyToday() {
  const now = new Date(Date.now() + 8 * 3600000)
  const dow = now.getUTCDay()
  if (dow === 0 || dow === 6) return
  const y  = String(now.getUTCFullYear())
  const m  = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d  = String(now.getUTCDate()).padStart(2, '0')
  return syncMarketDailyOne(`${y}${m}${d}`)
}

async function backfillMarketDaily(days = 20) {
  console.log(`[market_daily] 開始回填最近 ${days} 個交易日...`)
  const dates = getPastTradingDays(days)
  for (const dateStr8 of dates) {
    await syncMarketDailyOne(dateStr8)
    await new Promise(r => setTimeout(r, 700))
  }
  console.log('[market_daily] 回填完成')
}

async function backfillOHLCVFromStockDay(days = 30) {
  console.log(`[backfill-ohlcv] 開始修正近 ${days} 天 OHLCV（TWSE+TPEX）...`)

  const { rows: stockRows } = await pool.query(`
    SELECT DISTINCT stock_no FROM market_daily
    WHERE trade_date >= CURRENT_DATE - $1
    ORDER BY stock_no
  `, [days * 2])
  const stockNos = stockRows.map(r => r.stock_no)
  console.log(`[backfill-ohlcv] 共 ${stockNos.length} 支股票`)

  const now = new Date(Date.now() + 8 * 3600000)
  const monthsNeeded = Math.ceil(days / 20) + 1
  // TWSE 月份 (YYYYMM01)
  const twseMonths = []
  // TPEX 月份 (ROC/MM)
  const tpexMonths = []
  for (let m = 0; m < monthsNeeded; m++) {
    const d = new Date(now)
    d.setMonth(d.getMonth() - m)
    const y = d.getUTCFullYear()
    const mo = String(d.getUTCMonth()+1).padStart(2,'0')
    twseMonths.push(`${y}${mo}01`)
    tpexMonths.push(`${y-1911}/${mo}`)
  }

  const n = s => parseFloat(String(s || '0').replace(/,/g, ''))
  let updated = 0, errors = 0

  for (const stockNo of stockNos) {
    let fixed = false

    // 先試 TWSE STOCK_DAY
    for (const dateStr8 of twseMonths) {
      try {
        const data = await fetchUrl(
          `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${stockNo}&date=${dateStr8}&response=json`
        )
        if (data?.stat === 'OK' && data.data?.length) {
          for (const row of data.data) {
            const parts = String(row[0]).split('/')
            if (parts.length !== 3) continue
            const dateKey = `${parseInt(parts[0])+1911}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`
            const close = n(row[6]), open = n(row[3]), high = n(row[4]), low = n(row[5]), vol = Math.round(n(row[1]))
            if (!close || isNaN(close)) continue
            const { rowCount } = await pool.query(
              `UPDATE market_daily SET close=$1, open_p=$2, high=$3, low=$4, volume=$5
               WHERE stock_no=$6 AND trade_date=$7`,
              [close, open, high, low, vol, stockNo, dateKey]
            )
            updated += rowCount
          }
          fixed = true
        }
      } catch(e) { errors++ }
      await new Promise(r => setTimeout(r, 300))
    }

    // TWSE 無資料 → 改試 TPEX st43（上櫃個股月歷史）
    if (!fixed) {
      for (const tpexMo of tpexMonths) {
        try {
          const data = await fetchUrl(
            `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&o=json&d=${tpexMo}&stkno=${stockNo}`
          )
          const rows = data?.tables?.[0]?.data || []
          if (!rows.length) continue
          for (const row of rows) {
            const parts = String(row[0]).split('/')
            if (parts.length !== 3) continue
            const dateKey = `${parseInt(parts[0])+1911}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`
            // TPEX st43: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 成交筆數]
            const close = n(row[6]), open = n(row[3]), high = n(row[4]), low = n(row[5]), vol = Math.round(n(row[1]))
            if (!close || isNaN(close)) continue
            const { rowCount } = await pool.query(
              `UPDATE market_daily SET close=$1, open_p=$2, high=$3, low=$4, volume=$5
               WHERE stock_no=$6 AND trade_date=$7`,
              [close, open, high, low, vol, stockNo, dateKey]
            )
            updated += rowCount
          }
        } catch(e) { errors++ }
        await new Promise(r => setTimeout(r, 300))
      }
    }
  }
  console.log(`[backfill-ohlcv] 完成：更新 ${updated} 筆，錯誤 ${errors} 次`)
  return { updated, errors, stocks: stockNos.length }
}

async function runScreener() {
  console.log('[screener] 開始計算選股...')
  const runDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)

  const { rows: allRows } = await pool.query(`
    SELECT stock_no, stock_name, trade_date, close, open_p, high, low, volume,
           inst_foreign, inst_trust, inst_dealer, margin_bal
    FROM market_daily
    WHERE trade_date >= CURRENT_DATE - 35
    ORDER BY stock_no, trade_date ASC
  `)
  if (!allRows.length) { console.log('[screener] 無市場日線資料'); return }

  const grouped = {}
  for (const r of allRows) {
    if (!grouped[r.stock_no]) grouped[r.stock_no] = []
    grouped[r.stock_no].push(r)
  }

  const candidates = []

  for (const [stockNo, days] of Object.entries(grouped)) {
    if (days.length < 5) continue

    const today = new Date(Date.now() + 8 * 3600000)

    // 最新 price 資料（含今日休市/尚未發佈的 NULL inst 天）
    const latest = days[days.length - 1]
    const latestDate = new Date(latest.trade_date)
    if ((today - latestDate) / (1000*60*60*24) > 4) continue

    const close = parseFloat(latest.close)
    if (!close) continue

    // 找最後一個有 inst_trust 資料的日（跳過尾端 NULL = 休市或未發佈）
    let instEndIdx = days.length - 1
    while (instEndIdx >= 0 && days[instEndIdx].inst_trust === null) instEndIdx--
    if (instEndIdx < 0) continue  // 完全沒有任何 inst 資料

    // inst 最新那天不能超過 7 天前（太舊的資料不可靠）
    const instLatestDate = new Date(days[instEndIdx].trade_date)
    if ((today - instLatestDate) / (1000*60*60*24) > 7) continue

    const last20 = days.slice(-20)
    const last10 = days.slice(-10)
    const last5price = days.slice(-5)   // 用於 price 計算

    // 以 instEndIdx 為基準取 inst 相關的 5 天
    const instLast5 = days.slice(Math.max(0, instEndIdx - 4), instEndIdx + 1)

    const prevClose = days.length >= 2 ? parseFloat(days[days.length-2].close) : close
    const changePct = prevClose > 0 ? (close - prevClose) / prevClose * 100 : 0
    if (Math.abs(changePct) > 7) continue

    const close5dAgo = last5price[0].close ? parseFloat(last5price[0].close) : close
    const chg5d = close5dAgo > 0 ? (close - close5dAgo) / close5dAgo * 100 : 0
    if (chg5d > 5) continue

    const close10dAgo = last10.length >= 2 ? parseFloat(last10[0].close) : close
    const chg10d = close10dAgo > 0 ? (close - close10dAgo) / close10dAgo * 100 : 0
    if (chg10d > 20) continue

    const highs = last20.map(r => parseFloat(r.high)).filter(v => !isNaN(v) && v > 0)
    const lows  = last20.map(r => parseFloat(r.low)).filter(v => !isNaN(v) && v > 0)
    const high20 = highs.length ? Math.max(...highs) : close
    const low20  = lows.length  ? Math.min(...lows)  : close
    const closeRank = high20 > low20 ? (close - low20) / (high20 - low20) : 0.5
    if (closeRank > 0.9) continue

    const vols20 = last20.map(r => parseFloat(r.volume)).filter(v => !isNaN(v) && v > 0)
    const avgVol20 = vols20.length ? vols20.reduce((a,b)=>a+b,0)/vols20.length : 0
    const volRatio = avgVol20 > 0 ? parseFloat(latest.volume) / avgVol20 : 1
    if (volRatio > 3) continue

    // 從 instEndIdx 往前算投信連續買超，同步收集 streak 天資料
    let trustStreak = 0
    const instStreakDays = []
    for (let i = instEndIdx; i >= 0; i--) {
      const trust = days[i].inst_trust != null ? parseFloat(days[i].inst_trust) : null
      if (trust === null || isNaN(trust)) break
      if (trust > 0) { trustStreak++; instStreakDays.unshift(days[i]) }
      else break
    }
    if (trustStreak < 3) continue

    // 主力近 5 日（以 inst 最新5天計算）
    const majorNet5 = instLast5.reduce((s, r) => {
      return s + (parseFloat(r.inst_foreign)||0) + (parseFloat(r.inst_trust)||0)
    }, 0)
    if (majorNet5 <= 0) continue

    // 融資（以 inst 最新5天計算）
    const marginFirst = instLast5[0].margin_bal != null ? parseFloat(instLast5[0].margin_bal) : NaN
    const marginLast  = days[instEndIdx].margin_bal != null ? parseFloat(days[instEndIdx].margin_bal) : NaN
    let marginChg5 = null
    if (!isNaN(marginFirst) && !isNaN(marginLast) && marginFirst > 0) {
      marginChg5 = marginLast - marginFirst
    }
    if (marginChg5 !== null && marginChg5 > 0) continue

    const trustScore  = Math.min(trustStreak / 7, 1) * 30
    let   marginScore = 10
    if (marginChg5 !== null && marginChg5 < 0 && marginFirst > 0) {
      marginScore = Math.min((-marginChg5 / marginFirst) * 100 / 5, 1) * 20
    }
    const posScore = (1 - closeRank) * 10

    const trustNet5   = instLast5.reduce((s,r) => s + (parseFloat(r.inst_trust)||0), 0)
    const foreignNet5 = instLast5.reduce((s,r) => s + (parseFloat(r.inst_foreign)||0), 0)

    // 主力成本估算：以主力淨買超量為權重的加權均價（僅取主力淨買 > 0 的 streak 天）
    let instCost = null, instCostLow = null, instCostHigh = null
    const costDays = instStreakDays.filter(r => {
      const m = (parseFloat(r.inst_trust)||0) + (parseFloat(r.inst_foreign)||0)
      return m > 0 && parseFloat(r.close) > 0
    })
    if (costDays.length > 0) {
      const totalWeight = costDays.reduce((s, r) =>
        s + (parseFloat(r.inst_trust)||0) + (parseFloat(r.inst_foreign)||0), 0)
      if (totalWeight > 0) {
        const weightedSum = costDays.reduce((s, r) => {
          const w = (parseFloat(r.inst_trust)||0) + (parseFloat(r.inst_foreign)||0)
          return s + parseFloat(r.close) * w
        }, 0)
        instCost = Math.round(weightedSum / totalWeight * 100) / 100
      }
      // 買入期間的價格區間（用 low/high 欄位，若無則用 close）
      const lows  = costDays.map(r => parseFloat(r.low  || r.close)).filter(v => v > 0)
      const highs = costDays.map(r => parseFloat(r.high || r.close)).filter(v => v > 0)
      if (lows.length)  instCostLow  = Math.round(Math.min(...lows)  * 100) / 100
      if (highs.length) instCostHigh = Math.round(Math.max(...highs) * 100) / 100
    }

    candidates.push({
      stockNo, stockName: latest.stock_name || stockNo,
      majorNet5, trustStreak, trustNet5, foreignNet5,
      marginChg5: marginChg5 != null ? Math.round(marginChg5) : null,
      marginFirst, instCost, instCostLow, instCostHigh,
      close, changePct, chg5d, chg10d, closeRank, volRatio,
      baseScore: trustScore + marginScore + posScore,
    })
  }

  if (!candidates.length) { console.log('[screener] 無符合條件個股'); return }

  const majorMax = Math.max(...candidates.map(c => c.majorNet5))
  const majorMin = Math.min(...candidates.map(c => c.majorNet5))

  let concStreakMap = {}
  try {
    const { rows: concRows } = await pool.query(`
      SELECT stock_no, data_date, large_pct
      FROM concentration
      WHERE stock_no = ANY($1::text[]) AND data_date >= CURRENT_DATE - 30
      ORDER BY stock_no, data_date ASC
    `, [candidates.map(c => c.stockNo)])
    const cg = {}
    for (const r of concRows) {
      if (!cg[r.stock_no]) cg[r.stock_no] = []
      cg[r.stock_no].push(r)
    }
    for (const [sno, cdays] of Object.entries(cg)) {
      let streak = 0
      for (let i = cdays.length - 1; i >= 1; i--) {
        if (parseFloat(cdays[i].large_pct) > parseFloat(cdays[i-1].large_pct)) streak++
        else break
      }
      concStreakMap[sno] = streak
    }
  } catch {}

  for (const c of candidates) {
    const majorNorm = majorMax > majorMin ? (c.majorNet5 - majorMin) / (majorMax - majorMin) : 0.5
    const concScore = Math.min((concStreakMap[c.stockNo] || 0) / 5, 1) * 15
    c.score = +(c.baseScore + majorNorm * 25 + concScore).toFixed(1)
  }
  candidates.sort((a, b) => b.score - a.score)

  for (const c of candidates) {
    const { trustStreak, chg5d, marginChg5, marginFirst, closeRank } = c
    const marginDeclining  = marginChg5 !== null && marginChg5 < 0
    const marginFastDecline = marginDeclining && marginFirst > 0 && (-marginChg5/marginFirst*100) > 3

    if      (trustStreak >= 5 && Math.abs(chg5d) < 2 && closeRank < 0.45) c.phase = 'A'
    else if (marginFastDecline && chg5d <= 0)                               c.phase = 'B'
    else if (chg5d >= 1.5 && chg5d < 5 && marginDeclining)                 c.phase = 'C'
    else                                                                     c.phase = 'A'

    c.isStealth = trustStreak >= 3 && Math.abs(chg5d) < 1.5 && marginDeclining
  }

  let saved = 0
  for (const c of candidates.slice(0, 100)) {
    try {
      await pool.query(`
        INSERT INTO screener_results
          (run_date,stock_no,stock_name,score,phase,is_stealth,trust_streak,major_net5,margin_chg5,close,change_pct,close_rank,vol_ratio,detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (run_date,stock_no) DO UPDATE SET
          stock_name=$3,score=$4,phase=$5,is_stealth=$6,trust_streak=$7,major_net5=$8,
          margin_chg5=$9,close=$10,change_pct=$11,close_rank=$12,vol_ratio=$13,detail=$14
      `, [
        runDate, c.stockNo, c.stockName, c.score, c.phase, c.isStealth,
        c.trustStreak, Math.round(c.majorNet5), c.marginChg5,
        c.close, +c.changePct.toFixed(2), +c.closeRank.toFixed(4), +c.volRatio.toFixed(2),
        JSON.stringify({ chg5d: +c.chg5d.toFixed(2), chg10d: +c.chg10d.toFixed(2), trustNet5: Math.round(c.trustNet5), foreignNet5: Math.round(c.foreignNet5), instCost: c.instCost, instCostLow: c.instCostLow, instCostHigh: c.instCostHigh }),
      ])
      saved++
    } catch(e) { console.error('[screener] 寫入錯誤:', e.message) }
  }
  console.log(`[screener] 完成：候選 ${candidates.length} 檔，寫入 ${saved} 筆（${runDate}）`)
}

app.get('/api/screener/results', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const { rows: meta } = await pool.query(`SELECT MAX(run_date) AS run_date FROM screener_results`)
    const runDate = meta[0]?.run_date
    if (!runDate) return res.json({ run_date: null, total: 0, rows: [] })
    const { rows } = await pool.query(
      `SELECT * FROM screener_results WHERE run_date=$1 ORDER BY score DESC LIMIT $2`,
      [runDate, limit]
    )
    res.json({ run_date: runDate, total: rows.length, rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/sync/screener', async (req, res) => {
  res.json({ ok: true, message: '選股計算已開始（同步今日行情後計算）' })
  syncMarketDailyToday()
    .then(() => runScreener())
    .catch(e => console.error('[screener] sync+run 失敗:', e.message))
})

app.post('/api/sync/backfill-market', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 20, 250)
  res.json({ ok: true, message: `市場日線回填已開始（${days} 個交易日）` })
  backfillMarketDaily(days)
    .then(() => runScreener())
    .catch(e => console.error('[backfill-market] 失敗:', e.message))
})

app.post('/api/sync/backfill-ohlcv', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 250)
  const estMins = Math.round(days / 20 + 1) * 10
  res.json({ ok: true, message: `OHLCV 修正回填已在背景執行（近 ${days} 天，預估約 ${estMins} 分鐘）` })
  backfillOHLCVFromStockDay(days)
    .then(r => {
      console.log(`[backfill-ohlcv] 回填完成，更新 ${r.updated} 筆`)
      return runScreener()
    })
    .catch(e => console.error('[backfill-ohlcv] 失敗:', e.message))
})

// 一鍵完整回填：先抓法人/融資資料，再修正 OHLCV，最後重算選股
app.post('/api/sync/full-backfill', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 60, 220)
  const estMins = 15 + Math.round(days / 20 + 1) * 10
  res.json({ ok: true, message: `完整回填已在背景執行（近 ${days} 個交易日，預估約 ${estMins} 分鐘）` })
  ;(async () => {
    console.log(`[full-backfill] 開始：${days} 天`)
    await backfillMarketDaily(days)
    console.log('[full-backfill] 法人/融資回填完成，開始修正 OHLCV...')
    const r = await backfillOHLCVFromStockDay(days)
    console.log(`[full-backfill] OHLCV 修正完成 ${r.updated} 筆，重算選股...`)
    await runScreener()
    console.log('[full-backfill] 全部完成')
  })().catch(e => console.error('[full-backfill] 失敗:', e.message))
})

// ── 三大法人歷史查詢 ─────────────────────────────────────
app.get('/api/inst/history', async (req, res) => {
  try {
    const stockNo = (req.query.stockNo || '').trim()
    if (!stockNo) return res.status(400).json({ error: '請輸入股票代號' })
    const days = Math.min(parseInt(req.query.days) || 30, 200)

    // 從 DB 取法人資料（含 close/volume，不加日期下限，讓 LIMIT 決定筆數）
    // 多取一筆以計算最舊那筆的漲跌%
    const { rows } = await pool.query(`
      SELECT trade_date, stock_name, close, volume,
             inst_foreign, inst_trust, inst_dealer, margin_bal, short_bal
      FROM market_daily
      WHERE stock_no = $1
      ORDER BY trade_date DESC
      LIMIT $2
    `, [stockNo, days + 1])

    if (!rows.length) return res.json({ stock_no: stockNo, stock_name: null, rows: [] })

    // 先轉換所有 dateStr
    const dateStrs = rows.map(r => {
      const d = r.trade_date
      return d instanceof Date
        ? d.toISOString().slice(0, 10)
        : String(d).length === 10 ? String(d) : new Date(d).toISOString().slice(0, 10)
    })

    const toLot = v => v != null ? Math.round(+v / 1000) : null
    const result = []
    const displayRows = rows.slice(0, days)
    for (let i = 0; i < displayRows.length; i++) {
      const r        = displayRows[i]
      const dateStr  = dateStrs[i]
      const close    = r.close != null ? +r.close : null
      const prevRow  = rows[i + 1]
      const prevClose = prevRow?.close != null ? +prevRow.close : null
      const changePct = (close != null && prevClose != null)
        ? +((close - prevClose) / prevClose * 100).toFixed(2) : null
      result.push({
        trade_date:   dateStr,
        close:        close,
        change_pct:   changePct,
        volume:       r.volume != null ? Math.round(+r.volume / 1000) : null,
        inst_foreign: toLot(r.inst_foreign),
        inst_trust:   toLot(r.inst_trust),
        inst_dealer:  toLot(r.inst_dealer),
        major_net:    (r.inst_foreign != null && r.inst_trust != null)
                        ? toLot(+r.inst_foreign + +r.inst_trust) : null,
        margin_bal:   r.margin_bal != null ? +r.margin_bal : null,
        short_bal:    r.short_bal  != null ? +r.short_bal  : null,
      })
    }

    // 期間小計（整張）
    const validRows = result.filter(r => r.inst_trust != null)
    const summary = {
      total_foreign: validRows.reduce((s, r) => s + (r.inst_foreign || 0), 0),
      total_trust:   validRows.reduce((s, r) => s + (r.inst_trust  || 0), 0),
      total_dealer:  validRows.reduce((s, r) => s + (r.inst_dealer || 0), 0),
      total_major:   validRows.reduce((s, r) => s + (r.major_net   || 0), 0),
      days_with_data: validRows.length,
    }

    res.json({ stock_no: stockNo, stock_name: rows[0].stock_name, rows: result, summary })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// 排程：週一到週五 15:00 自動執行
cron.schedule('0 15 * * 1-5', () => {
  console.log('[cron] 15:00 自動同步觸發')
  runDailySync()
}, { timezone: 'Asia/Taipei' })

// ── 伺服器端背景監控（不需開瀏覽器）────────────────────
const serverLastNotify = {}  // { stockNo: 'date-hour-signal' }

async function serverCheckOne({ no, name }) {
  try {
    const json = await fetchUrl(
      `https://query1.finance.yahoo.com/v8/finance/chart/${getSymbol(no)}?interval=1m&range=1d`
    )
    const result = json.chart.result?.[0]
    if (!result?.timestamp) return

    const q = result.indicators.quote[0]
    const rows = result.timestamp
      .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
      .filter(r => r.close != null && r.volume > 0)
    if (!rows.length) return

    const avgVol  = rows.reduce((s, r) => s + r.volume, 0) / rows.length
    const dayLow  = Math.min(...rows.map(r => r.low))
    const dayHigh = Math.max(...rows.map(r => r.high))
    const last    = rows[rows.length - 1]
    const prev    = rows[rows.length - 2]
    const volRatio = +(last.volume / avgVol).toFixed(2)
    const nearLow  = (last.low  - dayLow)  / dayLow  < 0.05
    const nearHigh = (dayHigh   - last.high) / dayHigh < 0.05
    const reversal = prev && last.close > prev.close

    const macdResult  = calcMACD(rows.map(r => r.close))
    const macdDiv     = detectDivergence(rows, macdResult)
    const macdTopDiv  = detectTopDivergence(rows, macdResult)
    const macdPayload = macdResult
      ? { line: macdResult.line, sig: macdResult.sig, hist: macdResult.hist, divergence: macdDiv, topDivergence: macdTopDiv }
      : null

    const { signal, message } = classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh })

    const notifySignals = ['entry', 'warning', 'exit', 'exit_warning']
    if (notifySignals.includes(signal)) {
      const cst  = new Date(Date.now() + 8 * 3600000)
      const key  = `${cst.getUTCFullYear()}${cst.getUTCMonth()}${cst.getUTCDate()}-${cst.getUTCHours()}-${signal}`
      if (serverLastNotify[no] !== key) {
        serverLastNotify[no] = key
        const emoji = { entry: '🚨', warning: '⚠️', exit: '🔴', exit_warning: '🟠' }[signal] || '📢'
        const dt = new Date(last.ts * 1000)
        const dataTime = `${String((dt.getUTCHours()+8)%24).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`
        sendTelegram(
          `${emoji} <b>${name} ${no} 訊號</b>\n` +
          `${message}\n\n` +
          `現價：<b>${last.close}</b>\n` +
          `量比：<b>${volRatio}x</b>\n` +
          `日低：${dayLow}　日高：${dayHigh}\n` +
          `資料時間：${dataTime}`
        )
        saveSignal({
          stockNo: no, stockName: name,
          signalTime: new Date(last.ts * 1000),
          signalType: signal,
          price: last.close, volRatio, dayLow, dayHigh, message,
          macd: macdPayload, source: 'realtime',
        })
        console.log(`[monitor] ${name} ${signal} 訊號 → Telegram 已發送`)
      }
    }
  } catch (e) {
    console.error(`[monitor] ${name} 檢查失敗:`, e.message)
  }
}

async function serverMonitorAll() {
  if (!isMarketOpen()) return
  console.log(`[monitor] ${cstNow()} 執行監控...`)
  for (const stock of STOCKS_LIST) {
    await serverCheckOne(stock)
  }
}

// 開盤時間每 30 秒執行一次
setInterval(serverMonitorAll, 30 * 1000)
console.log('[monitor] 伺服器端背景監控已啟動（開盤時每 30 秒自動執行）')

cron.schedule('30 15 * * 1-5', () => {
  console.log('[cron] 15:30 台指期籌碼 + 漲跌家數自動同步')
  syncMarketBreadth()
  syncFuturesChips().catch(() => {
    console.log('[cron] 15:30 台指期籌碼失敗，5 分鐘後重試')
    setTimeout(() => syncFuturesChips(), 5 * 60 * 1000)
  })
}, { timezone: 'Asia/Taipei' })

cron.schedule('35 15 * * 1-5', async () => {
  console.log('[cron] 15:35 強勢族群快照')
  try {
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10).replace(/-/g,'')
    const result = await computeSectorData()
    sectorCache = { date: today, data: result }
    await saveSectorSnapshot(result)
    console.log(`[sector_snapshots] ${today} 快照儲存完成`)
  } catch(e) { console.error('[sector_snapshots] 快照儲存失敗:', e.message) }
}, { timezone: 'Asia/Taipei' })

// 17:00 每日行情摘要（TWSE afterTrading 16:30+ 穩定後補抓三大法人 + 融資）
cron.schedule('0 17 * * 1-5', async () => {
  console.log('[cron] 17:00 每日行情摘要 + 三大法人回填')
  try {
    await syncDailyData()
    await backfillDailyInst()
  } catch(e) { console.error('[cron] 17:00 失敗:', e.message) }
}, { timezone: 'Asia/Taipei' })

// 18:00 集保大戶持股同步
cron.schedule('0 18 * * 1-5', () => {
  console.log('[cron] 18:00 集保大戶持股同步')
  syncConcentration().catch(e => console.error('[cron] 18:00 concentration 失敗:', e.message))
}, { timezone: 'Asia/Taipei' })

// 18:30 全市場日線 + 選股計算
cron.schedule('30 18 * * 1-5', async () => {
  console.log('[cron] 18:30 全市場日線同步 + 選股計算')
  try {
    await syncMarketDailyToday()
    await runScreener()
  } catch(e) { console.error('[cron] 18:30 選股失敗:', e.message) }
}, { timezone: 'Asia/Taipei' })

console.log('[cron] 已設定每日 15:00/17:00/18:00/18:30 自動同步、15:30 台指期籌碼、15:35 強勢族群（週一至週五）')

// ── 富邦 API 端點 ─────────────────────────────────────────
const { spawn } = require('child_process')
const path = require('path')

function runPython(scriptArgs, onData) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', ['-m', ...scriptArgs], {
      cwd: path.join(__dirname),
      env: { ...process.env }
    })
    const out = []
    py.stdout.on('data', d => { out.push(d.toString()); if (onData) onData(d.toString()) })
    py.stderr.on('data', d => console.error('[python]', d.toString().trim()))
    py.on('close', code => code === 0 ? resolve(out.join('')) : reject(new Error(`exit ${code}`)))
  })
}

// 個股即時報價
app.get('/api/fubon/quote', async (req, res) => {
  const symbol = (req.query.symbol || '2330').trim()
  try {
    const output = await runPython(['fubon.marketdata', 'quote', symbol])
    res.json({ ok: true, data: JSON.parse(output) })
  } catch(e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 全市場快照
app.get('/api/fubon/snapshot', async (req, res) => {
  const market = (req.query.market || 'TSE').trim()
  try {
    const output = await runPython(['fubon.marketdata', 'snapshot', market])
    res.json({ ok: true, data: JSON.parse(output) })
  } catch(e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 歷史K線
app.get('/api/fubon/history', async (req, res) => {
  const symbol = (req.query.symbol || '2330').trim()
  const from   = req.query.from || '2026-01-01'
  const to     = req.query.to   || new Date().toISOString().slice(0, 10)
  try {
    const output = await runPython(['fubon.marketdata', 'history', symbol, from, to])
    res.json({ ok: true, data: JSON.parse(output) })
  } catch(e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 漲跌幅排行
app.get('/api/fubon/movers', async (req, res) => {
  const market    = req.query.market    || 'TSE'
  const direction = req.query.direction || 'up'
  try {
    const output = await runPython(['fubon.marketdata', 'movers', market, direction])
    res.json({ ok: true, data: JSON.parse(output) })
  } catch(e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 以 Fubon 歷史K線修正 DB 的 OHLCV
app.post('/api/fubon/backfill-ohlcv', async (req, res) => {
  const days  = Math.min(parseInt(req.query.days) || 200, 200)
  const stock = req.query.stock || ''
  res.json({ ok: true, message: `Fubon OHLCV 修正已開始（${days} 天）` });
  (async () => {
    const args = ['fubon.backfill_ohlcv', String(days)]
    if (stock) args.push(stock)
    try {
      await runPython(args)
      console.log('[fubon] OHLCV 修正完成')
    } catch(e) { console.error('[fubon] OHLCV 修正失敗:', e.message) }
  })()
})

// WebSocket 即時行情 SSE 串流
app.get('/api/fubon/stream', (req, res) => {
  const symbols = (req.query.symbols || '2330').split(',').map(s => s.trim())
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const py = spawn('python3', ['-m', 'fubon.marketdata', 'watch', ...symbols], {
    cwd: path.join(__dirname),
    env: { ...process.env }
  })
  py.stdout.on('data', d => {
    d.toString().trim().split('\n').forEach(line => {
      if (line) res.write(`data: ${line}\n\n`)
    })
  })
  py.stderr.on('data', d => console.error('[fubon-stream]', d.toString().trim()))
  req.on('close', () => py.kill())
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})
