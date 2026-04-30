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

// 統一訊號判斷（進場 + 出貨）
function classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh, periodLow, periodHigh }) {
  const refLow  = periodLow  ?? dayLow
  const refHigh = periodHigh ?? dayHigh

  // 進場偵測（優先）
  if (volRatio >= 3 && nearLow && reversal) {
    return { signal: 'entry', message: `主力疑似進場！接近日低 ${+refLow.toFixed(0)}，量比 ${volRatio}x，出現反彈` + (macdDiv ? ' + MACD底背離' : '') }
  }
  if (macdDiv && nearLow) {
    return { signal: 'warning', message: `MACD底背離 + 接近日低 ${+refLow.toFixed(0)}，留意反彈機會` }
  }
  if (volRatio >= 2 && nearLow) {
    return { signal: 'warning', message: `量能異常 + 接近日低，量比 ${volRatio}x，留意` }
  }

  // 出貨偵測
  if (volRatio >= 3 && nearHigh && !reversal) {
    return { signal: 'exit', message: `主力疑似出貨！接近日高 ${+refHigh.toFixed(0)}，量比 ${volRatio}x，出現下跌` + (macdTopDiv ? ' + MACD頂背離' : '') }
  }
  if (macdTopDiv && nearHigh) {
    return { signal: 'exit_warning', message: `MACD頂背離 + 接近日高 ${+refHigh.toFixed(0)}，留意出貨風險` }
  }
  if (volRatio >= 2 && nearHigh && !reversal) {
    return { signal: 'exit_warning', message: `量能異常 + 接近日高反轉下跌，量比 ${volRatio}x` }
  }

  // 一般量能觀察
  if (volRatio >= 2) {
    return { signal: 'watch', message: `量能偏高，量比 ${volRatio}x` }
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

      const { signal, message } = classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh })

      const payload = { type: 'check', checkTime, dataTime, signal, message,
                        price: last.close, dayHigh, dayLow,
                        volume: last.volume, avgVolume: Math.round(avgVol), volRatio,
                        macd: macdPayload }
      send(payload)

      // Telegram 通知 + DB 寫入（同小時同訊號不重複）
      const notifySignals = ['entry', 'warning', 'exit', 'exit_warning']
      if (notifySignals.includes(signal)) {
        const notifyKey = `${new Date().getUTCHours()}-${signal}`
        if (notifyKey !== lastNotifyKey) {
          lastNotifyKey = notifyKey
          const emoji = { entry: '🚨', warning: '⚠️', exit: '🔴', exit_warning: '🟠' }[signal] || '📢'
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

    const { signal, message } = classifySignal({ volRatio, nearLow, nearHigh, reversal, macdDiv, macdTopDiv, dayLow, dayHigh })

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

console.log('[cron] 已設定每日 15:00 自動存檔、15:30 台指期籌碼 + 漲跌家數同步、15:35 強勢族群快照（週一至週五）')

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})
