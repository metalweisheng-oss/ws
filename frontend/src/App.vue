<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { createChart, CandlestickSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'
import { Chart, BarController, LineController, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Legend, Title } from 'chart.js'
Chart.register(BarController, LineController, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Legend, Title)

const tab = ref('changelog')
const navbarRef   = ref(null)   // 整個頂部區（header + tab bar）的底部 y 值
const navbarBottom = ref(104)   // 預設值，onMounted 後更新
const API = import.meta.env.VITE_API_BASE || ''

// ── 即時監控 ──────────────────────────────────────
const STOCKS = [
  { no: '2059', name: '川湖科技' },
  { no: '3293', name: '鈊象'     },
  { no: '3008', name: '大立光'   },
  { no: '9105', name: '泰金寶'   },
  { no: '6274', name: '台燿'     },
  { no: '3017', name: '奇鋐'     },
  { no: '3037', name: '欣興'     },
  { no: '8046', name: '南電'     },
]

const SIGNAL_META = {
  entry:        { label: '一級：主力抄底', cls: 'bg-red-500',    text: 'text-red-400',    border: 'border-red-700'    },
  warning:      { label: '二級：趨勢轉折', cls: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-700' },
  watch:        { label: '三級：量能警戒', cls: 'bg-yellow-500', text: 'text-yellow-400', border: 'border-yellow-700' },
  exit_warning: { label: '四級：異動提醒', cls: 'bg-teal-500',   text: 'text-teal-400',   border: 'border-teal-700'   },
  normal:       { label: '正常',           cls: 'bg-gray-500',   text: 'text-gray-400',   border: 'border-gray-700'   },
  closed:       { label: '休市',           cls: 'bg-gray-700',   text: 'text-gray-500',   border: 'border-gray-800'   },
  no_data:      { label: '無資料',         cls: 'bg-gray-700',   text: 'text-gray-500',   border: 'border-gray-800'   },
  error:        { label: '錯誤',           cls: 'bg-gray-700',   text: 'text-red-500',    border: 'border-gray-800'   },
}

// 每檔股票各自的狀態
const stocks = reactive(
  Object.fromEntries(STOCKS.map(s => [s.no, { latest: null, logs: [], ticks: [], connected: false, sse: null }]))
)
const selectedTickStock = ref('')

function startOne(stockNo) {
  const st = stocks[stockNo]
  if (st.sse) st.sse.close()
  st.sse = new EventSource(`${API}/api/stock/monitor/stream?stockNo=${stockNo}`)
  st.connected = true
  st.sse.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.type === 'tick') {
      // 初始歷史批次：整批加到尾端（不 unshift，保持時序）
      if (data.init) {
        st.ticks.push(data)
        if (st.ticks.length > 300) st.ticks.shift()
      } else {
        st.ticks.unshift(data)
        if (st.ticks.length > 300) st.ticks.pop()
      }
      return
    }
    st.latest = data
    st.logs.unshift({ ...data, id: Date.now() })
    if (st.logs.length > 30) st.logs.pop()
  }
  st.sse.onerror = () => { st.connected = false }
  st.sse.onopen  = () => { st.connected = true }
}

function stopOne(stockNo) {
  const st = stocks[stockNo]
  if (st.sse) { st.sse.close(); st.sse = null }
  st.connected = false
}

function startAll()  { STOCKS.forEach(s => startOne(s.no)) }
function stopAll()   { STOCKS.forEach(s => stopOne(s.no)) }

const telegramStatus = ref('')
async function testTelegram() {
  telegramStatus.value = '發送中...'
  try {
    const r = await fetch(`${API}/api/test/telegram`, { method: 'POST' })
    const d = await r.json()
    telegramStatus.value = d.ok ? '✅ 已發送！請查看 Telegram' : '❌ 發送失敗'
  } catch(e) {
    telegramStatus.value = '❌ 網路錯誤：' + e.message
  }
  setTimeout(() => telegramStatus.value = '', 5000)
}
const anyConnected = () => STOCKS.some(s => stocks[s.no].connected)

function simulateChuanhu() {
  const st = stocks['2059']
  const now = new Date()
  const baseMin = (now.getUTCHours() + 8) * 60 + now.getUTCMinutes()
  const hms = (offsetSec = 0) => {
    const total = baseMin * 60 + now.getUTCSeconds() + offsetSec
    return `${String(Math.floor(total/3600)%24).padStart(2,'0')}:${String(Math.floor(total/60)%60).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`
  }
  const fake = {
    signal: 'entry',
    message: '量比3.5x ＋ 接近日低 ＋ 長下影線（模擬測試）',
    price: 2460,
    dayHigh: 2510,
    dayLow: 2420,
    volRatio: 3.5,
    checkTime: hms(),
    macd: { line: -4.8, sig: -2.9, hist: -1.9, divergence: false },
  }
  st.latest = fake
  st.logs.unshift({ ...fake, id: Date.now() })
  if (st.logs.length > 30) st.logs.pop()

  // 注入假分時資料（10筆，模擬放量下殺後反彈）
  const fakeTicks = [
    { type:'tick', time: hms(-90), price: 2500, volume: 8,  side: 'sell' },
    { type:'tick', time: hms(-75), price: 2492, volume: 12, side: 'sell' },
    { type:'tick', time: hms(-60), price: 2485, volume: 25, side: 'sell' },
    { type:'tick', time: hms(-50), price: 2470, volume: 43, side: 'sell' },
    { type:'tick', time: hms(-40), price: 2455, volume: 68, side: 'sell' },
    { type:'tick', time: hms(-30), price: 2422, volume: 95, side: 'sell' },
    { type:'tick', time: hms(-20), price: 2428, volume: 55, side: 'buy'  },
    { type:'tick', time: hms(-12), price: 2440, volume: 38, side: 'buy'  },
    { type:'tick', time: hms(-5),  price: 2452, volume: 29, side: 'buy'  },
    { type:'tick', time: hms(0),   price: 2460, volume: 22, side: 'buy'  },
  ]
  st.ticks = fakeTicks.reverse()  // 最新在前
  selectedTickStock.value = '2059'
}

// ── 歷史資料（DB 查詢）────────────────────────────
const dbTab       = ref('signals')   // 'signals' | 'daily' | 'intraday'
const dbStockNo   = ref('')
const dbLoading   = ref(false)
const signalRows  = ref([])
const dailyRows   = ref([])

// 分時明細
const intradayRows    = ref([])
const intradayDates   = ref([])
const intradayDate    = ref('')
const intradaySignals = ref([])

async function loadSignals() {
  dbLoading.value = true
  try {
    const qs = dbStockNo.value ? `?stockNo=${dbStockNo.value}&days=180` : '?days=180'
    const r  = await fetch(`${API}/api/signals${qs}`)
    const d  = await r.json()
    signalRows.value = d.rows || []
  } finally { dbLoading.value = false }
}

async function loadDaily() {
  dbLoading.value = true
  try {
    const qs = dbStockNo.value ? `?stockNo=${dbStockNo.value}&days=60` : '?days=60'
    const r  = await fetch(`${API}/api/daily-summary${qs}`)
    const d  = await r.json()
    dailyRows.value = d.rows || []
  } finally { dbLoading.value = false }
}

async function loadIntradayDates() {
  if (!dbStockNo.value) return
  const r = await fetch(`${API}/api/intraday/dates?stockNo=${dbStockNo.value}`)
  const d = await r.json()
  intradayDates.value = d.dates || []
  if (intradayDates.value.length) {
    intradayDate.value = intradayDates.value[0]
    await loadIntraday()
  }
}

async function loadIntraday() {
  if (!dbStockNo.value || !intradayDate.value) return
  dbLoading.value = true
  try {
    const [rd, rs] = await Promise.all([
      fetch(`${API}/api/intraday?stockNo=${dbStockNo.value}&date=${intradayDate.value}`).then(r => r.json()),
      fetch(`${API}/api/signals?stockNo=${dbStockNo.value}&date=${intradayDate.value}`).then(r => r.json()),
    ])
    intradayRows.value    = rd.rows || []
    intradaySignals.value = rs.rows || []
  } finally { dbLoading.value = false }
}

// bar_time (UTC) → 'HH:MM' CST，用來對應訊號
function barTimeKey(barTime) {
  const d = new Date(barTime)
  const h = String((d.getUTCHours() + 8) % 24).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// 依時間分鐘建立訊號 Map（一根 K 棒可能有多個訊號，取第一個）
const intradaySignalMap = computed(() => {
  const map = {}
  for (const s of intradaySignals.value) {
    const key = barTimeKey(s.signal_time)
    if (!map[key]) map[key] = s
  }
  return map
})

// 累計成交量（張）：r.volume 為字串需先轉 Number，累加 shares 後才 floor÷1000
const intradayCumVol = computed(() => {
  let accShares = 0
  return intradayRows.value.map(r => {
    accShares += Number(r.volume) || 0
    return Math.floor(accShares / 1000)
  })
})

function onDbTabChange(t) {
  dbTab.value = t
  if (t === 'signals') loadSignals()
  else if (t === 'daily') loadDaily()
  else if (t === 'intraday') {
    if (!dbStockNo.value) dbStockNo.value = '2059'
    loadIntradayDates()
  }
}

function onDbStockChange() {
  if (dbTab.value === 'signals') loadSignals()
  else if (dbTab.value === 'daily') loadDaily()
  else if (dbTab.value === 'intraday') loadIntradayDates()
}

const signalBadge = { entry: 'bg-red-500', warning: 'bg-orange-500', watch: 'bg-yellow-500', exit_warning: 'bg-teal-500' }
const signalLabel = { entry: '一級：主力抄底', warning: '二級：趨勢轉折', watch: '三級：量能警戒', exit_warning: '四級：異動提醒' }
const sourceLabel = { realtime: '即時', backtest: '回測', monthly: '月回測', daily_full: '日線全量', intraday_full: '分時全量' }

// ── K線圖 ────────────────────────────────────────
const chartStockNo  = ref('2059')
const chartDays     = ref(3)
const chartLoading  = ref(false)
const chartError    = ref('')
const chartContainer = ref(null)
let lwChart = null

async function loadChartData() {
  chartLoading.value = true
  chartError.value   = ''
  try {
    const r = await fetch(`${API}/api/intraday/chart?stockNo=${chartStockNo.value}&days=${chartDays.value}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    await nextTick()
    renderChart(d)
  } catch (e) {
    chartError.value = e.message
  } finally {
    chartLoading.value = false
  }
}

function renderChart({ bars, signals }) {
  if (!chartContainer.value) return
  if (lwChart) { lwChart.remove(); lwChart = null }

  lwChart = createChart(chartContainer.value, {
    width:  chartContainer.value.clientWidth,
    height: 500,
    layout: { background: { color: '#111827' }, textColor: '#9ca3af', fontSize: 12 },
    grid:   { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: '#374151', scaleMargins: { top: 0.05, bottom: 0.28 } },
    timeScale: {
      borderColor: '#374151',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time, type) => {
        const d = new Date((time + 8 * 3600) * 1000)
        if (type === 2) return `${d.getUTCMonth()+1}/${d.getUTCDate()}`
        if (type >= 3)  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
        return String(d.getUTCFullYear())
      },
    },
    localization: {
      timeFormatter: (time) => {
        const d = new Date((time + 8 * 3600) * 1000)
        return `${d.getUTCMonth()+1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
      },
    },
  })

  // 台股顏色：紅漲綠跌
  const candleSeries = lwChart.addSeries(CandlestickSeries, {
    upColor: '#ef4444', downColor: '#22c55e',
    borderUpColor: '#ef4444', borderDownColor: '#22c55e',
    wickUpColor:   '#ef4444', wickDownColor:   '#22c55e',
  })
  candleSeries.setData(bars.map(b => ({
    time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
  })))

  // 成交量（下方 22%）
  const volSeries = lwChart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  })
  lwChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } })
  volSeries.setData(bars.map(b => ({
    time: b.time,
    value: Math.floor(b.volume / 1000),
    color: b.close >= b.open ? 'rgba(239,68,68,0.55)' : 'rgba(34,197,94,0.55)',
  })))

  // 訊號標記
  const mDef = {
    entry:        { position: 'belowBar', shape: 'arrowUp',   color: '#ef4444', text: '一級' },
    warning:      { position: 'belowBar', shape: 'circle',    color: '#f97316', text: '二級' },
    watch:        { position: 'belowBar', shape: 'circle',    color: '#eab308', text: '三級' },
    exit_warning: { position: 'aboveBar', shape: 'circle',    color: '#14b8a6', text: '四級' },
  }
  const markers = signals
    .filter(s => mDef[s.type])
    .map(s => ({ time: s.time, size: 1, ...mDef[s.type] }))
    .sort((a, b) => a.time - b.time)
  if (markers.length) createSeriesMarkers(candleSeries, markers)

  lwChart.timeScale().fitContent()

  // 響應式寬度
  const ro = new ResizeObserver(() => {
    if (lwChart && chartContainer.value)
      lwChart.applyOptions({ width: chartContainer.value.clientWidth })
  })
  ro.observe(chartContainer.value)
}

function selectTab(t) {
  tab.value = t
  if (t === 'db')      loadSignals()
  if (t === 'chart')   nextTick(() => loadChartData())
  if (t === 'breadth') { loadMarketBreadth(); loadMarketDist() }
  if (t === 'sector')   { loadSectorDates(); loadSectorAnalysis() }

  if (t === 'screener') loadScreener()
  if (t === 'strongweak') window.scrollTo(0, 0)
  if (t === 'warrant') { warrantRows.value = []; warrantError.value = ''; warrantStockName.value = '' }
  if (t === 'movers') startMoversAutoRefresh()
  else stopMoversAutoRefresh()
  if (t === 'buyback') fetchBuyback()
  if (t === 'disposal') fetchDisposal()
  if (t !== 'finance') destroyFinCharts()
}

// ── 權證查詢 ──────────────────────────────────────────
const warrantStockNo   = ref('2059')
const warrantStockCode = ref('')
const warrantType      = ref('all')
const warrantLoading   = ref(false)
const warrantError     = ref('')
const warrantRows      = ref([])
const warrantStockName = ref('')
const warrantSortCol   = ref('volume')
const warrantSortDesc  = ref(true)

async function searchWarrant() {
  if (!warrantStockNo.value.trim()) return
  warrantLoading.value = true
  warrantError.value   = ''
  warrantRows.value    = []
  warrantStockName.value = ''
  warrantStockCode.value = ''
  try {
    const r = await fetch(`${API}/api/warrant/search?stockNo=${encodeURIComponent(warrantStockNo.value.trim())}&type=${warrantType.value}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    if (!d.rows.length) throw new Error(`查無「${warrantStockNo.value}」的有效權證，請確認代號或名稱`)
    warrantRows.value      = d.rows
    warrantStockName.value = d.stockName || warrantStockNo.value
    warrantStockCode.value = d.stockCode || ''
    warrantAskMap.value    = {}
    fetchWarrantAsks()
  } catch(e) {
    warrantError.value = e.message
  } finally {
    warrantLoading.value = false
  }
}

const warrantSorted = computed(() => {
  const col = warrantSortCol.value
  return [...warrantRows.value].sort((a, b) => {
    const av = a[col] ?? (warrantSortDesc.value ? -Infinity : Infinity)
    const bv = b[col] ?? (warrantSortDesc.value ? -Infinity : Infinity)
    return warrantSortDesc.value ? bv - av : av - bv
  })
})

function warrantSort(col) {
  if (warrantSortCol.value === col) { warrantSortDesc.value = !warrantSortDesc.value }
  else { warrantSortCol.value = col; warrantSortDesc.value = true }
}

const warrantCallCount    = computed(() => warrantRows.value.filter(r => r.type === 'call').length)
const warrantPutCount     = computed(() => warrantRows.value.filter(r => r.type === 'put').length)
const wFilterDays         = ref(90)
const wFilterPremiumMax   = ref(10)
const wFilterPremiumMin   = ref(-5)
const wFilterVolume       = ref(50)
const wFilterCirculation  = ref(100)
const wQSortCol  = ref('volume')
const wQSortDesc = ref(true)
const warrantQualified = computed(() => {
  const col = wQSortCol.value
  return warrantRows.value.filter(r =>
    r.daysLeft != null && r.daysLeft > wFilterDays.value &&
    r.premiumPct != null && r.premiumPct > wFilterPremiumMin.value && r.premiumPct < wFilterPremiumMax.value &&
    r.volume != null && r.volume > wFilterVolume.value &&
    (r.circulationPct == null || r.circulationPct <= wFilterCirculation.value)
  ).sort((a, b) => {
    const av = a[col] ?? (wQSortDesc.value ? -Infinity : Infinity)
    const bv = b[col] ?? (wQSortDesc.value ? -Infinity : Infinity)
    return wQSortDesc.value ? bv - av : av - bv
  })
})
function wQSort(col) {
  if (wQSortCol.value === col) { wQSortDesc.value = !wQSortDesc.value }
  else { wQSortCol.value = col; wQSortDesc.value = true }
}
function wQSortIcon(col) { return wQSortCol.value === col ? (wQSortDesc.value ? ' ▼' : ' ▲') : '' }

const validateResult  = ref(null)
const validateLoading = ref(false)
const validateError   = ref('')
async function runValidate() {
  const code = warrantStockCode.value || warrantStockNo.value
  if (!code) return
  validateLoading.value = true
  validateError.value   = ''
  validateResult.value  = null
  try {
    const r = await fetch(`${API}/api/warrant/validate?stockNo=${encodeURIComponent(code)}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    validateResult.value = d
  } catch(e) {
    validateError.value = e.message
  } finally {
    validateLoading.value = false
  }
}

const squeezeTestLoading = ref(false)
const squeezeTestResult  = ref(null)
async function sendSqueezeTest() {
  squeezeTestLoading.value = true
  squeezeTestResult.value  = null
  try {
    const r = await fetch(`${API}/api/test/squeeze-telegram`, { method: 'POST' })
    squeezeTestResult.value = await r.json()
  } catch(e) {
    squeezeTestResult.value = { ok: false, message: e.message }
  } finally {
    squeezeTestLoading.value = false
  }
}

const warrantAskMap   = ref({})
const askLoading      = ref(false)
const askLastUpdated  = ref(null)
let   _askTimer       = null

async function fetchWarrantAsks() {
  const nos = warrantRows.value.map(r => r.warrantNo)
  if (!nos.length) return
  askLoading.value = true
  try {
    const r = await fetch(`${API}/api/warrant/batch-asks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warrantNos: nos })
    })
    const d = await r.json()
    if (d.ok) {
      warrantAskMap.value  = { ...warrantAskMap.value, ...d.data }
      askLastUpdated.value = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
  } catch(e) {}
  finally { askLoading.value = false }
}

watch(warrantRows, (rows) => {
  if (_askTimer) { clearInterval(_askTimer); _askTimer = null }
  if (rows.length) _askTimer = setInterval(fetchWarrantAsks, 30000)
}, { immediate: false })

function wChangePctColor(v) { return v == null ? 'text-gray-500' : +v > 0 ? 'text-red-400' : +v < 0 ? 'text-green-400' : 'text-gray-400' }

// ── 情境分析 Black-Scholes ────────────────────────────────
const scenarioVisible = ref(false)
const scenarioWarrant = ref(null)

function normCDF(x) {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]
  const p = 0.3275911, sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + p * x)
  const poly = ((((a[4]*t + a[3])*t + a[2])*t + a[1])*t + a[0]) * t
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)))
}
function bsWarrantPrice(S, K, T, r, sigma, ratio, isCall, q = 0) {
  if (!S || !K || !T || T <= 0 || !sigma || sigma <= 0 || !ratio) return null
  const Sq = S * Math.exp(-q * T)  // Merton 股息調整
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(Sq / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const optPrice = isCall
    ? Sq * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
    : K * Math.exp(-r * T) * normCDF(-d2) - Sq * normCDF(-d1)
  return optPrice * ratio
}
function openScenario(row) {
  scenarioWarrant.value = row
  scenarioVisible.value = true
}
const scenarioRows = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
const scenarioIVOffsets = [-2, -1, 0, 1, 2]
const scenarioTable = computed(() => {
  const w = scenarioWarrant.value
  if (!w || !w.iv || !w.strike || !w.ratio || !w.daysLeft) return null
  const S0    = w.stockPrice || 0
  const K     = w.strike
  const T     = w.daysLeft / 365
  const r     = 0.015
  const q     = w.dividendYield ? w.dividendYield / 100 : 0
  const ratio = w.ratio
  const isCall = w.type === 'call'
  const ivCols = scenarioIVOffsets.map(d => +(w.iv + d).toFixed(1))
  const currentIVIdx = scenarioIVOffsets.indexOf(0)  // index 2
  const rows = scenarioRows.map(pct => {
    const S = +(S0 * (1 + pct / 100)).toFixed(2)
    const prices = ivCols.map(iv => {
      const p = bsWarrantPrice(S, K, T, r, iv / 100, ratio, isCall, q)
      return p != null ? +p.toFixed(2) : null
    })
    return { pct, S, prices }
  })
  return { ivCols, rows, S0, currentIVIdx }
})
function wSortIcon(col) { return warrantSortCol.value === col ? (warrantSortDesc.value ? ' ▼' : ' ▲') : '' }

// ── 雙模選股 ───────────────────────────────────────────
const swData    = ref(null)
const swLoading = ref(false)
const swError   = ref('')
const swMode    = ref('momentum')   // 'momentum' | 'value'

async function fetchStrongWeak() {
  swLoading.value = true
  swError.value   = ''
  try {
    const r = await fetch(`${API}/api/strong-weak-stocks`)
    const d = await r.json()
    if (d.error) throw new Error(d.code === 'NOT_CONFIGURED' ? 'StockAI 模組尚未上線' : d.error)
    swData.value = d
    // 根據市場狀態預設分頁
    const state = d.regime?.state
    swMode.value = state === 'bear' ? 'value' : 'momentum'
  } catch(e) { swError.value = e.message }
  finally { swLoading.value = false }
}

function swStateLabel(s) {
  return { bull: '牛市 · 動能模式', sideways: '震盪 · 均衡模式', bear: '熊市 · 價值模式' }[s] ?? '—'
}
function swStateBg(s) {
  return { bull: 'bg-green-900/40 text-green-400 border-green-700', sideways: 'bg-yellow-900/40 text-yellow-400 border-yellow-700', bear: 'bg-red-900/40 text-red-400 border-red-700' }[s] ?? ''
}
function swScoreColor(v) {
  if (v >= 70) return 'text-green-400'
  if (v >= 45) return 'text-yellow-400'
  return 'text-red-400'
}
function swScoreBg(v) {
  if (v >= 70) return 'bg-green-500'
  if (v >= 45) return 'bg-yellow-500'
  return 'bg-red-500'
}
function valScoreColor(v) {
  if (v >= 70) return 'text-blue-400'
  if (v >= 45) return 'text-sky-400'
  return 'text-gray-500'
}
function valScoreBg(v) {
  if (v >= 70) return 'bg-blue-500'
  if (v >= 45) return 'bg-sky-600'
  return 'bg-gray-600'
}

// ── 漲跌排行 ─────────────────────────────────────────
const moversGainers   = ref([])
const moversLosers    = ref([])
const moversTotal     = ref(0)
const moversLoading   = ref(false)
const moversError     = ref('')
const moversUpdatedAt = ref('')
const moversDate      = ref('')        // '' = 今日即時，'YYYY-MM-DD' = 歷史
const moversDates     = ref([])        // 可選日期清單
const warrantCoveredSet = ref(new Set())

async function fetchWarrantCoverage() {
  try {
    const r = await fetch(`${API}/api/warrant/covered-stocks`)
    const d = await r.json()
    if (d.ok) warrantCoveredSet.value = new Set(d.stocks)
  } catch(e) {}
}
const moversRealtime  = ref(true)
let   moversTimer     = null

// 漲停觀察名單快照（每30分）
const limitSnapshotTime  = ref('')   // '' = 即時，'09:30' = 歷史快照
const limitSnapshotMap   = ref({})   // { '09:30': [...gainers] }
const limitSnapshotTimes = ref([])   // 可選時段列表

async function fetchLimitSnapshots() {
  try {
    const qs = moversDate.value ? `?date=${moversDate.value}` : ''
    const r = await fetch(`${API}/api/market/limit-snapshots${qs}`)
    const d = await r.json()
    const map = {}
    const times = []
    for (const s of d.snapshots || []) { map[s.time] = s.gainers; times.push(s.time) }
    limitSnapshotMap.value = map
    limitSnapshotTimes.value = times
    // 若目前選的時段已不存在，重設為即時
    if (limitSnapshotTime.value && !map[limitSnapshotTime.value]) limitSnapshotTime.value = ''
  } catch(e) {}
}

// 五檔報價 Modal
const quoteVisible  = ref(false)
const quoteData     = ref(null)
const quoteLoading  = ref(false)
const quoteTicks    = ref([])
const quoteTab      = ref('quote') // 'quote' | 'ticks'
let   quoteTimer    = null
let   quoteStockNo  = ''

async function fetchMoversDates() {
  try {
    const r = await fetch(`${API}/api/market/movers/dates`)
    const d = await r.json()
    moversDates.value = d.dates || []
  } catch(e) {}
}

const moversMisEmpty = ref(false)

async function fetchMovers() {
  moversLoading.value = true
  moversError.value   = ''
  try {
    const qs = moversDate.value ? `?date=${moversDate.value}&limit=200` : '?limit=200'
    const r = await fetch(`${API}/api/market/movers${qs}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    moversGainers.value   = d.gainers || []
    moversLosers.value    = d.losers  || []
    moversTotal.value     = d.total   || 0
    moversRealtime.value  = d.realtime ?? true
    moversMisEmpty.value  = !!d.misEmpty
    moversUpdatedAt.value = d.updatedAt
      ? new Date(d.updatedAt).toLocaleTimeString('zh-TW')
      : (d.date || '')
    if (!warrantCoveredSet.value.size) fetchWarrantCoverage()
  } catch(e) {
    moversError.value = e.message
  } finally {
    moversLoading.value = false
  }
}

function onMoversDateChange() {
  clearTimeout(moversTimer)
  moversTimer = null
  limitSnapshotTime.value = ''
  fetchMovers()
  fetchLimitSnapshots()
  if (!moversDate.value) {
    scheduleNextMovers()
  }
}

function twNowMinutes() {
  const now = new Date(Date.now() + 8 * 3600000)
  return now.getUTCHours() * 60 + now.getUTCMinutes()
}
function isMarketHours() {
  const m = twNowMinutes()
  return m >= 9 * 60 && m < 13 * 60 + 30
}
function isNearOpen() {
  const m = twNowMinutes()
  return m >= 8 * 60 + 50 && m < 9 * 60 + 20
}

function getMoversInterval() {
  if (isNearOpen()) return 10000
  if (isMarketHours()) return 15000
  return 120000
}

function scheduleNextMovers() {
  moversTimer = setTimeout(() => {
    fetchMovers()
    scheduleNextMovers()
  }, getMoversInterval())
}

function startMoversAutoRefresh() {
  clearTimeout(moversTimer)
  moversTimer = null
  fetchMoversDates()
  fetchMovers()
  fetchLimitSnapshots()
  scheduleNextMovers()
}
function stopMoversAutoRefresh() {
  clearTimeout(moversTimer)
  moversTimer = null
}

function volRatio1dClass(r) {
  if (!r.prevVol) return 'text-gray-600'
  const ratio = r.volume / r.prevVol
  if (ratio < 0.5) return 'text-purple-400 font-bold'
  if (ratio < 0.7) return 'text-red-400 font-bold'
  if (ratio >= 2)  return 'text-yellow-400 font-bold'
  return 'text-gray-400'
}
function volRatio5dClass(r) {
  if (!r.volMa5) return 'text-gray-600'
  const ratio = r.volume / r.volMa5
  if (ratio < 0.5) return 'text-orange-400 font-bold'
  if (ratio >= 2)  return 'text-yellow-400 font-bold'
  return 'text-gray-400'
}
function fmtPrice(p) {
  if (p == null) return '-'
  if (p >= 1000) return p.toFixed(0)
  if (p >= 100)  return p.toFixed(1)
  return p.toFixed(2)
}

function isLongRedHighVol(r) {
  // 排除前日下跌（收 < 開），平盤視為通過；open_p 為 null 時跳過
  if (r.prevOpen && r.prevClose && r.prevClose < r.prevOpen) return false
  return true
}

// 防偽條件：①最低成交量 50張 ②外盤 > 內盤（無資料或兩者皆0視為通過）
function passAntiSpoof(r) {
  if (r.volume < 50) return false
  if (r.innerVol != null && r.outerVol != null && r.innerVol > 0 && r.outerVol <= r.innerVol) return false
  return true
}
// 以5日均量為基準；無5日均量時退用前一日量
function volRef5d(r) { return r.volMa5 || r.prevVol || null }

// 假掛單三重過濾（僅在有快照資料時生效，歷史資料無資料自動跳過）
// ① 至少出現 2 次快照（排除一閃而過的假掛）
// ② 平均委買 / 最大委買 ≥ 0.25（穩定性，排除先拉大再撤的假掛）
// ③ 收盤前有委買 OR 漲停收盤（排除盤中撤單）
function passAntiFake(r) {
  if (!r.limitBidVol) return true
  if (r.bidSnapshotCount != null && r.bidSnapshotCount > 0) {
    if (r.bidSnapshotCount < 2) return false
    if (r.bidVolSum != null) {
      const stability = (r.bidVolSum / r.bidSnapshotCount) / r.limitBidVol
      if (stability < 0.25) return false
    }
  }
  if (r.closeLimitBidVol != null && !r.closedLimitUp && r.closeLimitBidVol === 0) return false
  return true
}

// 可信度等級 (用於顯示)
function bidCredibility(r) {
  if (!r.limitBidVol) return null
  if (r.bidSnapshotCount == null || r.bidSnapshotCount === 0) return 'unknown'
  const stability = r.bidVolSum ? (r.bidVolSum / r.bidSnapshotCount) / r.limitBidVol : 0
  const closeOk = r.closedLimitUp || (r.closeLimitBidVol != null && r.closeLimitBidVol > 0)
  if (r.bidSnapshotCount >= 3 && stability >= 0.5 && closeOk) return 'high'
  if (r.bidSnapshotCount >= 2 && stability >= 0.25) return 'medium'
  return 'low'
}

function bidRatioClass(r) {
  if (!r.limitBidVol || !r.volume) return 'text-gray-600'
  const ratio = r.limitBidVol / r.volume
  if (ratio > 1.6) return 'text-green-400 font-bold'
  if (ratio > 1)   return 'text-cyan-400'
  return 'text-gray-400'
}

const watchBaseGainers = computed(() =>
  (limitSnapshotTime.value && limitSnapshotMap.value[limitSnapshotTime.value])
    ? limitSnapshotMap.value[limitSnapshotTime.value]
    : moversGainers.value
)

const limitSqueezeList1 = computed(() => {
  return watchBaseGainers.value.filter(r => {
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    const ref = volRef5d(r)
    if (!ref || r.volume / ref >= 0.5) return false
    if (r.limitBidVol) return r.limitBidVol / r.volume > 1.7
    return r.closedLimitUp || false
  })
})
const limitSqueezeList2 = computed(() => {
  const tier1 = new Set(limitSqueezeList1.value.map(r => r.stockNo))
  return watchBaseGainers.value.filter(r => {
    if (tier1.has(r.stockNo)) return false
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    const ref = volRef5d(r)
    if (!ref || r.volume / ref >= 0.7) return false
    if (r.limitBidVol) return r.limitBidVol / r.volume > 1.5
    return r.closedLimitUp || false
  })
})
const limitSqueezeList3 = computed(() => {
  const tier12 = new Set([
    ...limitSqueezeList1.value.map(r => r.stockNo),
    ...limitSqueezeList2.value.map(r => r.stockNo),
  ])
  return watchBaseGainers.value.filter(r => {
    if (tier12.has(r.stockNo)) return false
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    const ref = volRef5d(r)
    if (!ref || r.volume / ref >= 0.7) return false
    return true
  })
})

const limitSqueezeSet = computed(() => new Set([
  ...limitSqueezeList1.value.map(r => r.stockNo),
  ...limitSqueezeList2.value.map(r => r.stockNo),
  ...limitSqueezeList3.value.map(r => r.stockNo),
]))

const volIncreaseSet = computed(() => new Set([
  ...volIncreaseLimitList1.value.map(r => r.stockNo),
  ...volIncreaseLimitList2.value.map(r => r.stockNo),
  ...volIncreaseLimitList3.value.map(r => r.stockNo),
]))

function rowBgClass(r) {
  if (volIncreaseSet.value.has(r.stockNo))
    return 'bg-red-900/25 hover:bg-red-900/35'
  if (limitSqueezeSet.value.has(r.stockNo))
    return 'bg-blue-900/25 hover:bg-blue-900/35'
  return 'hover:bg-gray-800/30'
}

const volIncreaseLimitList1 = computed(() => {
  return watchBaseGainers.value.filter(r => {
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    if (!r.limitBidVol) return false
    const ref = volRef5d(r)
    if (!ref) return false
    const ratio = r.volume / ref
    if (ratio < 1.5 || ratio >= 5) return false
    // 僅限首板（limitDays 未設）或二板（limitDays=1）
    if (r.limitDays != null && r.limitDays > 1) return false
    return r.limitBidVol / r.volume > 2
  })
})
const volIncreaseLimitList2 = computed(() => {
  const tier1 = new Set(volIncreaseLimitList1.value.map(r => r.stockNo))
  return watchBaseGainers.value.filter(r => {
    if (tier1.has(r.stockNo)) return false
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    if (!r.limitBidVol) return false
    const ref = volRef5d(r)
    if (!ref) return false
    const ratio = r.volume / ref
    if (ratio < 1.5 || ratio >= 5) return false
    return r.limitBidVol / r.volume > 1.5
  })
})
const volIncreaseLimitList3 = computed(() => {
  const tier12 = new Set([
    ...volIncreaseLimitList1.value.map(r => r.stockNo),
    ...volIncreaseLimitList2.value.map(r => r.stockNo),
  ])
  return watchBaseGainers.value.filter(r => {
    if (tier12.has(r.stockNo)) return false
    if (r.changePct < 9.5) return false
    if (!passAntiSpoof(r)) return false
    if (!passAntiFake(r)) return false
    const ref = volRef5d(r)
    if (!ref) return false
    const ratio = r.volume / ref
    if (ratio < 1.5 || ratio >= 5) return false
    return true
  })
})

const limitUpDisplay   = computed(() => moversGainers.value.filter(r => r.changePct >= 9.5))
const limitDownDisplay = computed(() => moversLosers.value.filter(r => r.changePct <= -9.5))

function goToWarrant(stockNo) {
  warrantStockNo.value = stockNo
  selectTab('warrant')
  nextTick(() => searchWarrant())
}

async function fetchQuote() {
  if (!quoteStockNo) return
  quoteLoading.value = true
  try {
    const [qd, td] = await Promise.all([
      fetch(`${API}/api/stock/quote/${quoteStockNo}`).then(r => r.json()),
      fetch(`${API}/api/stock/ticks/${quoteStockNo}`).then(r => r.json()),
    ])
    if (qd.ok) quoteData.value = qd
    if (td.ok) quoteTicks.value = td.rows || []
  } catch(e) { /* silent */ } finally {
    quoteLoading.value = false
  }
}
function openQuote(stockNo) {
  quoteStockNo = stockNo
  quoteData.value = null
  quoteTicks.value = []
  quoteTab.value = 'quote'
  quoteVisible.value = true
  fetchQuote()
  clearInterval(quoteTimer)
  quoteTimer = setInterval(fetchQuote, 10000)
}
function closeQuote() {
  quoteVisible.value = false
  clearInterval(quoteTimer)
  quoteTimer = null
  quoteStockNo = ''
  quoteData.value = null
  quoteTicks.value = []
}

// ── 處置股 ──────────────────────────────────────────
const disposalRows    = ref([])
const disposalLoading = ref(false)
const disposalError   = ref('')
const disposalUpdated = ref('')
const disposalSearch  = ref('')
async function fetchDisposal() {
  if (disposalLoading.value) return
  disposalLoading.value = true
  disposalError.value   = ''
  try {
    const r = await fetch(`${API}/api/market/disposal`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    disposalRows.value    = d.rows    || []
    disposalUpdated.value = d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString('zh-TW') : ''
  } catch(e) {
    disposalError.value = e.message
  } finally {
    disposalLoading.value = false
  }
}
const disposalFiltered = computed(() => {
  const kw = disposalSearch.value.trim()
  if (!kw) return disposalRows.value
  return disposalRows.value.filter(r => r.stockNo.includes(kw) || r.stockName.includes(kw))
})

// ── 三維財務分析 ─────────────────────────────────────
const finStockNo        = ref('')
const finLoading        = ref(false)
const finError          = ref('')
const finData           = ref(null)
const finSubTab         = ref('ops')   // 'ops' | 'profit' | 'health'
const finSuggestions    = ref([])
const finShowSuggestions = ref(false)
let _finCharts          = {}
let _finSearchTimer     = null

async function onFinInput() {
  const q = finStockNo.value.trim()
  clearTimeout(_finSearchTimer)
  if (!q) { finSuggestions.value = []; return }
  _finSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${API}/api/stock/search?q=${encodeURIComponent(q)}`)
      finSuggestions.value = await r.json()
      finShowSuggestions.value = finSuggestions.value.length > 0
    } catch {}
  }, 200)
}

function selectFinSuggestion(item) {
  finStockNo.value = item.no
  finSuggestions.value = []
  finShowSuggestions.value = false
  fetchFinance()
}

async function fetchFinance() {
  const no = finStockNo.value.trim()
  if (!no) return
  finSuggestions.value = []
  finShowSuggestions.value = false
  finLoading.value = true
  finError.value   = ''
  finData.value    = null
  destroyFinCharts()
  try {
    const r = await fetch(`${API}/api/finance/${encodeURIComponent(no)}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    finData.value  = d
    finSubTab.value = 'ops'
    await nextTick()
    renderFinCharts()
  } catch(e) { finError.value = e.message }
  finally { finLoading.value = false }
}

function destroyFinCharts() {
  Object.values(_finCharts).forEach(c => { try { c.destroy() } catch {} })
  _finCharts = {}
}

function finChart(id, cfg) {
  const el = document.getElementById(id)
  if (!el) return
  if (_finCharts[id]) { try { _finCharts[id].destroy() } catch {} }
  _finCharts[id] = new Chart(el, cfg)
}

function renderFinCharts() {
  if (!finData.value) return
  const d = finData.value
  const yrs = d.years
  const m   = d.metrics

  const gridColor  = 'rgba(255,255,255,0.07)'
  const tickColor  = '#9ca3af'
  const baseFont   = { color: tickColor, size: 11 }
  const axisBase   = { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } } }
  const tooltipBase = { backgroundColor: '#1f2937', titleColor: '#e5e7eb', bodyColor: '#d1d5db', borderColor: '#374151', borderWidth: 1 }

  if (finSubTab.value === 'ops') {
    // 營收 + 毛利率
    finChart('fc-revenue', {
      type: 'bar',
      data: { labels: yrs, datasets: [
        { type: 'bar', label: '營業收入（億）', data: yrs.map(y => m[y]?.revenue), backgroundColor: 'rgba(99,179,237,0.6)', yAxisID: 'y' },
        { type: 'line', label: '毛利率%', data: yrs.map(y => m[y]?.grossMargin), borderColor: '#68d391', backgroundColor: 'transparent', yAxisID: 'y2', tension: 0.3, pointRadius: 4 }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { y: { ...axisBase, title: { display: true, text: '億元', color: tickColor } },
                  y2: { ...axisBase, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '%', color: tickColor } } } }
    })
    // 營收 vs 淨利對比
    finChart('fc-opex', {
      type: 'bar',
      data: { labels: yrs, datasets: [
        { label: '營業收入（億）', data: yrs.map(y => m[y]?.revenue), backgroundColor: 'rgba(99,179,237,0.5)' },
        { label: '稅後淨利（億）', data: yrs.map(y => m[y]?.netIncome), backgroundColor: 'rgba(154,117,234,0.7)' }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { x: axisBase, y: { ...axisBase, title: { display: true, text: '億元', color: tickColor } } } }
    })
    // 營業利益率
    finChart('fc-opmargin', {
      type: 'line',
      data: { labels: yrs, datasets: [
        { label: '毛利率%', data: yrs.map(y => m[y]?.grossMargin), borderColor: '#68d391', tension: 0.3, pointRadius: 5 },
        { label: '營業利益率%', data: yrs.map(y => m[y]?.opMargin), borderColor: '#f6ad55', tension: 0.3, pointRadius: 5 },
        { label: '淨利率%', data: yrs.map(y => m[y]?.netMargin), borderColor: '#fc8181', tension: 0.3, pointRadius: 5 }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { x: axisBase, y: { ...axisBase, title: { display: true, text: '%', color: tickColor } } } }
    })
  } else if (finSubTab.value === 'profit') {
    // 淨利 + 淨利率
    finChart('fc-netincome', {
      type: 'bar',
      data: { labels: yrs, datasets: [
        { type: 'bar', label: '稅後淨利（億）', data: yrs.map(y => m[y]?.netIncome), backgroundColor: 'rgba(154,117,234,0.6)', yAxisID: 'y' },
        { type: 'line', label: '淨利率%', data: yrs.map(y => m[y]?.netMargin), borderColor: '#f687b3', backgroundColor: 'transparent', yAxisID: 'y2', tension: 0.3, pointRadius: 4 }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { y: { ...axisBase, title: { display: true, text: '億元', color: tickColor } },
                  y2: { ...axisBase, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '%', color: tickColor } } } }
    })
    // EPS
    finChart('fc-eps', {
      type: 'bar',
      data: { labels: yrs, datasets: [
        { label: 'EPS（元）', data: yrs.map(y => m[y]?.eps), backgroundColor: 'rgba(246,173,85,0.7)' }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { x: axisBase, y: { ...axisBase, title: { display: true, text: '元', color: tickColor } } } }
    })
    // ROE / ROA
    finChart('fc-roe', {
      type: 'line',
      data: { labels: yrs, datasets: [
        { label: 'ROE%', data: yrs.map(y => m[y]?.roe), borderColor: '#f6ad55', tension: 0.3, pointRadius: 5 },
        { label: 'ROA%', data: yrs.map(y => m[y]?.roa), borderColor: '#68d391', tension: 0.3, pointRadius: 5 }
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { x: axisBase, y: { ...axisBase, title: { display: true, text: '%', color: tickColor } } } }
    })
  } else if (finSubTab.value === 'health') {
    // 營業CF / FCF（只有最新一期）
    const yr0 = yrs[0]
    finChart('fc-cf', {
      type: 'bar',
      data: { labels: ['營業現金流', '自由現金流'], datasets: [
        { label: yr0, data: [m[yr0]?.operatingCF ?? null, m[yr0]?.fcf ?? null],
          backgroundColor: ['rgba(99,179,237,0.7)', 'rgba(104,211,145,0.7)'] }
      ]},
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { tooltip: tooltipBase, legend: { display: false } },
        scales: { x: { ...axisBase, title: { display: true, text: '億元', color: tickColor } }, y: axisBase } }
    })
    // 流動比率（只有最新一期）
    finChart('fc-ratios', {
      type: 'bar',
      data: { labels: [yr0], datasets: [
        { label: '流動比率%', data: [m[yr0]?.currentRatio ?? null], backgroundColor: 'rgba(104,211,145,0.7)' }
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { tooltip: tooltipBase, legend: { labels: baseFont } },
        scales: { x: axisBase, y: { ...axisBase, title: { display: true, text: '%', color: tickColor } } } }
    })
    // ROE / ROA 歷年趨勢（只有最新一期）
    finChart('fc-cash', {
      type: 'bar',
      data: { labels: ['ROE%', 'ROA%'], datasets: [
        { label: yr0, data: [m[yr0]?.roe ?? null, m[yr0]?.roa ?? null],
          backgroundColor: ['rgba(246,173,85,0.7)', 'rgba(144,205,244,0.7)'] }
      ]},
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { tooltip: tooltipBase, legend: { display: false } },
        scales: { x: { ...axisBase, title: { display: true, text: '%', color: tickColor } }, y: axisBase } }
    })
  }
}

watch(finSubTab, async () => { await nextTick(); renderFinCharts() })

// ── 庫藏股買回 ───────────────────────────────────────
const buybackRows    = ref([])
const buybackLoading = ref(false)
const buybackError   = ref('')
const buybackUpdated = ref('')
const buybackFilter  = ref('all')  // 'all' | '上市' | '上櫃'
const buybackSearch  = ref('')     // 代碼或名稱關鍵字
async function fetchBuyback() {
  if (buybackLoading.value) return
  buybackLoading.value = true
  buybackError.value   = ''
  try {
    const r = await fetch(`${API}/api/market/buyback`)
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'API error')
    buybackRows.value    = d.rows || []
    buybackUpdated.value = d.updatedAt || ''
  } catch(e) {
    buybackError.value = e.message
  } finally {
    buybackLoading.value = false
  }
}

const buybackFiltered = computed(() => {
  let rows = buybackRows.value
  if (buybackFilter.value !== 'all') rows = rows.filter(r => r.market === buybackFilter.value)
  if (buybackSearch.value.trim()) {
    const kw = buybackSearch.value.trim()
    rows = rows.filter(r => r.stockNo.includes(kw) || r.stockName.includes(kw))
  }
  return rows
})

function buybackPurposeLabel(code) {
  const map = { '1': '轉讓員工', '2': '維護股東', '3': '員工股票', '4': '可轉債', '5': '員工認股', '8': '限制股票' }
  return map[code] || code
}

// ── 日報表 ────────────────────────────────────────
const reportStockNo = ref('2059')
const reportDate    = ref('2026-04-28')
const reportLoading = ref(false)
const reportData    = ref(null)
const reportError   = ref('')
const postAnalysis  = ref(null)
const pmLoading     = ref(false)
const pmStatus      = ref('')

// ── 台指期籌碼 ────────────────────────────────────
const chipsLoading = ref(false)
const chipsRows    = ref([])
const chipsError   = ref('')

async function loadFuturesChips() {
  chipsLoading.value = true
  chipsError.value   = ''
  try {
    const r = await fetch(`${API}/api/futures-chips`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    chipsRows.value = d.rows || []
  } catch(e) {
    chipsError.value = '載入失敗：' + e.message
  } finally {
    chipsLoading.value = false
  }
}

async function manualSyncChips() {
  chipsLoading.value = true
  try {
    await fetch(`${API}/api/sync/futures-chips`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 3000))
    await loadFuturesChips()
  } catch(e) {
    chipsError.value = '同步失敗：' + e.message
    chipsLoading.value = false
  }
}

function chipsNetColor(v) { return +v > 0 ? 'text-red-400' : +v < 0 ? 'text-green-400' : 'text-gray-500' }
function chipsNetSign(v)  { return +v > 0 ? `▲ ${(+v).toLocaleString()}` : +v < 0 ? `▼ ${Math.abs(+v).toLocaleString()}` : '0' }

// ── 上市櫃漲跌家數 ────────────────────────────────
const breadthLoading = ref(false)
const breadthRows    = ref([])
const breadthError   = ref('')

// ── 漲跌幅分布 ────────────────────────────────────
const distLoading = ref(false)
const distData    = ref(null)
const distError   = ref('')

const distMaxCount = computed(() => {
  if (!distData.value?.buckets) return 1
  return Math.max(...distData.value.buckets.flatMap(b => [b.twse, b.tpex]), 1)
})

async function loadMarketDist() {
  distLoading.value = true
  distError.value   = ''
  try {
    const r = await fetch(`${API}/api/market-distribution`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    distData.value = d
  } catch(e) {
    distError.value = '載入失敗：' + e.message
  } finally {
    distLoading.value = false
  }
}

async function loadMarketBreadth() {
  breadthLoading.value = true
  breadthError.value   = ''
  try {
    const r = await fetch(`${API}/api/market-breadth`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    breadthRows.value = d.rows || []
  } catch(e) {
    breadthError.value = '載入失敗：' + e.message
  } finally {
    breadthLoading.value = false
  }
}

async function manualSyncBreadth() {
  breadthLoading.value = true
  try {
    await fetch(`${API}/api/sync/market-breadth`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 3000))
    await loadMarketBreadth()
  } catch(e) {
    breadthError.value = '同步失敗：' + e.message
    breadthLoading.value = false
  }
}

// ── 強勢族群 ──────────────────────────────────────
const sectorLoading  = ref(false)
const sectorData     = ref(null)
const sectorError    = ref('')
const sectorDates    = ref([])
const sectorDateSel  = ref('')

const sectorExpanded = ref({})
function toggleSector(name) {
  sectorExpanded.value[name] = !sectorExpanded.value[name]
}

async function loadSectorDates() {
  try {
    const r = await fetch(`${API}/api/sector-snapshots/dates`)
    const d = await r.json()
    sectorDates.value = d.dates || []
  } catch(e) { /* 靜默，不影響主流程 */ }
}

async function loadSectorAnalysis() {
  sectorLoading.value = true
  sectorError.value   = ''
  sectorData.value    = null
  sectorExpanded.value = {}
  try {
    const qs = sectorDateSel.value ? `?date=${sectorDateSel.value}` : ''
    const r  = await fetch(`${API}/api/sector-analysis${qs}`)
    const d  = await r.json()
    if (d.error) throw new Error(d.error)
    sectorData.value = d
    // 把今日加進日期清單（若還沒存入 DB 則不在清單內）
    if (d.date && !sectorDates.value.includes(d.date))
      sectorDates.value = [d.date, ...sectorDates.value]
  } catch(e) {
    sectorError.value = '載入失敗：' + e.message
  } finally {
    sectorLoading.value = false
  }
}


// ── 台股選股系統 ─────────────────────────────────────
const screenerLoading  = ref(false)
const screenerRows     = ref([])
const screenerError    = ref('')
const screenerRunDate  = ref('')
const screenerTotal    = ref(0)
const screenerSyncing  = ref(false)
const screenerBackfilling = ref(false)
const screenerLogicOpen = ref(false)
const screenerSortKey  = ref('score')
const screenerSortDir  = ref(-1)  // -1 = desc, 1 = asc

function screenerSortBy(key) {
  if (screenerSortKey.value === key) screenerSortDir.value *= -1
  else { screenerSortKey.value = key; screenerSortDir.value = -1 }
}
function screenerSortIcon(key) {
  if (screenerSortKey.value !== key) return ' ↕'
  return screenerSortDir.value === -1 ? ' ↓' : ' ↑'
}
const screenerSorted = computed(() => {
  const key = screenerSortKey.value
  const dir = screenerSortDir.value
  return [...screenerRows.value].sort((a, b) => {
    let av, bv
    if (key === 'score')       { av = a.score ?? -Infinity;          bv = b.score ?? -Infinity }
    else if (key === 'close')  { av = +(a.close ?? 0);               bv = +(b.close ?? 0) }
    else if (key === 'change_pct') { av = +(a.change_pct ?? 0);      bv = +(b.change_pct ?? 0) }
    else if (key === 'chg5d')  { av = +(a.detail?.chg5d ?? 0);       bv = +(b.detail?.chg5d ?? 0) }
    else if (key === 'trust')  { av = a.trust_streak ?? 0;           bv = b.trust_streak ?? 0 }
    else if (key === 'major')  { av = +(a.major_net5 ?? 0);          bv = +(b.major_net5 ?? 0) }
    else if (key === 'margin') { av = +(a.margin_chg5 ?? 0);         bv = +(b.margin_chg5 ?? 0) }
    else if (key === 'rank')   { av = +(a.close_rank ?? 1);          bv = +(b.close_rank ?? 1) }
    else { av = 0; bv = 0 }
    return av < bv ? dir : av > bv ? -dir : 0
  })
})

// 個股跑分
const scoreStockNo          = ref('')
const scoreLoading          = ref(false)
const scoreResult           = ref(null)
const scoreError            = ref('')
const scoreSuggestions      = ref([])
const scoreShowSuggestions  = ref(false)
let _scoreSearchTimer       = null

async function onScoreInput() {
  const q = scoreStockNo.value.trim()
  clearTimeout(_scoreSearchTimer)
  if (!q) { scoreSuggestions.value = []; return }
  _scoreSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${API}/api/stock/search?q=${encodeURIComponent(q)}`)
      scoreSuggestions.value = await r.json()
      scoreShowSuggestions.value = scoreSuggestions.value.length > 0
    } catch {}
  }, 200)
}

function selectScoreSuggestion(item) {
  scoreStockNo.value = item.no
  scoreSuggestions.value = []
  scoreShowSuggestions.value = false
  queryScore()
}

async function queryScore() {
  if (!scoreStockNo.value.trim()) return
  scoreSuggestions.value = []
  scoreShowSuggestions.value = false
  scoreLoading.value = true
  scoreResult.value  = null
  scoreError.value   = ''
  try {
    const r = await fetch(`${API}/api/screener/score?stockNo=${encodeURIComponent(scoreStockNo.value.trim())}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    scoreResult.value = d
  } catch(e) {
    scoreError.value = e.message
  } finally {
    scoreLoading.value = false
  }
}

async function loadScreener() {
  screenerLoading.value = true
  screenerError.value   = ''
  try {
    const r = await fetch(`${API}/api/screener/results?limit=100`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    screenerRows.value    = d.rows || []
    screenerTotal.value   = d.total || 0
    screenerRunDate.value = d.run_date ? String(d.run_date).slice(0, 10) : ''
  } catch(e) {
    screenerError.value = '載入失敗：' + e.message
  } finally {
    screenerLoading.value = false
  }
}

async function manualRunScreener() {
  screenerSyncing.value = true
  screenerError.value   = ''
  try {
    await fetch(`${API}/api/sync/screener`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 35000))
    await loadScreener()
  } catch(e) {
    screenerError.value = '計算失敗：' + e.message
  } finally {
    screenerSyncing.value = false
  }
}

async function backfillMarket() {
  screenerBackfilling.value = true
  screenerError.value       = ''
  try {
    await fetch(`${API}/api/sync/backfill-market?days=20`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 90000))
    await loadScreener()
  } catch(e) {
    screenerError.value = '回填失敗：' + e.message
  } finally {
    screenerBackfilling.value = false
  }
}

const PHASE_META = {
  A: { label: 'A 吸籌', cls: 'bg-blue-500/20 text-blue-400 border-blue-700' },
  B: { label: 'B 洗盤', cls: 'bg-purple-500/20 text-purple-400 border-purple-700' },
  C: { label: 'C 發動', cls: 'bg-orange-500/20 text-orange-400 border-orange-700' },
  D: { label: 'D 主升', cls: 'bg-red-500/20 text-red-400 border-red-700' },
}

function screenerChangePctColor(v) {
  return +v > 0 ? 'text-red-400' : +v < 0 ? 'text-green-400' : 'text-gray-400'
}
function fmtShares2(v) {
  if (v == null) return '—'
  const abs = Math.abs(+v)
  return abs >= 1000000 ? (abs/1000000).toFixed(1) + 'M' : abs >= 1000 ? (abs/1000).toFixed(0) + 'K' : String(abs)
}
function fmtSignShares2(v) {
  if (v == null) return '—'
  const sign = +v > 0 ? '+' : +v < 0 ? '-' : ''
  const abs = Math.abs(+v)
  const num = abs >= 1000000 ? (abs/1000000).toFixed(1) + 'M' : abs >= 1000 ? (abs/1000).toFixed(0) + 'K' : String(abs)
  return sign + num
}

function screenerAdvice(row) {
  const rank    = +(row.close_rank || 0)
  const streak  = row.trust_streak || 0
  const chg5d   = +(row.detail?.chg5d || 0)
  const phase   = row.phase
  const stealth = row.is_stealth
  const marginDown = row.margin_chg5 != null && row.margin_chg5 < 0

  if (phase === 'A') {
    if (stealth && rank < 0.3 && streak >= 5)
      return { tag: '★ 積極關注', tip: `低位隱形布局連買 ${streak} 天，訊號最強。可小量試單（資金 ≤ 5%），跌破近期低點即出場。`, cls: 'text-green-400', bg: 'bg-green-500/10 border-green-800/60' }
    if (stealth && rank < 0.5)
      return { tag: '◎ 追蹤觀察', tip: '隱形布局進行中。等待量能溫和放大（非爆量）或股價突破短期盤整後再進場，勿搶進。', cls: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-800/60' }
    if (rank < 0.3)
      return { tag: '◎ 低位留意', tip: '吸籌訊號且位置偏低。可小量試探，停損設近期低點，等投信連買天數增加後加碼。', cls: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-800/60' }
    return { tag: '○ 持續觀察', tip: '吸籌訊號成立但位置偏中，暫不追入，等位置更低或天數更長（≥5天）再行動。', cls: 'text-gray-400', bg: 'bg-gray-700/30 border-gray-700/60' }
  }

  if (phase === 'B') {
    if (chg5d >= 0 && marginDown)
      return { tag: '▲ 止穩留意', tip: '洗盤後股價轉穩且融資仍在降，可小量試探。若再破洗盤低點立即出場，等出現明顯紅K確認再加碼。', cls: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-800/60' }
    if (chg5d >= 0)
      return { tag: '▲ 觀察止穩', tip: '股價暫時持穩，但需確認融資持續下降。等 2~3 天確認止穩後再考慮進場。', cls: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-800/60' }
    return { tag: '✕ 等待止穩', tip: '仍在洗盤下跌中，勿追跌。等股價止穩並出現紅 K 棒，確認低點不再破後再評估。', cls: 'text-gray-500', bg: 'bg-gray-700/30 border-gray-700/60' }
  }

  if (phase === 'C') {
    if (rank < 0.5)
      return { tag: '▶ 可跟進', tip: `啟動初期且位置合理（${Math.round(rank*100)}%）。量溫和放大時可跟進，停損設 5 日均線下方或進場價 -5%。`, cls: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-800/60' }
    if (rank < 0.7)
      return { tag: '▶ 謹慎跟進', tip: '發動中但位置偏中高，追入風險提高。建議等回測確認支撐後小量介入，嚴設停損。', cls: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-800/60' }
    return { tag: '⚠ 高位追入謹慎', tip: '已漲一段且位置偏高，不建議追入。等回測前段盤整區支撐後再評估。', cls: 'text-red-400', bg: 'bg-red-500/10 border-red-800/60' }
  }

  if (phase === 'D')
    return { tag: '⚠ 高位謹慎', tip: '籌碼訊號佳但位置偏高，追高風險大。等出現明顯回測（-5%~-8%）且量縮後，確認支撐再考慮。', cls: 'text-red-400', bg: 'bg-red-500/10 border-red-800/60' }

  return { tag: '○ 持續追蹤', tip: '訊號成立，持續觀察法人動向，尚無明確進場時機。', cls: 'text-gray-500', bg: 'bg-gray-700/30 border-gray-700/60' }
}

// ── 三大法人查詢 ─────────────────────────────────────────
const instStockNo         = ref('')
const instDays            = ref(20)
const instCustomDays      = ref(30)
const instLoading         = ref(false)
const instError           = ref('')
const instRows            = ref([])
const instSummary         = ref(null)
const instStockName       = ref('')
const instSuggestions     = ref([])
const instShowSuggestions = ref(false)
let _instSearchTimer      = null

const instEffectiveDays = computed(() =>
  instDays.value === 'custom' ? (parseInt(instCustomDays.value) || 20) : instDays.value
)

async function onInstInput() {
  const q = instStockNo.value.trim()
  clearTimeout(_instSearchTimer)
  if (!q) { instSuggestions.value = []; return }
  _instSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${API}/api/stock/search?q=${encodeURIComponent(q)}`)
      instSuggestions.value = await r.json()
      instShowSuggestions.value = instSuggestions.value.length > 0
    } catch {}
  }, 200)
}

function selectInstSuggestion(item) {
  instStockNo.value = item.no
  instSuggestions.value = []
  instShowSuggestions.value = false
  queryInst()
}

async function queryInst() {
  if (!instStockNo.value.trim()) return
  instSuggestions.value = []
  instShowSuggestions.value = false
  instLoading.value = true
  instError.value   = ''
  instRows.value    = []
  instSummary.value = null
  try {
    const r = await fetch(`${API}/api/inst/history?stockNo=${encodeURIComponent(instStockNo.value.trim())}&days=${instEffectiveDays.value}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    if (!d.rows.length) throw new Error(`查無 ${instStockNo.value} 的資料，請確認代號或先執行回填`)
    instRows.value     = d.rows
    instSummary.value  = d.summary
    instStockName.value = d.stock_name || instStockNo.value
  } catch(e) {
    instError.value = e.message
  } finally {
    instLoading.value = false
  }
}

function instFmt(v) {
  if (v == null) return '—'
  const sign = v > 0 ? '+' : ''
  return sign + (+v).toLocaleString() + ' 張'
}
function instColor(v) {
  if (v == null) return 'text-gray-600'
  return v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-500'
}
function instChangePctColor(v) {
  if (v == null) return 'text-gray-600'
  return v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-500'
}

async function generateReport() {
  reportLoading.value = true
  reportError.value   = ''
  reportData.value    = null
  postAnalysis.value  = null
  try {
    const [r, pa] = await Promise.all([
      fetch(`${API}/api/daily-report?stockNo=${reportStockNo.value}&date=${reportDate.value}`).then(r => r.json()),
      fetch(`${API}/api/post-market-analysis?stockNo=${reportStockNo.value}&date=${reportDate.value}`).then(r => r.json()).catch(() => null),
    ])
    if (r.error) throw new Error(r.error)
    reportData.value   = r
    postAnalysis.value = pa?.indicators?.length ? pa : null
  } catch(e) {
    reportError.value = '報表生成失敗：' + e.message
  } finally {
    reportLoading.value = false
  }
}

function viewPostMarket(stockNo) {
  reportStockNo.value = stockNo
  reportDate.value = new Date(Date.now() + 8*3600000).toISOString().slice(0, 10)
  tab.value = 'report'
  nextTick(() => generateReport())
}

async function triggerPostMarket() {
  if (pmLoading.value) return
  pmLoading.value = true
  pmStatus.value  = '送出請求中...'
  try {
    await fetch(`${API}/api/sync/post-market`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: reportDate.value }),
    })
    // 輪詢直到產生完成（最多等 30 秒）
    let attempts = 0
    const poll = async () => {
      attempts++
      pmStatus.value = `分析產生中... (${attempts * 3}s)`
      try {
        const r = await fetch(`${API}/api/post-market-analysis?stockNo=${reportStockNo.value}&date=${reportDate.value}`).then(r => r.json())
        if (r?.indicators?.length) {
          postAnalysis.value = r
          pmLoading.value    = false
          pmStatus.value     = ''
          return
        }
      } catch {}
      if (attempts < 10) setTimeout(poll, 3000)
      else {
        pmStatus.value  = '產生逾時，請稍後再試'
        pmLoading.value = false
      }
    }
    setTimeout(poll, 3000)
  } catch(e) {
    pmStatus.value  = '請求失敗：' + e.message
    pmLoading.value = false
  }
}

function fmtNum(v) { return v != null ? (+v).toLocaleString() : '—' }
function fmtShares(v) { return v != null ? Math.floor(Math.abs(+v) / 1000).toLocaleString() + ' 張' : '—' }
function signShares(v) {
  if (v == null) return '—'
  const abs = Math.floor(Math.abs(+v) / 1000).toLocaleString()
  return +v > 0 ? `▲ ${abs} 張` : +v < 0 ? `▼ ${abs} 張` : `${abs} 張`
}
function signColor(v) { return +v > 0 ? 'text-red-400' : +v < 0 ? 'text-green-400' : 'text-gray-400' }

const changelog = [
  {
    date: '2026-05-18', tag: '新功能',
    items: [
      '漲跌排行：量縮漲停觀察與量增漲停觀察新增「觀察時段」下拉選單，每 30 分鐘自動存查一次（09:30、10:00、10:30…13:30），可隨時回顧當日各時段的名單狀態',
    ]
  },
  {
    date: '2026-05-18', tag: '修正',
    items: [
      '漲跌排行：修正盤中更新太慢的問題——前端輪詢間隔從 60 秒縮短為 15 秒（盤中 09:00–13:30），後端快取 TTL 從 60 秒縮短為 12 秒，盤後維持 120 秒/60 秒以節省資源',
      '漲跌排行：修正開盤後輪詢邏輯錯誤——原本在 09:20 之後會從 30 秒切換至 60 秒，改用 setTimeout 遞迴確保每次依當前時段正確設定間隔',
      '主力監控（StockAI）：修正排程執行但 Railway logs 無任何輸出的問題——新增 logging.basicConfig(level=INFO)，scheduler 及 ingest 服務的 INFO 訊息現在可正常在 Railway logs 顯示',
    ]
  },
  {
    date: '2026-05-14', tag: '新功能',
    items: [
      '雙模選股：新增置頂「系統說明」面板（可收折），說明 Regime 判斷邏輯、動能/價值模式評分架構、族群熱度用途及建議操作流程',
      '雙模選股：新增季財報同步功能（POST /api/admin/sync/financials），從 TWSE openapi 抓取損益表 + 資產負債表，覆蓋六大產業類型，自動計算毛利率、負債比、FCF 正負',
      '雙模選股：價值模式防禦分增加「負債比」（5分）與「月營收 YoY 波動度」（5分）兩項指標，殖利率上限調整為 10 分，總分維持 100 分',
      '雙模選股：價值排行榜新增全欄位排序功能（PE、殖利率、營收YoY 等均可點擊排序）',
      '雙模選股：前端部署至 Vercel（https://stockai-frontend-ten.vercel.app）',
    ]
  }, {
    date: '2026-05-14', tag: '修正',
    items: [
      '雙模選股：月營收同步改用 TWSE openapi t187ap05_L，廢棄已失效的 MOPS 端點，一次同步當月、上月、去年同月三筆資料',
      '雙模選股：價值模式毛利率標準差（需多季累積）改以近 12 個月月營收 YoY 波動度替代，立即可計算，未來季資料累積後再切回',
      '雙模選股：修正 Numeric(8,4) 欄位溢位問題，ROE、eps_growth_yoy、PEG 均加上 9999 上限保護',
      '雙模選股：修正 fcf_positive 型別錯誤（DB 為 Boolean，程式傳入 int），改為 bool() 轉型',
      '雙模選股：修正 fundamentals 資料表 schema 遷移後未重建的問題（main.py 啟動時在 DROP 後補執行 create_all）',
      '雙模選股：全站配色大幅翻修——背景改為純黑（#000）/深灰（#111），股票代碼與名稱改為純白色，邊框加粗至 #2a2a2a，廢除低對比 text-gray-500/600',
      '雙模選股：動能/價值排行榜改用彩色分數 Badge 取代細長進度條，新增趨勢/籌碼、品質/估值/防禦子分數獨立欄位',
    ]
  }, {
    date: '2026-05-14', tag: '功能',
    items: [
      '雙模選股：完成價值模式（品質×估值×防禦），支援動能/價值雙模標籤頁切換，市場為熊市時自動預設顯示價值模式',
      '雙模選股－價值模式：顯示本益比、股價淨值比、ROE（PBR/PE 推算）、殖利率、月營收年增率評分 Top 50',
      '雙模選股：市場狀態（牛市/熊市/震盪）自動對應啟用模式標籤提示',
    ]
  }, {
    date: '2026-05-14', tag: '修正',
    items: [
      '移除「雙模選股」分頁',
      '新增「強勢弱質選股」分頁：由 StockAI 雙模引擎驅動，顯示市場狀態（趨勢強度/資金熱度/風險分數）及動能 Top 50 排行，含 MA多頭/20日新高/投信連買標籤',
    ]
  }, {
    date: '2026-05-13', tag: '修正',
    items: [
      '財務分析：資料來源改為 Yahoo Finance，修正在 Railway 伺服器上因 Goodinfo.tw 封鎖 IP 導致逾時錯誤的問題，現可正常查詢',
      '財務分析：支援最近 4 年完整年度損益表資料（營收、淨利、EPS、淨利率），適用所有上市/上櫃台灣股票',
      '財務分析：「經營分析」第二圖改為「營收 vs 淨利對比」，原費用結構圖因資料來源限制移除',
      '財務分析：「財務健全度」頁籤調整為顯示流動比率、ROE/ROA、自由現金流、營業現金流當期指標卡片，新增資料來源說明',
      '漲跌排行：修正盤中（09:00–13:30）點「刷新」無資料的問題——TWSE MIS 在交易尖峰時段偶發回傳空陣列，系統現改為保留上次有效快取並顯示「⚠ 交易所即時資料暫無回應，顯示上次快取」提示，且同時發起刷新的多個請求改為等待同一次回應，避免雙重壓力',
      '漲跌排行：預防性強化——(1) 伺服器快取 TTL 從 30 秒延長至 2 分鐘，減少打 TWSE MIS 的頻率；(2) 修正伺服器剛啟動時第一次請求未設 lastGoodData，並發保護會穿透的漏洞，改為讓後續請求等待同一次抓取完成；(3) 伺服器啟動後 5 秒若在交易時段自動暖快取，使用者開啟頁面即有資料',
      '財務分析：查詢框支援輸入股票名稱，輸入中文名稱（如「台積電」）或代號均可查詢，輸入時即時顯示符合的股票建議清單供點選',
      '三大法人：查詢框支援輸入股票名稱，輸入中文名稱或代號均可查詢，輸入時即時顯示建議清單',
      '個股跑分：查詢框支援輸入股票名稱，輸入中文名稱或代號均可查詢，輸入時即時顯示建議清單',
      '即時監控：關閉訊號觸發的 Telegram 推播通知（進場/警示/出場警示），訊號仍繼續寫入資料庫',
    ]
  },
  {
    date: '2026-05-12', tag: '新功能',
    items: [
      '庫藏股：新增「區間中位數」欄位（買回最低價 + 最高價 ÷ 2）及「溢價比」欄位（中位數相對即時股價的漲跌幅），即時顯示股價與公司承諾買回價位的距離',
      '庫藏股：即時股價與漲跌幅拆分為獨立兩欄，閱讀更清晰',
      '新增「修正公告」分頁（本頁），記錄每日異動',
      '新增「處置股」分頁：顯示 TWSE 公告處置有價證券，含剩餘天數、措施類型、累計次數，每 30 分鐘快取',
      '漲跌排行：新增 <span class="text-yellow-300">⚡</span> 記號，標示開盤一小時內（09:00–10:00）即達漲停的強勢個股，主排行榜與六個觀察區均顯示，說明區已加入圖例',
      '權證查詢：表格改為自動延伸螢幕全寬，不再需要左右拉動捲軸',
      'Telegram 傳送觀察名單：量縮 + 量增兩個觀察區一起傳送，每行只顯示代號與名稱，⚡ 記號同步出現在 Telegram 訊息中',
    ]
  },
  {
    date: '2026-05-12', tag: '修正',
    items: [
      '新增「財務分析」分頁：輸入任意台灣股票代號，自動抓取 Goodinfo.tw 損益表、資產負債表、現金流量表，計算三大維度指標（經營 / 獲利 / 財務健全度），以 Chart.js 互動圖表呈現，資料快取 4 小時',
      '台股選股：所有欄位標頭可點選排序（評分、收盤價、當日漲跌、5日漲幅、投信連買、主力5日淨、融資5日變、位置），再次點選切換升降序',
      '分頁順序調整：修正公告→台股選股→漲跌排行→三大法人→強勢族群→漲跌家數→處置股→庫藏股→即時監控→日報表→歷史資料→台指期籌碼→權證',
      '處置股：修正尚未開始的處置顯示為「已到期」的問題，現在正確顯示「未開始」（藍色）',
      '移除「大股東吃貨」分頁',
      '預設畫面改為「修正公告」',
      '漲跌排行：修正早上空白問題——MIS 請求改為每次 5 個並發（原先 34 個同時送出），避免 TWSE rate-limit 造成全部 timeout 回傳空陣列',
      'Telegram 13:00 排程：修正若無人瀏覽頁面導致快取過期而誤判休市、跳過傳送的問題，現在排程執行前會主動刷新資料',
      'Telegram 傳送：過濾為只有今日仍有有效權證的個股才列入名單',
    ]
  },
  {
    date: '2026-05-11', tag: '新功能',
    items: [
      '權證查詢：新增「情境分析」按鈕，展開 BS 模型情境表——列出標的股價 ±10% 範圍、IV ±2 變化下的理論權證價格，協助研判區間',
      '漲跌排行：盤中每 30 分鐘自動拍漲停委買快照（09:00–13:30），收盤後 13:35 儲存最終快照並標記漲停收盤，供歷史篩選使用',
    ]
  },
  {
    date: '2026-05-10', tag: '新功能',
    items: [
      '漲跌排行：新增「量增漲停觀察」三個順位（★/▲/△），篩選今日爆量漲停且委買比偏高的主力換手標的',
      '漲跌排行：量縮觀察區說明新增「漲停委買比」與「量比」欄位的顏色規則圖例，量增觀察區同步新增說明',
      '漲跌排行：點股票代號可開啟即時五檔報價面板（每 3 秒更新），顯示委買委賣五檔、成交明細、漲跌幅',
      '權證查詢：新增「符合條件」清單，自動篩選今日有漲停委買量或昨日漲停收盤的權證',
    ]
  },
  {
    date: '2026-05-08', tag: '新功能',
    items: [
      '漲跌排行：新增「量縮漲停觀察」三個順位（★/▲/△），依昨帶量長紅、今量縮漲停的籌碼集中模式篩選',
      '後端建立 <code class="text-gray-300 bg-gray-800 px-1 rounded">daily_limit_bid</code> 資料表，記錄每日各股的漲停委買量與漲停收盤狀態',
    ]
  },
  {
    date: '2026-05-07', tag: '新功能',
    items: [
      '新增「庫藏股」分頁：顯示近六個月董事會決議庫藏股買回資訊，含即時股價對照、上市 + 上櫃',
      '即時監控：切換為富邦 WebSocket 即時報價，同步新增「分時明細」即時 tick 串流',
      '漲跌排行：新增歷史日期選擇器，可查詢歷史某日漲跌排行（從資料庫讀取）',
      '漲跌排行 Telegram 傳送鈕：量縮觀察區上方新增「傳送觀察名單」按鈕，可手動觸發傳送',
      '每日 13:00 自動傳送量縮漲停觀察名單至 Telegram（週一至週五）',
      '漲跌排行：成交量超過十萬張顯示特殊顏色，說明區加入色階圖例',
    ]
  },
  {
    date: '2026-05-07', tag: '修正',
    items: [
      '強勢族群：修正 Railway 重啟後資料停滯不更新的問題，並加入 15:50 重試排程',
      '部署：修正 Railway 上 Python 找不到的問題（補上 Dockerfile + requirements.txt）',
      '部署：修正富邦憑證在 Railway 環境無法載入的問題（改由環境變數 Base64 解碼）',
      '庫藏股：修正股價 API URL 過長問題（改為每批 50 檔分批送出）',
      '權證查詢：南亞科等深度 OTM 權證 IV 計算結果空白問題——改用 Newton-Raphson + bisection 混合法，修正舊版在 vega ≈ 0 時發散的問題',
      '權證查詢：加入 Merton 連續股息調整（<code class="text-gray-300 bg-gray-800 px-1 rounded">S_adj = S·e^(−qT)</code>），改善高殖利率標的（如台積電）的 IV / Delta 準確度',
      '權證查詢：到期日已過且今日無成交的權證不再顯示空白列',
      '權證查詢：標的股價與昨收落差過大導致 IV 無解時，顯示「價格失效」提示而非空白',
    ]
  },
  {
    date: '2026-05-05', tag: '新功能',
    items: [
      '新增「漲跌排行」分頁：即時顯示 TOP 50 漲跌幅排行，含成交量欄位',
      '新增「權證」分頁：輸入標的代號或中文名稱，查詢今日上市權證，顯示 IV、溢價率、槓桿、Delta（Black-Scholes 模型）',
      '權證查詢：加入快取（stale-while-revalidate）+ 系統啟動時預熱，大幅縮短首次查詢時間',
      '權證查詢：新增外部工具連結（履約試算、權證試算、權證搜尋）',
      '三大法人：新增 5 日選項與自訂天數輸入',
      '台股選股：新增單股評分功能（/api/screener/score），可查詢單一個股的指標評分',
      '富邦 API：啟用憑證登入，後端可呼叫富邦 Neo 完整報價功能',
    ]
  },
  {
    date: '2026-05-05', tag: '修正',
    items: [
      '三大法人：切換到其他分頁再切回，查詢結果不再清空',
      '台股選股：修正 change_pct 顯示為 0 的問題（改用 MIS 即時股價補值）',
      '台股選股：修正主力淨買張數單位錯誤（改正為張，÷1000）',
      '歷史資料：修正收盤價歷史不準確問題（改用 TWSE STOCK_DAY API 取得正確 OHLCV）',
      '權證查詢：修正代號轉名稱來源錯誤（改用 t187ap03_L），解決搜尋失敗問題',
      '權證查詢：修正無成交日（z=\'-\'）顯示空白，改以昨收（y）替代並標示「昨/無成交」',
      'PC ratio：修正取到舊資料的問題（改為取最新一筆 pcData[0]）',
    ]
  },
  {
    date: '2026-05-03', tag: '新功能',
    items: [
      '歷史資料：新增上櫃（TPEX）個股與擴充 ETF 篩選，並對所有個股執行 OHLCV 歷史補建',
      '歷史資料：新增融券餘額（short_bal）欄位至 market_daily 資料表',
      '歷史資料：增加補建天數上限至 250 天，並新增全量補建端點',
    ]
  },
  {
    date: '2026-05-03', tag: '修正',
    items: [
      '三大法人 / 歷史資料：移除日期範圍限制，最多可查詢 200 天',
    ]
  },
  {
    date: '2026-05-02', tag: '修正',
    items: [
      '台股選股：修正結尾連假（NULL）法人日造成評分異常的問題，並清除 market_daily 中的假期空行',
    ]
  },
  {
    date: '2026-04-29', tag: '新功能',
    items: [
      '系統上線至 Railway 雲端，前端正式 build 並以 /ws/ 路徑部署',
      '新增 Telegram 測試傳送按鈕，以及後端背景監控——偵測到異常信號時自動推播 Telegram 通知',
    ]
  },
  {
    date: '2026-04-29', tag: '修正',
    items: [
      '強勢族群：修正 TWSE 產業分類名稱對應錯誤的問題',
    ]
  },
  {
    date: '2026-04-28', tag: '新功能',
    items: [
      '系統初始建置：即時監控（川湖科技、鈊象、大立光、泰金寶）、歷史資料、日報表、漲跌家數、台指期籌碼、強勢族群、台股選股、三大法人等分頁',
    ]
  },
]

onMounted(() => {
  startAll()
  if (navbarRef.value) {
    navbarBottom.value = navbarRef.value.getBoundingClientRect().bottom
  }
})
onUnmounted(() => { stopAll(); if (_askTimer) clearInterval(_askTimer) })

const fmt   = n => n != null ? (+n).toLocaleString() : '-'
const fmtZ  = n => n != null ? Math.floor(Math.abs(+n) / 1000).toLocaleString() : '-'
const sgnZ  = n => n != null ? (n < 0 ? '-' : n > 0 ? '+' : '') + Math.floor(Math.abs(+n) / 1000).toLocaleString() : '—'
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-white">

    <!-- 頂部導覽 -->
    <header class="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
      <div>
        <span class="text-lg font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
          主力監控系統
        </span>
        <span class="ml-3 text-xs text-gray-600 font-mono">川湖科技・鈊象・大立光・泰金寶</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="w-2 h-2 rounded-full" :class="anyConnected() ? 'bg-green-400 animate-pulse' : 'bg-gray-600'"></span>
        <span :class="anyConnected() ? 'text-green-400' : 'text-gray-500'">{{ anyConnected() ? '監控中' : '未連線' }}</span>
      </div>
    </header>

    <!-- 分頁切換 -->
    <div ref="navbarRef" class="border-b border-gray-800 px-6 flex gap-1">
      <button v-for="t in [{ id:'changelog', label:'修正公告' }, { id:'screener', label:'台股選股' }, { id:'strongweak', label:'漲時看勢跌時看質' }, { id:'finance', label:'財務分析' }, { id:'movers', label:'漲跌排行' }, { id:'inst', label:'三大法人' }, { id:'sector', label:'強勢族群' }, { id:'breadth', label:'漲跌家數' }, { id:'disposal', label:'處置股' }, { id:'buyback', label:'庫藏股' }, { id:'monitor', label:'即時監控' }, { id:'report', label:'日報表' }, { id:'db', label:'歷史資料' }, { id:'chips', label:'台指期籌碼' }, { id:'warrant', label:'權證' }]" :key="t.id"
              @click="selectTab(t.id)"
              class="px-4 py-3 text-sm font-medium transition border-b-2 -mb-px"
              :class="tab === t.id ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-500 hover:text-gray-300'">
        {{ t.label }}
      </button>
    </div>

    <!-- ── 分頁內容區 ── -->
    <div>

    <!-- ── 修正公告 Tab ── -->
    <div v-if="tab === 'changelog'" class="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <h2 class="text-lg font-semibold text-white">修正公告</h2>
      <div v-for="entry in changelog" :key="entry.date" class="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-300">{{ entry.date }}</span>
          <span v-if="entry.tag" class="text-xs px-2 py-0.5 rounded font-semibold"
            :class="entry.tag === '新功能' ? 'bg-blue-900/50 text-blue-300' : entry.tag === '修正' ? 'bg-orange-900/50 text-orange-300' : 'bg-gray-800 text-gray-400'">
            {{ entry.tag }}
          </span>
        </div>
        <ul class="space-y-1 text-sm text-gray-400">
          <li v-for="item in entry.items" :key="item" class="flex gap-2">
            <span class="text-gray-600 select-none shrink-0">•</span>
            <span v-html="item"></span>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── 即時監控 Tab ── -->
    <div v-if="tab === 'monitor'" class="max-w-6xl mx-auto px-4 py-6 space-y-5">

      <!-- 控制按鈕 -->
      <div class="flex flex-wrap gap-3 items-center">
        <button @click="startAll"
                class="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition">
          重新連線
        </button>
        <button @click="stopAll"
                class="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-medium transition text-gray-300">
          停止監控
        </button>
        <button @click="testTelegram"
                class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-sm font-medium transition">
          📨 測試 Telegram
        </button>
        <button @click="simulateChuanhu"
                class="px-4 py-2 rounded-lg bg-yellow-700 hover:bg-yellow-600 text-sm font-medium transition">
          🧪 模擬川湖訊號
        </button>
        <span v-if="telegramStatus" class="text-sm text-cyan-400 self-center">{{ telegramStatus }}</span>
        <span class="text-xs text-gray-600 self-center">富邦 WebSocket 即時行情</span>
      </div>

      <!-- 訊號說明 -->
      <div class="flex flex-wrap gap-2 text-xs">
        <template v-for="(meta, key) in SIGNAL_META" :key="key">
          <div v-if="['entry','warning','exit','exit_warning','watch','normal'].includes(key)"
               class="flex items-center gap-1.5 bg-gray-900 rounded-lg px-3 py-1.5">
            <span class="w-2 h-2 rounded-full flex-shrink-0" :class="meta.cls"></span>
            <span class="text-gray-400">{{ meta.label }}</span>
          </div>
        </template>
      </div>

      <!-- 4 檔個股卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div v-for="s in STOCKS" :key="s.no"
             class="rounded-2xl border p-4 transition-all cursor-pointer"
             :class="[stocks[s.no].latest ? SIGNAL_META[stocks[s.no].latest.signal]?.border || 'border-gray-800' : 'border-gray-800',
                      selectedTickStock === s.no ? 'ring-1 ring-purple-500' : '']"
             @click="selectedTickStock = selectedTickStock === s.no ? '' : s.no">

          <!-- 股票標題 -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full flex-shrink-0"
                    :class="stocks[s.no].connected ? 'bg-green-400 animate-pulse' : 'bg-gray-600'"></span>
              <span class="font-bold text-white">{{ s.name }}</span>
              <span class="text-xs text-gray-500 font-mono">{{ s.no }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-600 font-mono">{{ stocks[s.no].latest?.checkTime }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded border"
                    :class="selectedTickStock === s.no ? 'border-purple-600 text-purple-400' : 'border-gray-700 text-gray-600'">
                分時
              </span>
            </div>
          </div>

          <!-- 訊號狀態 -->
          <div v-if="stocks[s.no].latest" class="mb-3 flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-full text-xs font-bold text-white"
                  :class="SIGNAL_META[stocks[s.no].latest.signal]?.cls || 'bg-gray-700'">
              {{ SIGNAL_META[stocks[s.no].latest.signal]?.label }}
            </span>
            <span class="text-sm" :class="SIGNAL_META[stocks[s.no].latest.signal]?.text || 'text-gray-400'">
              {{ stocks[s.no].latest.message }}
            </span>
          </div>
          <div v-else class="mb-3 text-gray-600 text-sm">等待資料...</div>

          <!-- 數字格 -->
          <div v-if="stocks[s.no].latest?.price" class="grid grid-cols-4 gap-2">
            <div v-for="item in [
              { label:'現價', value: fmt(stocks[s.no].latest.price),     cls:'text-white font-bold' },
              { label:'日高', value: fmt(stocks[s.no].latest.dayHigh),   cls:'text-red-400' },
              { label:'日低', value: fmt(stocks[s.no].latest.dayLow),    cls:'text-green-400' },
              { label:'量比', value: stocks[s.no].latest.volRatio + 'x', cls: stocks[s.no].latest.volRatio >= 3 ? 'text-red-400 font-bold' : stocks[s.no].latest.volRatio >= 2 ? 'text-orange-400' : 'text-gray-300' },
            ]" :key="item.label" class="bg-gray-900 rounded-lg p-2 text-center">
              <div class="text-xs text-gray-600 mb-0.5">{{ item.label }}</div>
              <div class="text-sm" :class="item.cls">{{ item.value }}</div>
            </div>
          </div>

          <!-- MACD 指標列 -->
          <div v-if="stocks[s.no].latest?.macd" class="mt-2 flex items-center gap-2 text-xs font-mono bg-gray-950/60 rounded-lg px-3 py-1.5">
            <span class="text-gray-600">MACD</span>
            <span :class="stocks[s.no].latest.macd.line >= 0 ? 'text-red-400' : 'text-green-400'">{{ stocks[s.no].latest.macd.line }}</span>
            <span class="text-gray-700">│</span>
            <span class="text-gray-600">訊號</span>
            <span class="text-gray-300">{{ stocks[s.no].latest.macd.sig }}</span>
            <span class="text-gray-700">│</span>
            <span class="text-gray-600">柱</span>
            <span :class="stocks[s.no].latest.macd.hist >= 0 ? 'text-red-400' : 'text-green-400'">{{ stocks[s.no].latest.macd.hist }}</span>
            <span v-if="stocks[s.no].latest.macd.divergence"
                  class="ml-auto px-1.5 py-0.5 rounded bg-cyan-900/70 text-cyan-300 font-bold animate-pulse">
              底背離
            </span>
          </div>
          <div v-else-if="stocks[s.no].latest?.price" class="mt-2 text-xs text-gray-700 font-mono px-1">
            MACD 資料累積中（需 35 根 K 棒）
          </div>

          <!-- 最近日誌（3 筆） -->
          <div class="mt-3 space-y-1">
            <div v-for="log in stocks[s.no].logs.slice(0, 3)" :key="log.id"
                 class="flex items-center gap-2 text-xs text-gray-500 font-mono">
              <span class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    :class="SIGNAL_META[log.signal]?.cls || 'bg-gray-600'"></span>
              <span class="flex-1 truncate" :class="SIGNAL_META[log.signal]?.text || 'text-gray-500'">{{ log.message }}</span>
              <span class="flex-shrink-0">{{ log.checkTime }}</span>
            </div>
          </div>

          <!-- 盤後分析快捷 -->
          <div class="mt-3 pt-2.5 border-t border-gray-800/60">
            <button @click.stop="viewPostMarket(s.no)"
                    class="w-full text-xs py-1.5 rounded-lg bg-gray-800 hover:bg-emerald-900/50 text-gray-500 hover:text-emerald-300 border border-gray-700 hover:border-emerald-800 transition-all">
              📊 查看盤後分析
            </button>
          </div>
        </div>
      </div>

      <!-- 分時明細面板 -->
      <div v-if="selectedTickStock" class="bg-gray-900 border border-purple-900/50 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-white">
              {{ STOCKS.find(s => s.no === selectedTickStock)?.name }} ({{ selectedTickStock }}) 分時明細
            </span>
            <span class="text-xs text-gray-500">{{ stocks[selectedTickStock]?.ticks?.length || 0 }} 筆</span>
          </div>
          <button @click="selectedTickStock = ''" class="text-gray-600 hover:text-gray-400 text-xs px-2 py-1 rounded border border-gray-700">關閉</button>
        </div>

        <div class="overflow-y-auto" style="max-height:340px">
          <table class="w-full text-xs font-mono">
            <thead class="sticky top-0 bg-gray-900 border-b border-gray-800">
              <tr class="text-gray-500">
                <th class="px-3 py-2 text-left">時間</th>
                <th class="px-3 py-2 text-right">成交價</th>
                <th class="px-3 py-2 text-right">量(張)</th>
                <th class="px-3 py-2 text-center">外/內盤</th>
              </tr>
            </thead>
            <tbody>
              <template v-if="stocks[selectedTickStock]?.ticks?.length">
                <tr v-for="(t, i) in stocks[selectedTickStock].ticks" :key="i"
                    class="border-b border-gray-800/40 hover:bg-gray-800/30">
                  <td class="px-3 py-1.5 text-gray-500">{{ t.time }}</td>
                  <td class="px-3 py-1.5 text-right font-semibold"
                      :class="t.side === 'buy' ? 'text-red-400' : t.side === 'sell' ? 'text-green-400' : 'text-gray-300'">
                    {{ t.price }}
                  </td>
                  <td class="px-3 py-1.5 text-right text-gray-400">{{ t.volume }}</td>
                  <td class="px-3 py-1.5 text-center">
                    <span v-if="t.side === 'buy'"  class="text-red-400">外盤</span>
                    <span v-else-if="t.side === 'sell'" class="text-green-400">內盤</span>
                    <span v-else class="text-gray-700">—</span>
                  </td>
                </tr>
              </template>
              <tr v-else>
                <td colspan="4" class="px-3 py-6 text-center text-gray-600">等待成交資料...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 監控邏輯說明 -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 class="font-semibold text-white text-sm mb-4">監控邏輯</h2>
        <div class="space-y-3 text-sm">
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-red-400 font-semibold">一級：主力抄底</span>
              <span class="text-gray-500 ml-2">量比 ≥ 3x ＋ 接近日低 ＋ 長下影線　→ 重點監控，準備進場</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-orange-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-orange-400 font-semibold">二級：趨勢轉折</span>
              <span class="text-gray-500 ml-2">MACD底背離 ＋ 站回5分鐘均線　或　MACD底背離 ＋ 接近日低　→ 分批布局</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-yellow-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-yellow-400 font-semibold">三級：量能警戒</span>
              <span class="text-gray-500 ml-2">量比 ≥ 2x ＋ 接近日低　→ 放入追蹤清單，等待反彈訊號</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-teal-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-teal-400 font-semibold">四級：異動提醒</span>
              <span class="text-gray-500 ml-2">量比 ≥ 2x ＋ 高位換手　→ 警惕高檔出貨訊號</span>
            </div>
          </div>
          <div class="border-t border-gray-800 pt-3 flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-cyan-400 font-semibold">MACD 底背離</span>
              <span class="text-gray-500 ml-2">股價低點持續走低，但 MACD 柱狀體低點墊高 → 賣壓遞減，潛在反轉</span>
            </div>
          </div>
          <div class="bg-gray-800/50 rounded-lg px-4 py-3 mt-2 text-xs text-gray-500 space-y-1 font-mono">
            <div><span class="text-gray-400">MACD Line</span>　= EMA(12) − EMA(26)　　價格趨勢動能</div>
            <div><span class="text-gray-400">Signal</span>　　　= EMA(9) of MACD　　　　平滑訊號線</div>
            <div><span class="text-gray-400">Histogram</span>　= MACD − Signal　　　　　柱狀體（正紅負綠）</div>
          </div>
        </div>
      </div>

    </div>

    <!-- ── 歷史資料 Tab ── -->
    <div v-if="tab === 'db'" class="max-w-6xl mx-auto px-4 py-6 space-y-4">

      <!-- 篩選列 -->
      <div class="flex items-center gap-3 flex-wrap">
        <select v-model="dbStockNo" @change="onDbStockChange"
                class="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700">
          <option value="">全部個股</option>
          <option v-for="s in STOCKS" :key="s.no" :value="s.no">{{ s.name }} {{ s.no }}</option>
        </select>
        <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm">
          <button v-for="t in [{ id:'signals', label:'訊號紀錄' }, { id:'daily', label:'每日行情' }, { id:'intraday', label:'分時明細' }]" :key="t.id"
                  @click="onDbTabChange(t.id)"
                  class="px-4 py-2 transition"
                  :class="dbTab === t.id ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'">
            {{ t.label }}
          </button>
        </div>
        <button @click="dbTab==='signals' ? loadSignals() : loadDaily()"
                class="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition">
          重新整理
        </button>
        <span v-if="dbLoading" class="text-xs text-gray-500">載入中...</span>
        <span class="text-xs text-gray-600 ml-auto">顯示近 60 天</span>
      </div>

      <!-- 訊號紀錄表 -->
      <div v-if="dbTab === 'signals'" class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 class="font-semibold text-white text-sm">訊號紀錄</h2>
          <span class="text-xs text-gray-500">共 {{ signalRows.length }} 筆</span>
        </div>
        <div v-if="!signalRows.length && !dbLoading" class="px-5 py-8 text-center text-gray-600 text-sm">
          尚無資料，請先執行回測或等待即時監控觸發
        </div>
        <div class="overflow-x-auto">
          <table v-if="signalRows.length" class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-500 uppercase border-b border-gray-800 bg-gray-900/80">
                <th class="px-4 py-3 text-left">時間</th>
                <th class="px-4 py-3 text-left">個股</th>
                <th class="px-4 py-3 text-left">訊號</th>
                <th class="px-4 py-3 text-right">現價</th>
                <th class="px-4 py-3 text-right">量比</th>
                <th class="px-4 py-3 text-right">日低</th>
                <th class="px-4 py-3 text-center">底背離</th>
                <th class="px-4 py-3 text-left">說明</th>
                <th class="px-4 py-3 text-center">來源</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              <tr v-for="row in signalRows" :key="row.id"
                  class="hover:bg-gray-800/40 transition"
                  :class="row.signal_type==='entry' ? 'bg-red-950/10' : row.signal_type==='warning' ? 'bg-orange-950/10' : row.signal_type==='watch' ? 'bg-yellow-950/10' : row.signal_type==='exit_warning' ? 'bg-teal-950/10' : ''">
                <td class="px-4 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">
                  {{ new Date(row.signal_time).toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) }}
                </td>
                <td class="px-4 py-2.5 text-gray-200 whitespace-nowrap">
                  {{ row.stock_name }}<span class="text-gray-600 ml-1 text-xs">{{ row.stock_no }}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="px-2 py-0.5 rounded-full text-xs font-bold text-white"
                        :class="signalBadge[row.signal_type] || 'bg-gray-600'">
                    {{ signalLabel[row.signal_type] || row.signal_type }}
                  </span>
                </td>
                <td class="px-4 py-2.5 text-right text-white font-semibold">{{ fmt(row.price) }}</td>
                <td class="px-4 py-2.5 text-right"
                    :class="row.vol_ratio >= 3 ? 'text-red-400 font-bold' : row.vol_ratio >= 2 ? 'text-orange-400' : 'text-gray-400'">
                  {{ row.vol_ratio }}x
                </td>
                <td class="px-4 py-2.5 text-right text-green-400">{{ fmt(row.day_low) }}</td>
                <td class="px-4 py-2.5 text-center">
                  <span v-if="row.macd_div" class="text-cyan-400 font-bold text-xs">底背離</span>
                  <span v-else class="text-gray-700">—</span>
                </td>
                <td class="px-4 py-2.5 text-gray-400 text-xs max-w-xs truncate">{{ row.message }}</td>
                <td class="px-4 py-2.5 text-center">
                  <span class="px-1.5 py-0.5 rounded text-xs"
                        :class="row.source==='realtime' ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'">
                    {{ sourceLabel[row.source] || row.source }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 每日行情表 -->
      <div v-if="dbTab === 'daily'" class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 class="font-semibold text-white text-sm">每日行情摘要</h2>
          <span class="text-xs text-gray-500">共 {{ dailyRows.length }} 筆</span>
        </div>
        <div v-if="!dailyRows.length && !dbLoading" class="px-5 py-8 text-center text-gray-600 text-sm">
          尚無資料
        </div>
        <div class="overflow-x-auto">
          <table v-if="dailyRows.length" class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-500 uppercase border-b border-gray-800 bg-gray-900/80">
                <th class="px-4 py-3 text-left">日期</th>
                <th class="px-4 py-3 text-left">個股</th>
                <th class="px-4 py-3 text-right">開盤</th>
                <th class="px-4 py-3 text-right">最高</th>
                <th class="px-4 py-3 text-right">最低</th>
                <th class="px-4 py-3 text-right">收盤</th>
                <th class="px-4 py-3 text-right">成交量</th>
                <th class="px-4 py-3 text-right">外資</th>
                <th class="px-4 py-3 text-right">投信</th>
                <th class="px-4 py-3 text-right">自營商</th>
                <th class="px-4 py-3 text-right">融資(張)</th>
                <th class="px-4 py-3 text-right">主力買賣超</th>
                <th class="px-4 py-3 text-right">家數差</th>
                <th class="px-4 py-3 text-right">5日集中</th>
                <th class="px-4 py-3 text-right">20日集中</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              <tr v-for="row in dailyRows" :key="row.stock_no + row.trade_date"
                  class="hover:bg-gray-800/40 transition">
                <td class="px-4 py-2 font-mono text-xs text-gray-400 whitespace-nowrap">
                  {{ new Date(row.trade_date).toLocaleDateString('zh-TW', { month:'2-digit', day:'2-digit' }) }}
                </td>
                <td class="px-4 py-2 text-gray-200 whitespace-nowrap">
                  {{ row.stock_name }}<span class="text-gray-600 ml-1 text-xs">{{ row.stock_no }}</span>
                </td>
                <td class="px-4 py-2 text-right text-gray-400">{{ fmt(row.open_price) }}</td>
                <td class="px-4 py-2 text-right text-red-400">{{ fmt(row.high_price) }}</td>
                <td class="px-4 py-2 text-right text-green-400">{{ fmt(row.low_price) }}</td>
                <td class="px-4 py-2 text-right text-white font-semibold">{{ fmt(row.close_price) }}</td>
                <td class="px-4 py-2 text-right text-gray-400 text-xs">{{ fmtZ(row.total_volume) }}</td>
                <td class="px-4 py-2 text-right text-xs"
                    :class="row.inst_foreign > 0 ? 'text-red-400' : row.inst_foreign < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ sgnZ(row.inst_foreign) }}
                </td>
                <td class="px-4 py-2 text-right text-xs"
                    :class="row.inst_trust > 0 ? 'text-red-400' : row.inst_trust < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ sgnZ(row.inst_trust) }}
                </td>
                <td class="px-4 py-2 text-right text-xs"
                    :class="row.inst_dealer > 0 ? 'text-red-400' : row.inst_dealer < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ sgnZ(row.inst_dealer) }}
                </td>
                <td class="px-4 py-2 text-right text-xs text-gray-300">
                  {{ row.margin_balance != null ? (+row.margin_balance).toLocaleString() : '—' }}
                </td>
                <td class="px-4 py-2 text-right text-xs font-semibold"
                    :class="row.major_net > 0 ? 'text-red-400' : row.major_net < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ sgnZ(row.major_net) }}
                </td>
                <td class="px-4 py-2 text-right text-xs font-mono"
                    :class="(row.buyer_count - row.seller_count) > 0 ? 'text-red-400' : (row.buyer_count - row.seller_count) < 0 ? 'text-green-400' : 'text-gray-500'">
                  {{ row.buyer_count != null ? ((row.buyer_count - row.seller_count) > 0 ? '+' : '') + (row.buyer_count - row.seller_count) : '—' }}
                </td>
                <td class="px-4 py-2 text-right text-xs font-mono"
                    :class="row.concentration_5d > 0 ? 'text-red-400' : row.concentration_5d < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ row.concentration_5d != null ? (row.concentration_5d > 0 ? '+' : '') + (+row.concentration_5d).toFixed(2) + '%' : '—' }}
                </td>
                <td class="px-4 py-2 text-right text-xs font-mono"
                    :class="row.concentration_20d > 0 ? 'text-red-400' : row.concentration_20d < 0 ? 'text-green-400' : 'text-gray-600'">
                  {{ row.concentration_20d != null ? (row.concentration_20d > 0 ? '+' : '') + (+row.concentration_20d).toFixed(2) + '%' : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 分時明細表 -->
      <div v-if="dbTab === 'intraday'" class="space-y-3">
        <!-- 日期選擇 -->
        <div v-if="!dbStockNo" class="text-gray-500 text-sm text-center py-8">請先選擇個股</div>
        <template v-else>
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-xs text-gray-500">選擇日期：</span>
            <div class="flex flex-wrap gap-2">
              <button v-for="d in intradayDates" :key="d"
                      @click="intradayDate = d; loadIntraday()"
                      class="px-3 py-1 rounded-lg text-xs font-mono transition"
                      :class="intradayDate === d ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'">
                {{ d }}
              </button>
            </div>
          </div>

          <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 class="font-semibold text-white text-sm">
                {{ STOCKS.find(s => s.no === dbStockNo)?.name }} {{ dbStockNo }}
                <span class="text-gray-500 font-normal ml-2">{{ intradayDate }}</span>
              </h2>
              <span class="text-xs text-gray-500">
                {{ intradayRows.length }} 根 K 棒
                <span v-if="intradaySignals.length" class="ml-2 text-purple-400">· {{ intradaySignals.length }} 筆訊號</span>
              </span>
            </div>
            <div v-if="!intradayRows.length && !dbLoading" class="px-5 py-8 text-center text-gray-600 text-sm">
              該日無資料
            </div>
            <div class="overflow-auto max-h-[600px]">
              <table v-if="intradayRows.length" class="w-full text-xs table-fixed">
                <colgroup>
                  <col class="w-16">   <!-- 時間 -->
                  <col class="w-16">   <!-- 開盤 -->
                  <col class="w-16">   <!-- 最高 -->
                  <col class="w-16">   <!-- 最低 -->
                  <col class="w-16">   <!-- 收盤 -->
                  <col class="w-20">   <!-- 成交量 -->
                  <col class="w-20">   <!-- 累計量 -->
                  <col>                <!-- 訊號（自動填滿剩餘） -->
                </colgroup>
                <thead class="sticky top-0 bg-gray-900 z-10">
                  <tr class="text-gray-500 uppercase border-b border-gray-800">
                    <th class="px-3 py-3 text-left whitespace-nowrap">時間</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">開盤</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">最高</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">最低</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">收盤</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">成交量(張)</th>
                    <th class="px-3 py-3 text-right whitespace-nowrap">累計量(張)</th>
                    <th class="px-3 py-3 text-left">訊號</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800">
                  <tr v-for="(row, idx) in intradayRows" :key="row.bar_time"
                      :class="intradaySignalMap[barTimeKey(row.bar_time)]
                        ? 'bg-gray-800/60'
                        : 'hover:bg-gray-800/30 transition'">
                    <td class="px-3 py-1.5 font-mono whitespace-nowrap"
                        :class="intradaySignalMap[barTimeKey(row.bar_time)] ? 'text-white font-bold' : 'text-gray-400'">
                      {{ new Date(row.bar_time).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', hour12: false, timeZone:'Asia/Taipei' }) }}
                    </td>
                    <td class="px-3 py-1.5 text-right text-gray-400 whitespace-nowrap">{{ fmt(row.open_price) }}</td>
                    <td class="px-3 py-1.5 text-right text-red-400 whitespace-nowrap">{{ fmt(row.high_price) }}</td>
                    <td class="px-3 py-1.5 text-right text-green-400 whitespace-nowrap">{{ fmt(row.low_price) }}</td>
                    <td class="px-3 py-1.5 text-right text-white font-semibold whitespace-nowrap">{{ fmt(row.close_price) }}</td>
                    <td class="px-3 py-1.5 text-right text-gray-300 whitespace-nowrap">{{ fmtZ(row.volume) }}</td>
                    <td class="px-3 py-1.5 text-right text-gray-500 whitespace-nowrap">{{ intradayCumVol[idx]?.toLocaleString() ?? '-' }}</td>
                    <td class="px-3 py-1.5">
                      <template v-if="intradaySignalMap[barTimeKey(row.bar_time)]">
                        <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span class="w-2 h-2 rounded-full flex-shrink-0"
                                :class="signalBadge[intradaySignalMap[barTimeKey(row.bar_time)].signal_type] || 'bg-gray-500'">
                          </span>
                          <span class="font-medium" :class="{
                            'text-red-400':    intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'entry',
                            'text-orange-400': intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'warning',
                            'text-yellow-400': intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'watch',
                            'text-teal-400':   intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'exit_warning',
                          }">{{ signalLabel[intradaySignalMap[barTimeKey(row.bar_time)].signal_type] }}</span>
                        </span>
                        <div class="text-gray-500 mt-0.5 leading-tight">
                          {{ intradaySignalMap[barTimeKey(row.bar_time)].message }}
                        </div>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>

    </div>


    <!-- ── 日報表 Tab ── -->
    <div v-if="tab === 'report'" class="max-w-3xl mx-auto px-4 py-6 space-y-4">

      <!-- 選股 / 選日期 -->
      <div class="flex flex-wrap gap-3 items-end">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-gray-500">個股</span>
          <select v-model="reportStockNo" class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            <option v-for="s in STOCKS" :key="s.no" :value="s.no">{{ s.name }}（{{ s.no }}）</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-gray-500">日期</span>
          <input type="date" v-model="reportDate"
                 class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
        <button @click="generateReport"
                class="px-5 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition">
          {{ reportLoading ? '生成中...' : '📋 生成報表' }}
        </button>
      </div>

      <p v-if="reportError" class="text-red-400 text-sm">{{ reportError }}</p>

      <!-- 報表內容 -->
      <div v-if="reportData" class="space-y-4">

        <!-- 標題 -->
        <div class="rounded-2xl border border-purple-800 bg-gray-900 p-5">
          <h2 class="text-lg font-bold text-purple-300">
            {{ reportData.stockName }}（{{ reportData.stockNo }}）日報表
          </h2>
          <p class="text-xs text-gray-500 mt-1">{{ reportData.date }}</p>
        </div>

        <!-- 當日行情 -->
        <div v-if="reportData.day" class="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-3">
          <h3 class="text-sm font-semibold text-gray-300">📊 當日行情</h3>
          <div class="grid grid-cols-4 gap-3">
            <div v-for="item in [
              { label:'開盤', value: fmtNum(reportData.day.open_price) },
              { label:'最高', value: fmtNum(reportData.day.high_price), cls:'text-red-400' },
              { label:'最低', value: fmtNum(reportData.day.low_price),  cls:'text-green-400' },
              { label:'收盤', value: fmtNum(reportData.day.close_price), cls:'text-white font-bold' },
            ]" :key="item.label" class="bg-gray-800 rounded-lg p-3 text-center">
              <div class="text-xs text-gray-500">{{ item.label }}</div>
              <div :class="['text-sm mt-1', item.cls || 'text-gray-200']">{{ item.value }}</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="bg-gray-800 rounded-lg p-3">
              <span class="text-gray-500 text-xs">成交量</span>
              <span class="ml-2 text-gray-200">{{ fmtShares(reportData.day.total_volume) }}</span>
            </div>
            <div class="bg-gray-800 rounded-lg p-3">
              <span class="text-gray-500 text-xs">融資餘額</span>
              <span class="ml-2 text-gray-200">{{ fmtShares(reportData.day.margin_balance) }}</span>
            </div>
          </div>
        </div>

        <!-- 三大法人 -->
        <div v-if="reportData.day?.inst_foreign != null" class="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-3">
          <h3 class="text-sm font-semibold text-gray-300">🏦 三大法人</h3>
          <div class="grid grid-cols-3 gap-3 text-sm">
            <div v-for="item in [
              { label:'外資', value: reportData.day.inst_foreign },
              { label:'投信', value: reportData.day.inst_trust   },
              { label:'自營商', value: reportData.day.inst_dealer },
            ]" :key="item.label" class="bg-gray-800 rounded-lg p-3 text-center">
              <div class="text-xs text-gray-500">{{ item.label }}</div>
              <div :class="['text-sm mt-1', signColor(item.value)]">{{ signShares(item.value) }}</div>
            </div>
          </div>
        </div>

        <!-- 訊號紀錄 -->
        <div class="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-2">
          <h3 class="text-sm font-semibold text-gray-300">🚨 訊號紀錄</h3>
          <div v-if="reportData.signals.length === 0" class="text-xs text-gray-500">當日無異常訊號</div>
          <div v-for="s in reportData.signals" :key="s.id"
               class="flex items-start gap-2 text-xs bg-gray-800 rounded-lg p-2">
            <span class="text-gray-400 font-mono shrink-0">
              {{ new Date(s.signal_time).toLocaleTimeString('zh-TW', { timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit' }) }}
            </span>
            <span class="text-orange-400 shrink-0">{{ s.signal_type }}</span>
            <span class="text-gray-300">{{ s.message }}</span>
          </div>
        </div>

        <!-- 盤後技術指標分析 -->
        <div v-if="postAnalysis" class="rounded-2xl border border-emerald-900 bg-gray-900 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-emerald-300">🔬 盤後技術指標分析</h3>
            <div class="flex gap-2 text-xs">
              <span class="bg-green-900/50 text-green-400 px-2 py-0.5 rounded-full">強勢 {{ postAnalysis.bullishCount }}</span>
              <span class="bg-red-900/50 text-red-400 px-2 py-0.5 rounded-full">弱勢 {{ postAnalysis.bearishCount }}</span>
            </div>
          </div>

          <!-- 指標訊號列表 -->
          <div class="space-y-1.5">
            <div v-for="(item, i) in postAnalysis.indicators" :key="i"
                 class="flex items-center gap-2.5 text-xs rounded-lg px-3 py-2 border"
                 :class="{
                   'bg-green-950/40 border-green-900/40': item.type === 'bullish',
                   'bg-red-950/40 border-red-900/40':     item.type === 'bearish',
                   'bg-gray-800/50 border-gray-700/30':   item.type === 'neutral',
                 }">
              <span class="shrink-0 w-1.5 h-1.5 rounded-full"
                    :class="{ 'bg-green-400': item.type==='bullish', 'bg-red-400': item.type==='bearish', 'bg-gray-500': item.type==='neutral' }"></span>
              <span class="font-semibold shrink-0 w-20 truncate"
                    :class="{ 'text-green-400': item.type==='bullish', 'text-red-400': item.type==='bearish', 'text-gray-500': item.type==='neutral' }">
                {{ item.ind }}
              </span>
              <span class="flex-1"
                    :class="{ 'text-green-300': item.type==='bullish', 'text-red-300': item.type==='bearish', 'text-gray-400': item.type==='neutral' }">
                {{ item.msg }}
              </span>
              <span v-if="item.type === 'bullish'" class="shrink-0 text-green-500">▲</span>
              <span v-else-if="item.type === 'bearish'" class="shrink-0 text-red-500">▼</span>
            </div>
          </div>

          <!-- 綜合判斷 -->
          <p v-if="postAnalysis.summary" class="text-xs text-gray-400 border-t border-gray-800 pt-2 mt-1">
            💡 {{ postAnalysis.summary }}
          </p>
        </div>

        <div v-else-if="reportData" class="rounded-2xl border border-gray-800 bg-gray-900 p-4 space-y-2">
          <div class="text-xs text-gray-600 text-center">
            盤後技術指標分析尚未產生（每日 18:40 自動更新）
          </div>
          <div class="flex items-center justify-center gap-3">
            <button @click="triggerPostMarket" :disabled="pmLoading"
                    class="px-4 py-1.5 rounded-lg text-xs font-medium transition"
                    :class="pmLoading
                      ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                      : 'bg-emerald-800 hover:bg-emerald-700 text-emerald-300'">
              {{ pmLoading ? '產生中...' : '立即產生' }}
            </button>
            <span v-if="pmStatus" class="text-xs text-gray-500 animate-pulse">{{ pmStatus }}</span>
          </div>
        </div>

        <!-- 綜合分析 -->
        <div class="rounded-2xl border border-blue-900 bg-gray-900 p-5 space-y-2">
          <h3 class="text-sm font-semibold text-blue-300">💡 綜合分析</h3>
          <p v-for="(line, i) in reportData.analysis" :key="i" class="text-sm text-gray-300 leading-relaxed">
            {{ line }}
          </p>
        </div>

        <!-- 相關新聞 -->
        <div class="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-2">
          <h3 class="text-sm font-semibold text-gray-300">📰 相關新聞</h3>
          <div v-if="reportData.news.length === 0" class="text-xs text-gray-500">近期無相關新聞</div>
          <div v-for="(n, i) in reportData.news" :key="i" class="border-b border-gray-800 pb-2 last:border-0 last:pb-0">
            <p class="text-sm text-gray-200">{{ n.title }}</p>
            <p class="text-xs text-gray-600 mt-0.5">{{ n.time }}</p>
          </div>
        </div>

      </div>
    </div>

    <!-- ── 上市櫃漲跌家數 Tab ── -->
    <div v-if="tab === 'breadth'" class="max-w-3xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-base font-bold text-white">📊 漲跌幅分布</h2>
          <p class="text-xs text-gray-600 mt-0.5">TWSE 上市 + TPEX 上櫃　每 5 分鐘更新</p>
        </div>
        <div class="flex gap-2">
          <button @click="loadMarketDist(); loadMarketBreadth()"
                  class="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition">
            {{ distLoading ? '載入中...' : '重新整理' }}
          </button>
          <button @click="manualSyncBreadth"
                  class="px-3 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition">
            手動存檔
          </button>
        </div>
      </div>

      <p v-if="distError" class="text-red-400 text-sm">{{ distError }}</p>
      <p v-if="breadthError" class="text-red-400 text-sm">{{ breadthError }}</p>

      <!-- ── 漲跌幅分布圖 ── -->
      <div v-if="distData" class="rounded-2xl border border-gray-800 bg-gray-900 p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold text-gray-300">漲跌幅分布圖</h3>
          <div class="flex items-center gap-4 text-xs text-gray-500">
            <span>上市 <span class="text-gray-300 font-mono">{{ distData.total.twse }}</span> 檔</span>
            <span>上櫃 <span class="text-gray-300 font-mono">{{ distData.total.tpex }}</span> 檔</span>
            <span class="text-gray-600">{{ distData.updatedAt }}</span>
          </div>
        </div>

        <!-- 欄位標題 -->
        <div class="grid items-center gap-x-2 mb-2 px-1 text-xs text-gray-600"
             style="grid-template-columns: 56px 1fr 36px 1fr 36px">
          <span class="text-right">漲跌幅</span>
          <span class="text-center">上市</span>
          <span></span>
          <span class="text-center">上櫃</span>
          <span></span>
        </div>

        <!-- 每個區間 -->
        <div class="space-y-1">
          <div v-for="b in distData.buckets" :key="b.key"
               class="grid items-center gap-x-2"
               style="grid-template-columns: 56px 1fr 36px 1fr 36px">
            <!-- 標籤 -->
            <span class="text-xs font-mono text-right pr-1 shrink-0"
                  :class="b.key === 'limit_up'   ? 'text-red-400 font-bold' :
                          b.key === 'limit_down'  ? 'text-emerald-400 font-bold' :
                          b.key === 'flat'        ? 'text-gray-500' :
                          b.side === 'up'         ? 'text-red-300' : 'text-green-400'">
              {{ b.label }}
            </span>
            <!-- TWSE 條 -->
            <div class="h-5 bg-gray-800 rounded-sm overflow-hidden relative">
              <div class="h-full rounded-sm"
                   :style="{ width: distMaxCount > 0 ? `${(b.twse / distMaxCount * 100).toFixed(1)}%` : '0%' }"
                   :class="b.key === 'limit_up'   ? 'bg-red-500' :
                           b.key === 'limit_down'  ? 'bg-emerald-600' :
                           b.key === 'flat'        ? 'bg-gray-600' :
                           b.side === 'up'         ? 'bg-red-500/65' : 'bg-emerald-500/65'">
              </div>
            </div>
            <span class="text-xs font-mono text-right text-gray-400">{{ b.twse }}</span>
            <!-- TPEX 條 -->
            <div class="h-5 bg-gray-800 rounded-sm overflow-hidden">
              <div class="h-full rounded-sm"
                   :style="{ width: distMaxCount > 0 ? `${(b.tpex / distMaxCount * 100).toFixed(1)}%` : '0%' }"
                   :class="b.key === 'limit_up'   ? 'bg-red-500' :
                           b.key === 'limit_down'  ? 'bg-emerald-600' :
                           b.key === 'flat'        ? 'bg-gray-600' :
                           b.side === 'up'         ? 'bg-red-500/65' : 'bg-emerald-500/65'">
              </div>
            </div>
            <span class="text-xs font-mono text-right text-gray-400">{{ b.tpex }}</span>
          </div>
        </div>

        <!-- 摘要列 -->
        <div class="mt-4 pt-3 border-t border-gray-800 grid grid-cols-2 gap-3">
          <div class="text-center">
            <div class="text-xs text-gray-600 mb-1">上市 漲/跌/停</div>
            <div class="text-sm font-mono">
              <span class="text-red-400">{{ distData.buckets.filter(b=>b.side==='up').reduce((s,b)=>s+b.twse,0) }}</span>
              <span class="text-gray-600 mx-1">/</span>
              <span class="text-emerald-400">{{ distData.buckets.filter(b=>b.side==='down').reduce((s,b)=>s+b.twse,0) }}</span>
              <span class="text-gray-600 mx-1">/</span>
              <span class="text-gray-400">{{ distData.buckets.find(b=>b.key==='limit_up')?.twse }}/{{ distData.buckets.find(b=>b.key==='limit_down')?.twse }}</span>
            </div>
          </div>
          <div class="text-center">
            <div class="text-xs text-gray-600 mb-1">上櫃 漲/跌/停</div>
            <div class="text-sm font-mono">
              <span class="text-red-400">{{ distData.buckets.filter(b=>b.side==='up').reduce((s,b)=>s+b.tpex,0) }}</span>
              <span class="text-gray-600 mx-1">/</span>
              <span class="text-emerald-400">{{ distData.buckets.filter(b=>b.side==='down').reduce((s,b)=>s+b.tpex,0) }}</span>
              <span class="text-gray-600 mx-1">/</span>
              <span class="text-gray-400">{{ distData.buckets.find(b=>b.key==='limit_up')?.tpex }}/{{ distData.buckets.find(b=>b.key==='limit_down')?.tpex }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="!distLoading" class="text-center text-gray-600 text-sm py-8">
        點擊「重新整理」載入分布圖
      </div>
      <div v-else class="text-center text-gray-500 text-sm py-8">載入分布資料中...</div>

      <!-- ── 歷史漲跌家數（DB存檔）── -->
      <div v-if="!breadthRows.length && !breadthLoading" class="text-center text-gray-700 text-xs py-2">
        尚無歷史存檔，點「手動存檔」可儲存今日資料
      </div>

      <div v-if="breadthRows.length" class="space-y-4">

        <!-- 最新一天大卡 -->
        <div class="rounded-2xl border border-blue-900 bg-gray-900 p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-blue-300">最新統計</h3>
            <span class="text-xs text-gray-500 font-mono">{{ breadthRows[0].trade_date?.slice(0,10) }}</span>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <!-- 上市 -->
            <div class="bg-gray-800 rounded-xl p-4 space-y-3">
              <div class="text-xs text-gray-500 font-semibold uppercase tracking-wide">TWSE 上市</div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div class="text-xs text-gray-500 mb-1">上漲</div>
                  <div class="text-xl font-bold text-red-400">{{ breadthRows[0].twse_up }}</div>
                  <div v-if="breadthRows[0].twse_up_limit" class="text-xs text-red-600 mt-0.5">
                    含漲停 {{ breadthRows[0].twse_up_limit }}
                  </div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">持平</div>
                  <div class="text-xl font-bold text-gray-400">{{ breadthRows[0].twse_flat }}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">下跌</div>
                  <div class="text-xl font-bold text-green-400">{{ breadthRows[0].twse_down }}</div>
                  <div v-if="breadthRows[0].twse_down_limit" class="text-xs text-green-700 mt-0.5">
                    含跌停 {{ breadthRows[0].twse_down_limit }}
                  </div>
                </div>
              </div>
              <div class="text-center text-xs font-mono font-bold pt-1 border-t border-gray-700"
                   :class="breadthRows[0].twse_up > breadthRows[0].twse_down ? 'text-red-400' : breadthRows[0].twse_up < breadthRows[0].twse_down ? 'text-green-400' : 'text-gray-400'">
                淨差 {{ breadthRows[0].twse_up - breadthRows[0].twse_down > 0 ? '+' : '' }}{{ breadthRows[0].twse_up - breadthRows[0].twse_down }}
              </div>
            </div>

            <!-- 上櫃 -->
            <div class="bg-gray-800 rounded-xl p-4 space-y-3">
              <div class="text-xs text-gray-500 font-semibold uppercase tracking-wide">TPEX 上櫃</div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div class="text-xs text-gray-500 mb-1">上漲</div>
                  <div class="text-xl font-bold text-red-400">{{ breadthRows[0].tpex_up }}</div>
                  <div v-if="breadthRows[0].tpex_up_limit" class="text-xs text-red-600 mt-0.5">
                    含漲停 {{ breadthRows[0].tpex_up_limit }}
                  </div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">持平</div>
                  <div class="text-xl font-bold text-gray-400">{{ breadthRows[0].tpex_flat }}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 mb-1">下跌</div>
                  <div class="text-xl font-bold text-green-400">{{ breadthRows[0].tpex_down }}</div>
                  <div v-if="breadthRows[0].tpex_down_limit" class="text-xs text-green-700 mt-0.5">
                    含跌停 {{ breadthRows[0].tpex_down_limit }}
                  </div>
                </div>
              </div>
              <div class="text-center text-xs font-mono font-bold pt-1 border-t border-gray-700"
                   :class="breadthRows[0].tpex_up > breadthRows[0].tpex_down ? 'text-red-400' : breadthRows[0].tpex_up < breadthRows[0].tpex_down ? 'text-green-400' : 'text-gray-400'">
                淨差 {{ breadthRows[0].tpex_up - breadthRows[0].tpex_down > 0 ? '+' : '' }}{{ breadthRows[0].tpex_up - breadthRows[0].tpex_down }}
              </div>
            </div>
          </div>
        </div>

        <!-- 歷史趨勢表 -->
        <div class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
          <div class="px-5 py-3 border-b border-gray-800">
            <h3 class="text-sm font-semibold text-gray-300">歷史記錄（最近 {{ breadthRows.length }} 天）</h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-gray-500 border-b border-gray-800 bg-gray-900/80">
                <tr>
                  <th class="px-4 py-3 text-left">日期</th>
                  <th class="px-4 py-3 text-right text-red-400">上市↑</th>
                  <th class="px-4 py-3 text-center text-gray-500">—</th>
                  <th class="px-4 py-3 text-right text-green-400">上市↓</th>
                  <th class="px-4 py-3 text-right font-bold">上市淨差</th>
                  <th class="px-4 py-3 text-right text-red-400">上櫃↑</th>
                  <th class="px-4 py-3 text-center text-gray-500">—</th>
                  <th class="px-4 py-3 text-right text-green-400">上櫃↓</th>
                  <th class="px-4 py-3 text-right font-bold">上櫃淨差</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="row in breadthRows" :key="row.trade_date" class="hover:bg-gray-800/40 transition">
                  <td class="px-4 py-2 font-mono text-gray-400">{{ row.trade_date?.slice(0,10) }}</td>
                  <td class="px-4 py-2 text-right text-red-400 font-mono">
                    {{ row.twse_up }}<span v-if="row.twse_up_limit" class="text-red-700 text-xs">（{{ row.twse_up_limit }}）</span>
                  </td>
                  <td class="px-4 py-2 text-center text-gray-500 font-mono">{{ row.twse_flat }}</td>
                  <td class="px-4 py-2 text-right text-green-400 font-mono">
                    {{ row.twse_down }}<span v-if="row.twse_down_limit" class="text-green-700 text-xs">（{{ row.twse_down_limit }}）</span>
                  </td>
                  <td class="px-4 py-2 text-right font-mono font-bold"
                      :class="row.twse_up - row.twse_down > 0 ? 'text-red-400' : row.twse_up - row.twse_down < 0 ? 'text-green-400' : 'text-gray-500'">
                    {{ row.twse_up - row.twse_down > 0 ? '+' : '' }}{{ row.twse_up - row.twse_down }}
                  </td>
                  <td class="px-4 py-2 text-right text-red-400 font-mono">
                    {{ row.tpex_up }}<span v-if="row.tpex_up_limit" class="text-red-700 text-xs">（{{ row.tpex_up_limit }}）</span>
                  </td>
                  <td class="px-4 py-2 text-center text-gray-500 font-mono">{{ row.tpex_flat }}</td>
                  <td class="px-4 py-2 text-right text-green-400 font-mono">
                    {{ row.tpex_down }}<span v-if="row.tpex_down_limit" class="text-green-700 text-xs">（{{ row.tpex_down_limit }}）</span>
                  </td>
                  <td class="px-4 py-2 text-right font-mono font-bold"
                      :class="row.tpex_up - row.tpex_down > 0 ? 'text-red-400' : row.tpex_up - row.tpex_down < 0 ? 'text-green-400' : 'text-gray-500'">
                    {{ row.tpex_up - row.tpex_down > 0 ? '+' : '' }}{{ row.tpex_up - row.tpex_down }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>

    <!-- ── 台指期籌碼 Tab ── -->
    <div v-if="tab === 'chips'" class="max-w-4xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-base font-bold text-white">📊 台指期籌碼快訊</h2>
          <p class="text-xs text-gray-600 mt-0.5">三大法人台指期未平倉　每日 15:30 自動更新</p>
        </div>
        <div class="flex gap-2">
          <button @click="loadFuturesChips"
                  class="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition">
            {{ chipsLoading ? '載入中...' : '重新整理' }}
          </button>
          <button @click="manualSyncChips"
                  class="px-3 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition">
            手動同步
          </button>
        </div>
      </div>

      <p v-if="chipsError" class="text-red-400 text-sm">{{ chipsError }}</p>

      <div v-if="!chipsRows.length && !chipsLoading" class="text-center text-gray-600 text-sm py-12">
        點擊「重新整理」載入資料，或「手動同步」從 TAIFEX 抓取最新籌碼
      </div>

      <!-- 最新一天大卡 -->
      <div v-if="chipsRows.length" class="space-y-4">
        <div class="rounded-2xl border border-blue-900 bg-gray-900 p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-blue-300">最新籌碼</h3>
            <span class="text-xs text-gray-500 font-mono">{{ chipsRows[0].trade_date?.slice(0,10) }}</span>
          </div>

          <!-- 三大法人未平倉 -->
          <div class="grid grid-cols-3 gap-3 mb-4">
            <div v-for="item in [
              { label:'外資未平倉', net: chipsRows[0].foreign_tx_net, long: chipsRows[0].foreign_tx_long, short: chipsRows[0].foreign_tx_short },
              { label:'投信未平倉', net: chipsRows[0].trust_tx_net,   long: chipsRows[0].trust_tx_long,   short: chipsRows[0].trust_tx_short },
              { label:'自營商未平倉', net: chipsRows[0].dealer_tx_net, long: chipsRows[0].dealer_tx_long, short: chipsRows[0].dealer_tx_short },
            ]" :key="item.label" class="bg-gray-800 rounded-xl p-4 text-center space-y-1">
              <div class="text-xs text-gray-500">{{ item.label }}</div>
              <div class="text-xl font-bold font-mono" :class="chipsNetColor(item.net)">
                {{ chipsNetSign(item.net) }}
              </div>
              <div class="text-xs text-gray-600 font-mono">
                多 {{ (+item.long).toLocaleString() }}　空 {{ (+item.short).toLocaleString() }}
              </div>
            </div>
          </div>

          <!-- 三大法人現貨買賣超 -->
          <div v-if="chipsRows[0].inst_foreign_net_amt || chipsRows[0].inst_trust_net_amt || chipsRows[0].inst_dealer_net_amt"
               class="grid grid-cols-3 gap-3 mb-4">
            <div v-for="item in [
              { label:'外資現貨買賣超', amt: chipsRows[0].inst_foreign_net_amt },
              { label:'投信現貨買賣超', amt: chipsRows[0].inst_trust_net_amt },
              { label:'自營現貨買賣超', amt: chipsRows[0].inst_dealer_net_amt },
            ]" :key="item.label" class="bg-gray-800 rounded-xl p-3 text-center space-y-1">
              <div class="text-xs text-gray-500">{{ item.label }}</div>
              <div class="text-base font-bold font-mono"
                   :class="+item.amt > 0 ? 'text-green-400' : +item.amt < 0 ? 'text-red-400' : 'text-gray-500'">
                {{ +item.amt > 0 ? '+' : '' }}{{ (+item.amt / 1e8).toFixed(1) }} 億
              </div>
            </div>
          </div>

          <!-- 大額交易人 + OI -->
          <div class="grid grid-cols-3 gap-3">
            <div class="bg-gray-800 rounded-xl p-3 text-center">
              <div class="text-xs text-gray-500 mb-1">大額前5名集中度</div>
              <div class="text-sm font-mono text-white">
                多 {{ (+chipsRows[0].large_top5_long).toLocaleString() }}
                <span class="text-gray-600 mx-1">/</span>
                空 {{ (+chipsRows[0].large_top5_short).toLocaleString() }}
              </div>
            </div>
            <div class="bg-gray-800 rounded-xl p-3 text-center">
              <div class="text-xs text-gray-500 mb-1">大額前10名集中度</div>
              <div class="text-sm font-mono text-white">
                多 {{ (+chipsRows[0].large_top10_long).toLocaleString() }}
                <span class="text-gray-600 mx-1">/</span>
                空 {{ (+chipsRows[0].large_top10_short).toLocaleString() }}
              </div>
            </div>
            <div class="bg-gray-800 rounded-xl p-3 text-center">
              <div class="text-xs text-gray-500 mb-1">全市場未平倉</div>
              <div class="text-sm font-mono text-yellow-400 font-bold">
                {{ (+chipsRows[0].oi_market).toLocaleString() }} 口
              </div>
            </div>
          </div>

          <!-- P/C Ratio -->
          <div v-if="chipsRows[0].pc_volume_ratio" class="mt-3 flex gap-3">
            <div class="flex-1 bg-gray-800 rounded-xl p-3 text-center">
              <div class="text-xs text-gray-500 mb-1">P/C 成交比</div>
              <div class="text-base font-mono font-bold"
                   :class="+chipsRows[0].pc_volume_ratio > 100 ? 'text-green-400' : 'text-red-400'">
                {{ chipsRows[0].pc_volume_ratio }}%
              </div>
            </div>
            <div class="flex-1 bg-gray-800 rounded-xl p-3 text-center">
              <div class="text-xs text-gray-500 mb-1">P/C 未平倉比</div>
              <div class="text-base font-mono font-bold"
                   :class="+chipsRows[0].pc_oi_ratio > 100 ? 'text-green-400' : 'text-red-400'">
                {{ chipsRows[0].pc_oi_ratio }}%
              </div>
            </div>
          </div>
        </div>

        <!-- 歷史趨勢表 -->
        <div class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
          <div class="px-5 py-3 border-b border-gray-800">
            <h3 class="text-sm font-semibold text-gray-300">歷史籌碼趨勢（最近 {{ chipsRows.length }} 天）</h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-gray-500 border-b border-gray-800 bg-gray-900/80">
                <tr>
                  <th class="px-4 py-3 text-left">日期</th>
                  <th class="px-4 py-3 text-right">外資淨口</th>
                  <th class="px-4 py-3 text-right">投信淨口</th>
                  <th class="px-4 py-3 text-right">自營淨口</th>
                  <th class="px-4 py-3 text-right">三大合計</th>
                  <th class="px-4 py-3 text-right">OI市場</th>
                  <th class="px-4 py-3 text-right">P/C成交</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="row in chipsRows" :key="row.trade_date" class="hover:bg-gray-800/40 transition">
                  <td class="px-4 py-2 font-mono text-gray-400">{{ row.trade_date?.slice(0,10) }}</td>
                  <td class="px-4 py-2 text-right font-mono font-semibold" :class="row.foreign_tx_net != 0 ? chipsNetColor(row.foreign_tx_net) : 'text-gray-700'">
                    {{ row.foreign_tx_net != 0 ? chipsNetSign(row.foreign_tx_net) : '—' }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono font-semibold" :class="row.trust_tx_net != 0 ? chipsNetColor(row.trust_tx_net) : 'text-gray-700'">
                    {{ row.trust_tx_net != 0 ? chipsNetSign(row.trust_tx_net) : '—' }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono font-semibold" :class="row.dealer_tx_net != 0 ? chipsNetColor(row.dealer_tx_net) : 'text-gray-700'">
                    {{ row.dealer_tx_net != 0 ? chipsNetSign(row.dealer_tx_net) : '—' }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono font-bold"
                      :class="(row.foreign_tx_net == 0 && row.trust_tx_net == 0 && row.dealer_tx_net == 0) ? 'text-gray-700' : chipsNetColor(+row.foreign_tx_net + +row.trust_tx_net + +row.dealer_tx_net)">
                    {{ (row.foreign_tx_net == 0 && row.trust_tx_net == 0 && row.dealer_tx_net == 0) ? '—' : chipsNetSign(+row.foreign_tx_net + +row.trust_tx_net + +row.dealer_tx_net) }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-yellow-400">
                    {{ (+row.oi_market).toLocaleString() }}
                  </td>
                  <td class="px-4 py-2 text-right font-mono"
                      :class="row.pc_volume_ratio ? (+row.pc_volume_ratio > 100 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'">
                    {{ row.pc_volume_ratio ? row.pc_volume_ratio + '%' : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>

    <!-- ── 強勢族群 Tab ── -->
    <div v-if="tab === 'sector'" class="max-w-3xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-base font-bold text-white">🚀 強勢族群</h2>
          <p v-if="sectorData" class="text-xs text-gray-600 mt-0.5">
            {{ sectorData.date.slice(0,4) }}/{{ sectorData.date.slice(4,6) }}/{{ sectorData.date.slice(6,8) }}　成交量前 50 大個股
          </p>
        </div>
        <div class="flex items-center gap-2">
          <!-- 日期選單 -->
          <select v-model="sectorDateSel" @change="loadSectorAnalysis()"
                  class="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 min-w-[130px]">
            <option value="">今日（即時）</option>
            <option v-for="d in sectorDates" :key="d" :value="d">
              {{ d.slice(0,4) }}/{{ d.slice(4,6) }}/{{ d.slice(6,8) }}
            </option>
          </select>
          <button @click="loadSectorAnalysis()"
                  class="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition">
            {{ sectorLoading ? '載入中...' : '重新整理' }}
          </button>
        </div>
      </div>

      <p v-if="sectorError" class="text-red-400 text-sm">{{ sectorError }}</p>

      <div v-if="!sectorData && !sectorLoading" class="text-center text-gray-600 text-sm py-12">
        點擊「載入分析」取得今日強勢族群排行
      </div>

      <div v-if="sectorData" class="space-y-3">

        <!-- 前三名 -->
        <div v-for="(sec, idx) in sectorData.sectors.slice(0, 3)" :key="sec.name"
             class="rounded-2xl border p-5 space-y-3"
             :class="idx===0 ? 'border-yellow-700 bg-yellow-950/20' : idx===1 ? 'border-gray-500 bg-gray-800/40' : 'border-orange-800 bg-orange-950/10'">
          <div class="flex items-center justify-between">
            <span class="font-bold text-base" :class="idx===0 ? 'text-yellow-400' : idx===1 ? 'text-gray-200' : 'text-orange-400'">
              {{ ['🥇','🥈','🥉'][idx] }} {{ sec.name }}
            </span>
            <span class="text-lg font-mono font-bold" :class="sec.avgPct >= 0 ? 'text-red-400' : 'text-green-400'">
              {{ sec.avgPct >= 0 ? '▲' : '▼' }}{{ Math.abs(sec.avgPct).toFixed(2) }}%
            </span>
          </div>
          <div class="flex flex-wrap gap-2">
            <span v-for="s in sec.stocks" :key="s.no"
                  class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-900/80 border border-gray-800 text-xs">
              <span class="text-gray-500 font-mono">{{ s.no }}</span>
              <span class="text-gray-200">{{ s.name }}</span>
              <span class="font-mono" :class="s.pct >= 0 ? 'text-red-400' : 'text-green-400'">
                {{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(2) }}%
              </span>
            </span>
          </div>
        </div>

        <!-- 完整排行 -->
        <div class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
          <div class="px-5 py-3 border-b border-gray-800">
            <h3 class="text-sm font-semibold text-gray-300">所有族群排行（{{ sectorData.sectors.length }} 個族群）</h3>
          </div>
          <div class="divide-y divide-gray-800">
            <div v-for="(sec, idx) in sectorData.sectors" :key="sec.name">
              <!-- 族群列（可點擊展開） -->
              <div class="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-800/40 transition cursor-pointer select-none"
                   @click="toggleSector(sec.name)">
                <span class="text-gray-600 text-xs w-5 text-right shrink-0">{{ idx + 1 }}</span>
                <span class="text-gray-300 text-sm flex-1">{{ sec.name }}</span>
                <span class="text-gray-500 text-xs shrink-0">{{ sec.count }} 檔</span>
                <span class="font-mono text-sm font-bold w-20 text-right shrink-0"
                      :class="sec.avgPct >= 0 ? 'text-red-400' : 'text-green-400'">
                  {{ sec.avgPct >= 0 ? '▲' : '▼' }}{{ Math.abs(sec.avgPct).toFixed(2) }}%
                </span>
                <span class="text-gray-600 text-xs shrink-0">{{ sectorExpanded[sec.name] ? '▲' : '▼' }}</span>
              </div>
              <!-- 展開個股 -->
              <div v-if="sectorExpanded[sec.name]" class="px-5 pb-3 flex flex-wrap gap-2 bg-gray-800/20">
                <span v-for="s in sec.stocks" :key="s.no"
                      class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-900 border border-gray-700 text-xs">
                  <span class="text-gray-500 font-mono">{{ s.no }}</span>
                  <span class="text-gray-200">{{ s.name }}</span>
                  <span class="font-mono" :class="s.pct >= 0 ? 'text-red-400' : 'text-green-400'">
                    {{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(2) }}%
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── 大股東吃貨 Tab ── -->
    <!-- ── 台股選股系統 Tab ── -->
    <div v-if="tab === 'screener'" class="max-w-6xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-base font-bold text-white">🔍 台股選股系統</h2>
          <p class="text-xs text-gray-600 mt-0.5">
            法人籌碼主導選股・投信連買 ≥ 3 天・主力淨買為正・融資下降
            <span v-if="screenerRunDate" class="ml-2 text-gray-500">計算日期：{{ screenerRunDate }}・共 {{ screenerTotal }} 檔</span>
          </p>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <button @click="loadScreener()" :disabled="screenerLoading"
                  class="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm transition">
            {{ screenerLoading ? '載入中...' : '重新整理' }}
          </button>
          <button @click="manualRunScreener()" :disabled="screenerSyncing || screenerBackfilling"
                  class="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm transition">
            {{ screenerSyncing ? '計算中（約35秒）...' : '今日選股' }}
          </button>
          <button @click="backfillMarket()" :disabled="screenerBackfilling || screenerSyncing"
                  class="px-3 py-1.5 rounded-lg bg-blue-800 hover:bg-blue-700 text-sm transition">
            {{ screenerBackfilling ? '回填中（約90秒）...' : '回填20日歷史' }}
          </button>
        </div>
      </div>

      <p v-if="screenerError" class="text-red-400 text-sm">{{ screenerError }}</p>

      <!-- 個股跑分 -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4 space-y-3">
        <h3 class="text-sm font-semibold text-gray-300">🎯 個股跑分</h3>
        <div class="flex gap-2 items-center">
          <div class="relative">
            <input v-model="scoreStockNo" @input="onScoreInput" @keyup.enter="queryScore"
                   @blur="() => setTimeout(() => { scoreShowSuggestions.value = false }, 150)"
                   type="text" placeholder="代號或名稱"
                   class="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 w-44 focus:outline-none focus:border-blue-500" />
            <div v-if="scoreShowSuggestions && scoreSuggestions.length"
                 class="absolute z-50 top-full left-0 mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
              <div v-for="item in scoreSuggestions" :key="item.no"
                   @mousedown.prevent="selectScoreSuggestion(item)"
                   class="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 cursor-pointer text-sm">
                <span class="text-blue-400 font-mono w-12 shrink-0">{{ item.no }}</span>
                <span class="text-gray-200 truncate">{{ item.name }}</span>
              </div>
            </div>
          </div>
          <button @click="queryScore" :disabled="scoreLoading"
                  class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-sm transition disabled:opacity-50">
            {{ scoreLoading ? '計算中...' : '跑分' }}
          </button>
        </div>
        <p v-if="scoreError" class="text-red-400 text-sm">{{ scoreError }}</p>

        <!-- 結果卡片 -->
        <div v-if="scoreResult" class="space-y-3">
          <!-- 標題與分數 -->
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-white font-semibold">{{ scoreResult.stockName }} ({{ scoreResult.stockNo }})</span>
            <span v-if="scoreResult.pass"
                  class="px-3 py-1 rounded-full text-sm font-bold bg-green-500/20 text-green-400 border border-green-700">
              ✅ 通過篩選・評分 {{ scoreResult.score }}
            </span>
            <span v-else
                  class="px-3 py-1 rounded-full text-sm font-bold bg-red-500/20 text-red-400 border border-red-800">
              ❌ 未通過篩選
            </span>
          </div>

          <!-- 各關卡 -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <div v-for="c in scoreResult.checks" :key="c.label"
                 class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
                 :class="c.pass ? 'bg-green-900/20 border border-green-900/40' : 'bg-red-900/20 border border-red-900/40'">
              <span :class="c.pass ? 'text-green-400' : 'text-red-400'">{{ c.pass ? '✓' : '✗' }}</span>
              <span class="text-gray-300 flex-1">{{ c.label }}</span>
              <span class="text-gray-500 font-mono">{{ c.value }}</span>
            </div>
          </div>

          <!-- 分數明細（通過才顯示） -->
          <div v-if="scoreResult.pass && scoreResult.detail" class="bg-gray-800 rounded-lg px-4 py-3 space-y-2">
            <div class="text-xs font-semibold text-gray-400 mb-2">評分明細（滿分 100）</div>
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
              <div v-for="(val, key) in scoreResult.detail.scoreBreakdown" :key="key" class="bg-gray-700/50 rounded px-2 py-1.5">
                <div class="text-gray-500">{{ {trustScore:'投信連買',marginScore:'融資下降',posScore:'低位加分',majorScore:'主力買超',concScore:'大股東'}[key] }}</div>
                <div class="text-white font-bold font-mono">{{ val }}</div>
              </div>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mt-2">
              <div class="text-gray-500">主力5日淨 <span class="text-gray-200 font-mono">{{ scoreResult.detail.majorNet5?.toLocaleString() }} 張</span></div>
              <div class="text-gray-500">外資5日 <span class="text-gray-200 font-mono">{{ scoreResult.detail.foreignNet5?.toLocaleString() }} 張</span></div>
              <div class="text-gray-500">投信5日 <span class="text-gray-200 font-mono">{{ scoreResult.detail.trustNet5?.toLocaleString() }} 張</span></div>
              <div class="text-gray-500">投信連買 <span class="text-gray-200 font-mono">{{ scoreResult.detail.trustStreak }} 天</span></div>
              <div class="text-gray-500">融資5日變化 <span :class="(scoreResult.detail.marginChg5||0)<0?'text-green-400':'text-gray-200'" class="font-mono">{{ scoreResult.detail.marginChg5!=null?(scoreResult.detail.marginChg5>=0?'+':'')+scoreResult.detail.marginChg5+'張':'—' }}</span></div>
              <div class="text-gray-500">20日價位 <span class="text-gray-200 font-mono">{{ scoreResult.detail.closeRank }}%</span></div>
              <div class="text-gray-500">5日漲幅 <span class="text-gray-200 font-mono">{{ scoreResult.detail.chg5d }}%</span></div>
              <div class="text-gray-500">量比 <span class="text-gray-200 font-mono">{{ scoreResult.detail.volRatio }}x</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 階段說明 -->
      <div class="flex flex-wrap gap-2 text-xs">
        <template v-for="(meta, key) in PHASE_META" :key="key">
          <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full border" :class="meta.cls">
            {{ meta.label }}
          </div>
        </template>
        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-cyan-700 bg-cyan-500/10 text-cyan-400">
          🕵️ 隱形布局
        </div>
      </div>

      <!-- 選股邏輯說明 -->
      <div class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
        <button @click="screenerLogicOpen = !screenerLogicOpen"
                class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-800/40 transition">
          <span class="text-sm font-semibold text-gray-300">📋 選股邏輯說明</span>
          <span class="text-gray-500 text-xs">{{ screenerLogicOpen ? '收起 ▲' : '展開 ▼' }}</span>
        </button>
        <div v-if="screenerLogicOpen" class="border-t border-gray-800 divide-y divide-gray-800/60">

          <!-- 一、篩選條件 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">一、篩選條件（全部須同時成立）</h4>
            <ol class="space-y-2.5 text-sm">
              <li class="flex gap-3">
                <span class="shrink-0 text-blue-400 font-bold w-5 text-right">1.</span>
                <div>
                  <span class="text-white font-medium">投信連續買超 ≥ 3 天</span>
                  <ul class="mt-1 space-y-0.5 text-xs text-gray-500">
                    <li>• 投信（國內基金法人）連續 N 個交易日淨買超股數 &gt; 0</li>
                    <li>• 排除偶發性單日買入；法人連續加碼才視為有效訊號</li>
                    <li>• 連買天數越多，評分越高（最高 30 分）</li>
                  </ul>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="shrink-0 text-blue-400 font-bold w-5 text-right">2.</span>
                <div>
                  <span class="text-white font-medium">主力近 5 日淨買合計 &gt; 0</span>
                  <ul class="mt-1 space-y-0.5 text-xs text-gray-500">
                    <li>• 主力 = 外資 + 投信，合計近 5 個交易日的淨買超張數</li>
                    <li>• 過濾「投信獨買但外資同步大賣」的情況，確保整體法人方向一致</li>
                  </ul>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="shrink-0 text-blue-400 font-bold w-5 text-right">3.</span>
                <div>
                  <span class="text-white font-medium">融資餘額近 5 日未增加</span>
                  <ul class="mt-1 space-y-0.5 text-xs text-gray-500">
                    <li>• 融資餘額（5日前 → 最新）差值 ≤ 0 才通過</li>
                    <li>• 融資增加 = 散戶借錢追高，代表股票已被注意，不是低調布局期</li>
                    <li>• 無融資資料的股票（如 KY 股）直接通過此條件</li>
                  </ul>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="shrink-0 text-blue-400 font-bold w-5 text-right">4.</span>
                <div>
                  <span class="text-white font-medium">股價位置 &lt; 近 20 日高點 90%</span>
                  <ul class="mt-1 space-y-0.5 text-xs text-gray-500">
                    <li>• 位置 = (收盤 − 20日最低) ÷ (20日最高 − 20日最低)</li>
                    <li>• 位置 ≥ 90% 表示已接近近期高點，追高風險高，排除</li>
                    <li>• 位置欄顯示 0%（最低）至 100%（最高）</li>
                  </ul>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="shrink-0 text-blue-400 font-bold w-5 text-right">5.</span>
                <div>
                  <span class="text-white font-medium">無急漲、無漲跌停、無爆量</span>
                  <ul class="mt-1 space-y-0.5 text-xs text-gray-500">
                    <li>• 當日漲跌幅 &lt; ±7%（排除漲跌停附近的異常波動）</li>
                    <li>• 近 5 日漲幅 &lt; 5%（排除短期急漲已引爆的標的）</li>
                    <li>• 今日成交量 &lt; 近 20 日均量 × 3（排除爆量換手）</li>
                  </ul>
                </div>
              </li>
            </ol>
          </div>

          <!-- 二、評分方式 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">二、評分方式（滿分 100 分）</h4>
            <div class="space-y-2 text-sm">
              <div class="flex items-baseline gap-3">
                <span class="shrink-0 text-orange-400 font-bold text-base w-10 text-right">30</span>
                <div class="flex-1">
                  <span class="text-white font-medium">投信連買天數</span>
                  <span class="ml-2 text-xs text-gray-500">min(連買天數 ÷ 7, 1) × 30，連買 7 天以上拿滿分</span>
                </div>
              </div>
              <div class="flex items-baseline gap-3">
                <span class="shrink-0 text-orange-400 font-bold text-base w-10 text-right">25</span>
                <div class="flex-1">
                  <span class="text-white font-medium">主力強度（相對排名）</span>
                  <span class="ml-2 text-xs text-gray-500">外資+投信近5日淨買，依當日全部候選股排名正規化至 0–25 分</span>
                </div>
              </div>
              <div class="flex items-baseline gap-3">
                <span class="shrink-0 text-orange-400 font-bold text-base w-10 text-right">20</span>
                <div class="flex-1">
                  <span class="text-white font-medium">融資下降幅度</span>
                  <span class="ml-2 text-xs text-gray-500">融資降越多（相對基期）得分越高；無融資資料預設 10 分</span>
                </div>
              </div>
              <div class="flex items-baseline gap-3">
                <span class="shrink-0 text-orange-400 font-bold text-base w-10 text-right">15</span>
                <div class="flex-1">
                  <span class="text-white font-medium">法人持續加碼（集中度）</span>
                  <span class="ml-2 text-xs text-gray-500">連續 ≥5 天外資+投信合計均為正：+15 分；≥3 天：+8 分</span>
                </div>
              </div>
              <div class="flex items-baseline gap-3">
                <span class="shrink-0 text-orange-400 font-bold text-base w-10 text-right">10</span>
                <div class="flex-1">
                  <span class="text-white font-medium">股價低位加分</span>
                  <span class="ml-2 text-xs text-gray-500">位置 &lt; 30%：+10 分；30–60%：+5 分；60% 以上：0 分</span>
                </div>
              </div>
            </div>
            <div class="mt-3 grid grid-cols-4 text-xs text-center gap-1">
              <div class="rounded-lg bg-gray-700/50 px-2 py-1.5"><span class="text-red-400 font-bold">≥ 80</span><div class="text-gray-500 mt-0.5">強力訊號</div></div>
              <div class="rounded-lg bg-gray-700/50 px-2 py-1.5"><span class="text-orange-400 font-bold">65–79</span><div class="text-gray-500 mt-0.5">值得關注</div></div>
              <div class="rounded-lg bg-gray-700/50 px-2 py-1.5"><span class="text-yellow-400 font-bold">50–64</span><div class="text-gray-500 mt-0.5">觀察中</div></div>
              <div class="rounded-lg bg-gray-700/50 px-2 py-1.5"><span class="text-gray-400 font-bold">&lt; 50</span><div class="text-gray-500 mt-0.5">一般</div></div>
            </div>
          </div>

          <!-- 三、階段分類 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">三、股票階段分類</h4>
            <div class="space-y-2 text-sm">
              <div class="flex gap-3 items-start">
                <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-blue-700 bg-blue-500/20 text-blue-400 font-bold mt-0.5">A 吸籌</span>
                <ul class="text-xs text-gray-500 space-y-0.5">
                  <li>• 投信連買 ≥ 5 天</li>
                  <li>• 近 5 日漲幅 &lt; 2%（股價幾乎不動）</li>
                  <li>• 位置 &lt; 45%（在低檔區間）</li>
                  <li class="text-blue-400/70">→ 最理想：主力低調在低位慢慢收貨，尚未引起市場注意</li>
                </ul>
              </div>
              <div class="flex gap-3 items-start">
                <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-purple-700 bg-purple-500/20 text-purple-400 font-bold mt-0.5">B 洗盤</span>
                <ul class="text-xs text-gray-500 space-y-0.5">
                  <li>• 融資餘額快速下降（5日降幅大）</li>
                  <li>• 近 5 日股價下跌</li>
                  <li class="text-purple-400/70">→ 主力透過拉回震出融資散戶，籌碼集中中，下跌是假象</li>
                </ul>
              </div>
              <div class="flex gap-3 items-start">
                <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-orange-700 bg-orange-500/20 text-orange-400 font-bold mt-0.5">C 發動</span>
                <ul class="text-xs text-gray-500 space-y-0.5">
                  <li>• 近 5 日漲幅 1–5%（開始緩漲）</li>
                  <li>• 融資持續下降或持平</li>
                  <li>• 位置在 30–70% 之間</li>
                  <li class="text-orange-400/70">→ 主力開始主動拉抬，量縮價穩後轉為量增價漲的發動前期</li>
                </ul>
              </div>
              <div class="flex gap-3 items-start">
                <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-red-700 bg-red-500/20 text-red-400 font-bold mt-0.5">D 主升</span>
                <ul class="text-xs text-gray-500 space-y-0.5">
                  <li>• 通過篩選但不符合 A/B/C 條件</li>
                  <li class="text-red-400/70">→ 可能已進入拉升初期，需注意位置和成交量，風險較高</li>
                </ul>
              </div>
            </div>
          </div>

          <!-- 四、隱形布局 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">四、隱形布局 🕵️ 特殊標記</h4>
            <p class="text-xs text-gray-500 mb-2">同時滿足以下三點時，該股標記為「隱形布局」並以青藍色底色顯示：</p>
            <ul class="space-y-1.5 text-xs text-gray-400">
              <li class="flex gap-2"><span class="text-cyan-400 shrink-0">①</span>投信連續買超 ≥ 3 天（法人持續進場）</li>
              <li class="flex gap-2"><span class="text-cyan-400 shrink-0">②</span>近 5 日股價漲幅 &lt; 1.5%（股價被壓住，未引發市場追漲）</li>
              <li class="flex gap-2"><span class="text-cyan-400 shrink-0">③</span>融資餘額近 5 日下降（散戶在賣，主力在收）</li>
            </ul>
            <p class="mt-2 text-xs text-cyan-500/70 leading-relaxed">
              意義：法人連續進場但股價不漲 → 主力刻意壓價收貨，避免引起散戶跟風。籌碼快速向主力集中，待收貨完畢後往往快速啟動。隱形布局通常是 A 階段（吸籌）的強化版。
            </p>
          </div>

          <!-- 五、進場時機判斷 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">五、進場時機判斷</h4>
            <div class="space-y-3 text-sm">

              <!-- 各階段進場邏輯 -->
              <div class="space-y-2">
                <div class="flex gap-3 items-start">
                  <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-blue-700 bg-blue-500/20 text-blue-400 font-bold mt-0.5">A 吸籌</span>
                  <ul class="text-xs text-gray-500 space-y-0.5">
                    <li>• 位置 &lt; 30% + 連買 ≥ 5 天 + 🕵️隱形布局 → <span class="text-green-400 font-medium">可小量試單（資金 ≤ 5%）</span></li>
                    <li>• 位置 30–50% + 連買 ≥ 3 天 → <span class="text-blue-400 font-medium">列入觀察，等量溫和放大後進場</span></li>
                    <li>• 位置 &gt; 50% → 暫不追入，等回落至低位再評估</li>
                    <li class="text-gray-600 mt-1">停損設定：跌破近 10 日最低點即出場</li>
                  </ul>
                </div>
                <div class="flex gap-3 items-start">
                  <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-purple-700 bg-purple-500/20 text-purple-400 font-bold mt-0.5">B 洗盤</span>
                  <ul class="text-xs text-gray-500 space-y-0.5">
                    <li>• 股價仍在下跌中 → <span class="text-gray-400 font-medium">勿進場，等止穩訊號</span></li>
                    <li>• 股價止穩（連續 2–3 天不破低）且融資仍降 → <span class="text-yellow-400 font-medium">可小量試探</span></li>
                    <li>• 出現量縮紅 K 突破短期壓力 → 確認洗盤結束，可加碼</li>
                    <li class="text-gray-600 mt-1">停損設定：再跌破洗盤低點立即出場</li>
                  </ul>
                </div>
                <div class="flex gap-3 items-start">
                  <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-orange-700 bg-orange-500/20 text-orange-400 font-bold mt-0.5">C 發動</span>
                  <ul class="text-xs text-gray-500 space-y-0.5">
                    <li>• 位置 &lt; 50% + 量溫和放大（非爆量）→ <span class="text-orange-400 font-medium">可跟進，順勢操作</span></li>
                    <li>• 位置 50–70% → 謹慎跟進，等回測確認支撐後再進</li>
                    <li>• 位置 &gt; 70% → 追高風險高，等明顯回測後再評估</li>
                    <li class="text-gray-600 mt-1">停損設定：跌破 5 日均線或進場價 -5%</li>
                  </ul>
                </div>
                <div class="flex gap-3 items-start">
                  <span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-red-700 bg-red-500/20 text-red-400 font-bold mt-0.5">D 主升</span>
                  <ul class="text-xs text-gray-500 space-y-0.5">
                    <li>• 籌碼訊號仍佳但位置偏高 → <span class="text-red-400 font-medium">追高風險大，不建議追入</span></li>
                    <li>• 等出現 -5% 至 -8% 量縮回測，確認支撐後可小量介入</li>
                    <li class="text-gray-600 mt-1">停損設定：跌破回測低點即出場</li>
                  </ul>
                </div>
              </div>

              <!-- 進場前技術確認 -->
              <div class="rounded-xl bg-gray-800/40 px-4 py-3 space-y-1.5 text-xs">
                <p class="text-gray-300 font-medium mb-1">進場前技術面確認（自行查圖）</p>
                <div class="flex gap-2"><span class="text-gray-600 shrink-0">✓</span><span class="text-gray-400">日線圖：股價在 20 日均線附近或以上（不在均線跌破後的下降通道中）</span></div>
                <div class="flex gap-2"><span class="text-gray-600 shrink-0">✓</span><span class="text-gray-400">成交量：法人買入當天有量，但未超過均量 3 倍（過量代表換手，非布局）</span></div>
                <div class="flex gap-2"><span class="text-gray-600 shrink-0">✓</span><span class="text-gray-400">K 線型態：最近 2–3 天無連續長黑，且未在明顯下降趨勢中</span></div>
                <div class="flex gap-2"><span class="text-gray-600 shrink-0">✓</span><span class="text-gray-400">大盤環境：加權指數未在重要支撐下方，避免系統性下跌中進場</span></div>
              </div>

              <!-- 停利時機 -->
              <div class="rounded-xl bg-gray-800/40 px-4 py-3 space-y-1.5 text-xs">
                <p class="text-gray-300 font-medium mb-1">停利時機（出場訊號）</p>
                <div class="flex gap-2"><span class="text-red-500 shrink-0">→</span><span class="text-gray-400">投信從連買轉為連賣 2 天以上：主力開始出貨，分批減碼</span></div>
                <div class="flex gap-2"><span class="text-red-500 shrink-0">→</span><span class="text-red-400/80">融資餘額突然大增（散戶跟進）+ 股價快速拉高：主力出貨時機，開始分批獲利了結</span></div>
                <div class="flex gap-2"><span class="text-red-500 shrink-0">→</span><span class="text-gray-400">成交量爆量（&gt; 均量 5 倍）+ 股價未再創高：量價背離，注意出貨風險</span></div>
                <div class="flex gap-2"><span class="text-yellow-500 shrink-0">→</span><span class="text-gray-400">股價已漲 20–30% 以上：無論訊號如何，建議分批獲利了結部分部位</span></div>
              </div>

            </div>
          </div>

          <!-- 六、主力成本區 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">六、主力成本區計算說明</h4>
            <div class="space-y-3 text-sm">

              <div class="space-y-1.5 text-xs text-gray-400">
                <p class="text-gray-300 font-medium">計算公式</p>
                <div class="rounded-xl bg-gray-800/60 px-4 py-3 font-mono text-xs text-yellow-300 leading-relaxed">
                  主力成本 = Σ（每日收盤價 × 當日主力淨買超量）÷ Σ（當日主力淨買超量）
                </div>
                <ul class="space-y-1 mt-2">
                  <li class="flex gap-2"><span class="text-gray-600 shrink-0">•</span>主力 = 外資 + 投信，取兩者每日淨買超股數合計</li>
                  <li class="flex gap-2"><span class="text-gray-600 shrink-0">•</span>只計入主力淨買超 &gt; 0 的交易日（排除主力賣出的天數）</li>
                  <li class="flex gap-2"><span class="text-gray-600 shrink-0">•</span>計算範圍：整個投信連續買超的 streak 期間（3 天以上）</li>
                  <li class="flex gap-2"><span class="text-gray-600 shrink-0">•</span>結果為加權平均收盤價，買越多的那天對成本影響越大</li>
                </ul>
              </div>

              <div class="space-y-1.5 text-xs text-gray-400">
                <p class="text-gray-300 font-medium">欄位說明</p>
                <div class="space-y-2">
                  <div class="flex gap-3 items-start">
                    <span class="shrink-0 text-yellow-300 font-bold font-mono w-16">黃色數字</span>
                    <span>加權平均成本估算值，代表法人在這段期間的平均買入價位</span>
                  </div>
                  <div class="flex gap-3 items-start">
                    <span class="shrink-0 text-gray-500 font-mono w-16">灰色區間</span>
                    <span>整個 streak 期間的最低日低到最高日高，代表法人操作的完整價格帶</span>
                  </div>
                  <div class="flex gap-3 items-start">
                    <span class="shrink-0 text-yellow-500 font-mono w-16">≈ 成本價</span>
                    <span>現價與成本相差 &lt; 1%，通常出現在隱形布局階段，法人壓住股價收貨中</span>
                  </div>
                  <div class="flex gap-3 items-start">
                    <span class="shrink-0 text-green-400 font-mono w-16">低於成本</span>
                    <span>現價跌到成本以下，法人帳面虧損，通常處於洗盤或補跌階段，可等止穩</span>
                  </div>
                  <div class="flex gap-3 items-start">
                    <span class="shrink-0 text-red-400 font-mono w-16">高於成本</span>
                    <span>現價已超過成本，法人帳面獲利，股價開始啟動，觀察是否持續放量</span>
                  </div>
                </div>
              </div>

              <div class="rounded-xl bg-gray-800/40 px-4 py-3 space-y-1.5 text-xs">
                <p class="text-gray-300 font-medium mb-1">如何使用主力成本區</p>
                <div class="flex gap-2"><span class="text-blue-400 shrink-0">→</span><span class="text-gray-400">現價 ≈ 成本或低於成本：法人尚未獲利，不會急著賣，支撐力強，是較安全的進場區</span></div>
                <div class="flex gap-2"><span class="text-orange-400 shrink-0">→</span><span class="text-gray-400">現價高於成本 5–15%：法人小幅獲利，股票進入啟動期，可考慮跟進但注意追高風險</span></div>
                <div class="flex gap-2"><span class="text-red-400 shrink-0">→</span><span class="text-gray-400">現價高於成本 &gt; 20%：法人獲利豐厚，隨時可能出貨，追入風險偏高，需格外謹慎</span></div>
                <div class="flex gap-2"><span class="text-gray-500 shrink-0">⚠</span><span class="text-gray-500">此為估算值，實際買入成本因分批操作而有誤差，僅供參考，不代表精確的法人持倉成本</span></div>
              </div>

            </div>
          </div>

          <!-- 七、資料來源 -->
          <div class="px-5 py-4">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">七、資料來源與更新機制</h4>
            <div class="space-y-1.5 text-xs">
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">股價 / 量能</span>
                <span class="text-gray-400">TWSE STOCK_DAY_ALL — 全上市股票每日收盤、漲跌、成交量</span>
              </div>
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">三大法人</span>
                <span class="text-gray-400">TWSE T86 — 外資、投信、自營商每日買賣超（selectType=ALLBUT0999）</span>
              </div>
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">融資融券</span>
                <span class="text-gray-400">TWSE MI_MARGN — 每日融資餘額、融券餘額</span>
              </div>
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">自動更新</span>
                <span class="text-gray-400">每個交易日 18:30（台北時間）自動抓取當日資料並重新計算</span>
              </div>
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">分析週期</span>
                <span class="text-gray-400">以近 20 日資料計算各指標；法人資料取近 5 日；投信連買 streak 取近 35 日</span>
              </div>
              <div class="flex gap-3">
                <span class="shrink-0 text-gray-600 w-24">篩選範圍</span>
                <span class="text-gray-400">僅含上市股票（4 位數純數字代號），排除 ETF、特別股、存託憑證</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- 無資料 -->
      <div v-if="!screenerRows.length && !screenerLoading" class="text-center text-gray-600 text-sm py-12">
        點擊「回填20日歷史」建立歷史資料庫，再點擊「今日選股」計算結果。<br>
        <span class="text-xs text-gray-700">首次回填約需 90 秒，之後每日 18:30 自動更新。</span>
      </div>

      <!-- 選股結果表格 -->
      <div v-if="screenerRows.length" class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-xs text-gray-500 border-b border-gray-800 bg-gray-900/80 sticky top-0">
              <tr>
                <th class="px-3 py-3 text-center w-10">#</th>
                <th class="px-4 py-3 text-left">個股</th>
                <th class="px-4 py-3 text-center cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('score')">評分{{ screenerSortIcon('score') }}</th>
                <th class="px-4 py-3 text-center">階段</th>
                <th class="px-4 py-3 text-right cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('close')">收盤價{{ screenerSortIcon('close') }}</th>
                <th class="px-4 py-3 text-right cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('change_pct')">當日漲跌{{ screenerSortIcon('change_pct') }}</th>
                <th class="px-4 py-3 text-right cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('chg5d')">5日漲幅{{ screenerSortIcon('chg5d') }}</th>
                <th class="px-4 py-3 text-center cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('trust')">投信連買{{ screenerSortIcon('trust') }}</th>
                <th class="px-4 py-3 text-right cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('major')">主力5日淨{{ screenerSortIcon('major') }}</th>
                <th class="px-4 py-3 text-right cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('margin')">融資5日變{{ screenerSortIcon('margin') }}</th>
                <th class="px-4 py-3 text-center cursor-pointer hover:text-gray-300 select-none" @click="screenerSortBy('rank')">
                  <div>位置{{ screenerSortIcon('rank') }}</div>
                  <div class="text-gray-600 font-normal" style="font-size:10px">20日低↔高　越低越好</div>
                </th>
                <th class="px-4 py-3 text-right">
                  <div>主力成本區</div>
                  <div class="text-gray-600 font-normal" style="font-size:10px">法人買入加權均價</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, idx) in screenerSorted" :key="row.stock_no">
              <tr class="hover:bg-gray-800/40 transition border-t border-gray-800"
                  :class="row.is_stealth ? 'bg-cyan-950/30' : ''">
                <td class="px-3 py-2.5 text-center text-gray-600 text-xs">{{ idx + 1 }}</td>
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="font-semibold text-white">{{ row.stock_name }}</span>
                    <span v-if="row.is_stealth" class="text-xs text-cyan-400">🕵️</span>
                  </div>
                  <div class="text-xs text-gray-500 font-mono">{{ row.stock_no }}</div>
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span class="inline-block px-2 py-0.5 rounded font-bold text-xs"
                        :class="row.score >= 80 ? 'bg-red-500/20 text-red-400' :
                                row.score >= 65 ? 'bg-orange-500/20 text-orange-400' :
                                row.score >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
                                'bg-gray-700 text-gray-400'">
                    {{ row.score }}
                  </span>
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span v-if="PHASE_META[row.phase]"
                        class="inline-block px-2 py-0.5 rounded-full text-xs border"
                        :class="PHASE_META[row.phase].cls">
                    {{ PHASE_META[row.phase].label }}
                  </span>
                  <span v-else class="text-gray-600 text-xs">—</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold text-white">
                  {{ row.close != null ? (+row.close).toFixed(1) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-sm font-semibold"
                    :class="screenerChangePctColor(row.change_pct)">
                  {{ row.change_pct != null ? (row.change_pct > 0 ? '+' : '') + (+row.change_pct).toFixed(2) + '%' : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-sm"
                    :class="screenerChangePctColor(row.detail?.chg5d)">
                  {{ row.detail?.chg5d != null ? (row.detail.chg5d > 0 ? '+' : '') + (+row.detail.chg5d).toFixed(2) + '%' : '—' }}
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
                        :class="row.trust_streak >= 7 ? 'bg-red-500/20 text-red-400' :
                                row.trust_streak >= 5 ? 'bg-orange-500/20 text-orange-400' :
                                'bg-yellow-500/20 text-yellow-400'">
                    ▲ {{ row.trust_streak }} 天
                  </span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-sm"
                    :class="row.major_net5 > 0 ? 'text-red-400' : 'text-green-400'">
                  {{ fmtSignShares2(row.major_net5) }}<span class="text-gray-600 text-xs ml-0.5">張</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-sm"
                    :class="row.margin_chg5 == null ? 'text-gray-600' : row.margin_chg5 < 0 ? 'text-green-400' : 'text-red-400'">
                  {{ row.margin_chg5 != null ? fmtSignShares2(row.margin_chg5) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-center">
                  <div class="flex flex-col items-center gap-0.5">
                    <div class="flex items-center gap-1">
                      <span class="text-gray-600" style="font-size:10px">低</span>
                      <div class="w-14 bg-gray-700 rounded-full h-1.5 overflow-hidden">
                        <div class="h-full rounded-full"
                             :style="{ width: ((row.close_rank||0) * 100).toFixed(0) + '%' }"
                             :class="row.close_rank < 0.3 ? 'bg-green-500' : row.close_rank < 0.6 ? 'bg-yellow-500' : 'bg-red-500'">
                        </div>
                      </div>
                      <span class="text-gray-600" style="font-size:10px">高</span>
                    </div>
                    <span class="font-mono"
                          :class="row.close_rank < 0.3 ? 'text-green-400 text-xs font-bold' :
                                  row.close_rank < 0.6 ? 'text-yellow-400 text-xs' : 'text-red-400 text-xs'">
                      {{ row.close_rank != null ? ((+row.close_rank)*100).toFixed(0) + '%' : '—' }}
                    </span>
                  </div>
                </td>
                <!-- 主力成本欄 -->
                <td class="px-4 py-2.5 text-right">
                  <template v-if="row.detail?.instCost">
                    <div class="font-mono font-semibold text-yellow-300">
                      {{ (+row.detail.instCost).toFixed(1) }}
                    </div>
                    <div v-if="row.detail.instCostLow && row.detail.instCostHigh"
                         class="text-gray-500 font-mono" style="font-size:10px">
                      {{ (+row.detail.instCostLow).toFixed(1) }}–{{ (+row.detail.instCostHigh).toFixed(1) }}
                    </div>
                    <div class="text-xs font-mono mt-0.5"
                         :class="Math.abs((+row.close)/(+row.detail.instCost)-1) < 0.01
                                   ? 'text-yellow-500'
                                   : (+row.close) > (+row.detail.instCost)
                                     ? 'text-red-400' : 'text-green-400'">
                      {{ Math.abs((+row.close)/(+row.detail.instCost)-1) < 0.01
                           ? '≈ 成本價'
                           : (+row.close) > (+row.detail.instCost)
                             ? '高於成本 +' + (((+row.close)/(+row.detail.instCost)-1)*100).toFixed(1) + '%'
                             : '低於成本 ' + (((+row.close)/(+row.detail.instCost)-1)*100).toFixed(1) + '%' }}
                    </div>
                  </template>
                  <span v-else class="text-gray-600 text-xs">—</span>
                </td>
              </tr>
              <!-- 操作建議子列 -->
              <tr :class="row.is_stealth ? 'bg-cyan-950/20' : 'bg-gray-900/40'">
                <td class="px-3 pb-2.5 pt-0 text-center text-gray-700 text-xs">↳</td>
                <td colspan="10" class="px-4 pb-2.5 pt-0">
                  <div class="inline-flex items-start gap-2 rounded-lg border px-3 py-1.5 text-xs"
                       :class="screenerAdvice(row).bg">
                    <span class="font-bold shrink-0" :class="screenerAdvice(row).cls">{{ screenerAdvice(row).tag }}</span>
                    <span class="text-gray-400">{{ screenerAdvice(row).tip }}</span>
                  </div>
                </td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div class="px-5 py-3 border-t border-gray-800 text-xs text-gray-600">
          條件：投信連買≥3天・主力（外資+投信）近5日淨買>0・融資餘額近5日下降・當日漲跌&lt;7%・5日漲&lt;5%・無爆量。
          位置欄為近20日高低點中的相對位置（0%=最低・100%=最高）。🕵️=隱形布局（籌碼持續布局但股價未大漲）。每日 18:30 自動計算。
        </div>
      </div>

    </div>

    <!-- 三大法人查詢 -->
    <div v-if="tab === 'inst'" class="max-w-5xl mx-auto px-4 py-6 space-y-4">

      <!-- 查詢列 -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4">
        <h2 class="text-base font-semibold text-gray-200 mb-3">🏦 三大法人買賣超查詢</h2>
        <div class="flex flex-wrap gap-3 items-end">
          <div>
            <label class="block text-xs text-gray-500 mb-1">股票代號或名稱</label>
            <div class="relative">
              <input v-model="instStockNo" @input="onInstInput" @keyup.enter="queryInst"
                @blur="() => setTimeout(() => { instShowSuggestions.value = false }, 150)"
                class="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 w-40 focus:outline-none focus:border-blue-500"
                placeholder="代號或名稱" />
              <div v-if="instShowSuggestions && instSuggestions.length"
                   class="absolute z-50 top-full left-0 mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
                <div v-for="item in instSuggestions" :key="item.no"
                     @mousedown.prevent="selectInstSuggestion(item)"
                     class="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 cursor-pointer text-sm">
                  <span class="text-blue-400 font-mono w-12 shrink-0">{{ item.no }}</span>
                  <span class="text-gray-200 truncate">{{ item.name }}</span>
                </div>
              </div>
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">天數</label>
            <select v-model="instDays"
              class="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500">
              <option :value="5">5 天（五日）</option>
              <option :value="20">20 天</option>
              <option :value="60">60 天</option>
              <option :value="120">120 天</option>
              <option :value="200">200 天（約10個月）</option>
              <option value="custom">自訂天數</option>
            </select>
          </div>
          <div v-if="instDays === 'custom'">
            <label class="block text-xs text-gray-500 mb-1">輸入天數</label>
            <input v-model="instCustomDays" @keyup.enter="queryInst" type="number" min="1" max="500"
              class="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 w-24 focus:outline-none focus:border-blue-500"
              placeholder="例：30" />
          </div>
          <button @click="queryInst" :disabled="instLoading"
            class="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
            {{ instLoading ? '查詢中…' : '查詢' }}
          </button>
        </div>
        <p v-if="instError" class="mt-3 text-sm text-red-400">{{ instError }}</p>
      </div>

      <!-- 摘要統計 -->
      <div v-if="instSummary" class="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4">
        <div class="flex items-center gap-2 mb-3">
          <h3 class="text-sm font-semibold text-gray-200">{{ instStockName }} ({{ instStockNo }}) — 近 {{ instRows.length }} 日累計</h3>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="bg-gray-800 rounded-lg px-4 py-3">
            <div class="text-xs text-gray-500 mb-1">外資合計</div>
            <div class="text-base font-bold font-mono" :class="instColor(instSummary.total_foreign)">
              {{ instFmt(instSummary.total_foreign) }}
            </div>
          </div>
          <div class="bg-gray-800 rounded-lg px-4 py-3">
            <div class="text-xs text-gray-500 mb-1">投信合計</div>
            <div class="text-base font-bold font-mono" :class="instColor(instSummary.total_trust)">
              {{ instFmt(instSummary.total_trust) }}
            </div>
          </div>
          <div class="bg-gray-800 rounded-lg px-4 py-3">
            <div class="text-xs text-gray-500 mb-1">自營合計</div>
            <div class="text-base font-bold font-mono" :class="instColor(instSummary.total_dealer)">
              {{ instFmt(instSummary.total_dealer) }}
            </div>
          </div>
          <div class="bg-gray-800 rounded-lg px-4 py-3">
            <div class="text-xs text-gray-500 mb-1">主力（外+投）合計</div>
            <div class="text-base font-bold font-mono" :class="instColor(instSummary.total_major)">
              {{ instFmt(instSummary.total_major) }}
            </div>
          </div>
        </div>
      </div>

      <!-- 明細表格 -->
      <div v-if="instRows.length" class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-gray-800 text-xs text-gray-400 uppercase tracking-wide">
                <th class="px-4 py-2.5 text-left">日期</th>
                <th class="px-4 py-2.5 text-right">收盤</th>
                <th class="px-4 py-2.5 text-right">漲跌%</th>
                <th class="px-4 py-2.5 text-right">外資</th>
                <th class="px-4 py-2.5 text-right">投信</th>
                <th class="px-4 py-2.5 text-right">自營</th>
                <th class="px-4 py-2.5 text-right">主力合計</th>
                <th class="px-4 py-2.5 text-right">融資餘額</th>
                <th class="px-4 py-2.5 text-right">融券餘額</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in instRows" :key="row.trade_date"
                class="border-t border-gray-800 hover:bg-gray-800/50 transition">
                <td class="px-4 py-2.5 text-gray-400 font-mono text-xs">
                  {{ row.trade_date ? row.trade_date.slice(0,10) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold text-gray-200">
                  {{ row.close != null ? (+row.close).toFixed(2) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold" :class="instChangePctColor(row.change_pct)">
                  {{ row.change_pct != null ? (row.change_pct > 0 ? '+' : '') + (+row.change_pct).toFixed(2) + '%' : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono" :class="instColor(row.inst_foreign)">
                  {{ instFmt(row.inst_foreign) }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono" :class="instColor(row.inst_trust)">
                  {{ instFmt(row.inst_trust) }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono" :class="instColor(row.inst_dealer)">
                  {{ instFmt(row.inst_dealer) }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold" :class="instColor(row.major_net)">
                  {{ instFmt(row.major_net) }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-gray-400">
                  {{ row.margin_bal != null ? (+row.margin_bal).toLocaleString() : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-gray-400">
                  {{ row.short_bal != null ? (+row.short_bal).toLocaleString() : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="px-5 py-3 border-t border-gray-800 text-xs text-gray-600">
          三大法人單位：張（1張=1000股）。正數=買超 紅色・負數=賣超 綠色。主力合計＝外資＋投信。融資/融券餘額單位：張。資料來源：TWSE T86 / MI_MARGN。
        </div>
      </div>

    </div>

    <!-- 權證 -->
    <div v-if="tab === 'warrant'" class="w-full px-4 py-6 space-y-4">

      <!-- 搜尋列 -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4 flex flex-wrap gap-3 items-end">
        <div>
          <div class="text-xs text-gray-500 mb-1">標的代號／名稱</div>
          <input v-model="warrantStockNo" @keyup.enter="searchWarrant" type="text" placeholder="例：2330 或 台積電"
                 class="w-36 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">類型</div>
          <div class="flex gap-1">
            <button v-for="opt in [{v:'all',l:'全部'},{v:'call',l:'認購'},{v:'put',l:'認售'}]" :key="opt.v"
                    @click="warrantType = opt.v"
                    class="px-3 py-1.5 rounded-lg text-sm font-medium transition border"
                    :class="warrantType === opt.v ? 'bg-purple-700 border-purple-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'">
              {{ opt.l }}
            </button>
          </div>
        </div>
        <button @click="searchWarrant" :disabled="warrantLoading"
                class="px-4 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition disabled:opacity-50">
          {{ warrantLoading ? '查詢中...' : '查詢' }}
        </button>
        <div class="w-px h-6 bg-gray-700 self-center hidden sm:block"></div>
        <div>
          <div class="text-xs text-gray-500 mb-1">剩餘天 ≥</div>
          <input v-model.number="wFilterDays" type="number" min="0"
                 class="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">溢價率 最小%</div>
          <input v-model.number="wFilterPremiumMin" type="number"
                 class="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">溢價率 最大%</div>
          <input v-model.number="wFilterPremiumMax" type="number"
                 class="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">成交量 ≥ 張</div>
          <input v-model.number="wFilterVolume" type="number" min="0"
                 class="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">流通率 ≤ %</div>
          <input v-model.number="wFilterCirculation" type="number" min="0" max="100"
                 class="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-purple-500" />
        </div>
      </div>

      <!-- 錯誤 -->
      <div v-if="warrantError" class="bg-red-900/30 border border-red-800 rounded-xl px-4 py-3 text-sm text-red-400">
        {{ warrantError }}
      </div>

      <!-- 摘要列 -->
      <div v-if="warrantRows.length" class="bg-gray-900 rounded-xl border border-gray-800 px-5 py-3 flex flex-wrap gap-4 items-center text-sm">
        <span class="text-white font-semibold">{{ warrantStockName }}</span>
        <span class="text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted font-mono text-sm"
              @click="openQuote(warrantStockCode || warrantStockNo)">{{ warrantStockCode || warrantStockNo }}</span>
        <span class="text-gray-500">共 {{ warrantRows.length }} 檔</span>
        <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-800">認購 {{ warrantCallCount }}</span>
        <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-500/20 text-green-400 border border-green-800">認售 {{ warrantPutCount }}</span>
      </div>

      <!-- 備註說明 -->
      <div v-if="warrantRows.length" class="bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3 text-xs text-gray-500 space-y-1.5">
        <div class="text-gray-400 font-medium mb-1">欄位說明</div>
        <div><span class="text-gray-300">流通%</span>　剩餘可流通張數 ÷ 原始發行量。比例越低代表發行商手上籌碼越少，壓制能力越弱，權證較能真實反映標的漲跌。
          <span class="text-red-400 ml-2">紅 ≤ 20%</span>
          <span class="text-yellow-400 ml-1">黃 ≤ 50%</span>
        </div>
        <div><span class="text-gray-300">溢價率</span>　(履約價 + 權證現價 ÷ 行使比例 − 標的現價) ÷ 標的現價 × 100%。負值代表折價，數值越低越划算。</div>
        <div><span class="text-gray-300">槓桿</span>　標的現價 × 行使比例 ÷ 權證價，反映每元權證相當於幾元標的曝險。</div>
        <div><span class="text-gray-300">Delta</span>　標的漲 1 元時權證理論漲幅（元），已乘上行使比例換算為每張單位。</div>
        <div><span class="text-gray-300">成交量色階</span>
          <span class="text-orange-400 font-bold ml-2">橙色粗體 ≥ 10萬張</span><span class="text-gray-600">　市場熱度極高，流動性佳但籌碼複雜，需注意發行商是否趁機對沖壓制</span>
          <span class="text-white ml-3">白色 ≥ 1萬張</span><span class="text-gray-600">　量能活躍</span>
          <span class="text-gray-400 ml-3">灰色 &lt; 1萬張</span><span class="text-gray-600">　一般量</span>
        </div>
        <div class="text-gray-600 pt-1">資料來源：TWSE OpenAPI + MIS　每日盤後更新</div>
      </div>

      <!-- 符合條件區 -->
      <div v-if="warrantRows.length" class="bg-gray-900 rounded-xl border border-red-800/60">
        <div class="px-4 py-2 bg-red-900/30 border-b border-red-800/40 flex items-center gap-2">
          <span class="text-red-400 font-semibold text-xs">★ 符合條件</span>
          <span class="text-gray-500 text-xs">剩餘天 &gt; {{ wFilterDays }} ｜ {{ wFilterPremiumMin }}% &lt; 溢價率 &lt; {{ wFilterPremiumMax }}% ｜ 成交量 &gt; {{ wFilterVolume }}張 ｜ 流通率 ≤ {{ wFilterCirculation }}%</span>
          <span class="ml-auto text-red-400/70 text-xs">{{ warrantQualified.length }} 檔</span>
          <span v-if="askLastUpdated" class="text-gray-600 text-xs">更新 {{ askLastUpdated }}</span>
          <button @click="fetchWarrantAsks()" :disabled="askLoading"
                  class="px-2 py-0.5 rounded text-xs bg-blue-900/40 text-blue-400 hover:bg-blue-800/60 border border-blue-800/50 whitespace-nowrap transition disabled:opacity-50">
            {{ askLoading ? '查詢中…' : '刷新委賣' }}
          </button>
        </div>
        <div class="overflow-x-auto overflow-y-auto max-h-64">
        <table class="w-full text-xs">
          <thead class="sticky top-0 z-10 bg-gray-900">
            <tr class="border-b border-red-900/40 text-gray-500">
              <th class="text-left px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('warrantNo')">代號{{ wQSortIcon('warrantNo') }}</th>
              <th class="text-left px-3 py-2 font-medium whitespace-nowrap">名稱</th>
              <th class="text-left px-3 py-2 font-medium whitespace-nowrap">類型</th>
              <th class="text-left px-3 py-2 font-medium whitespace-nowrap hidden sm:table-cell">發行商</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('strike')">履約價{{ wQSortIcon('strike') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap hidden md:table-cell">到期日</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap hidden md:table-cell cursor-pointer hover:text-gray-300" @click="wQSort('daysLeft')">剩餘天{{ wQSortIcon('daysLeft') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('price')">現價{{ wQSortIcon('price') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('changePct')">漲跌%{{ wQSortIcon('changePct') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('volume')">成交量{{ wQSortIcon('volume') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap">委賣一</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('premiumPct')">溢價率{{ wQSortIcon('premiumPct') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap cursor-pointer hover:text-gray-300" @click="wQSort('circulationPct')">流通%{{ wQSortIcon('circulationPct') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap hidden lg:table-cell cursor-pointer hover:text-gray-300" @click="wQSort('leverage')">槓桿{{ wQSortIcon('leverage') }}</th>
              <th class="text-right px-3 py-2 font-medium whitespace-nowrap hidden lg:table-cell cursor-pointer hover:text-gray-300" @click="wQSort('delta')">Delta{{ wQSortIcon('delta') }}</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">工具</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!warrantQualified.length">
              <td colspan="16" class="px-4 py-6 text-center text-gray-600 text-xs">無符合條件的權證</td>
            </tr>
            <tr v-for="row in warrantQualified" :key="row.warrantNo"
                class="border-b border-red-900/20 bg-red-900/15 hover:bg-red-900/25 transition">
              <td class="px-3 py-2 font-mono text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted" @click="openQuote(row.warrantNo)">{{ row.warrantNo }}</td>
              <td class="px-3 py-2 text-gray-400 max-w-[120px] truncate">{{ row.warrantName }}</td>
              <td class="px-3 py-2">
                <span class="px-1.5 py-0.5 rounded text-xs font-bold"
                      :class="row.type === 'call' ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'">
                  {{ row.type === 'call' ? '認購' : '認售' }}
                </span>
              </td>
              <td class="px-3 py-2 text-gray-400 hidden sm:table-cell">{{ row.issuer || '—' }}</td>
              <td class="px-3 py-2 text-right text-gray-300">{{ row.strike != null ? row.strike.toLocaleString() : '—' }}</td>
              <td class="px-3 py-2 text-right text-gray-400 hidden md:table-cell">{{ row.expiry || '—' }}</td>
              <td class="px-3 py-2 text-right text-gray-400 hidden md:table-cell">{{ row.daysLeft != null ? row.daysLeft : '—' }}</td>
              <td class="px-3 py-2 text-right font-medium" :class="row.noTrade ? 'text-gray-500' : 'text-white'">
                {{ row.price != null ? row.price.toFixed(2) : '—' }}
                <span v-if="row.noTrade" class="text-gray-600 text-xs ml-0.5">昨</span>
              </td>
              <td class="px-3 py-2 text-right font-medium" :class="wChangePctColor(row.changePct)">
                <span v-if="row.noTrade" class="text-gray-600 text-xs">無成交</span>
                <span v-else>{{ row.changePct != null ? (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%' : '—' }}</span>
              </td>
              <td class="px-3 py-2 text-right font-mono"
                  :class="row.volume >= 100000 ? 'text-orange-400 font-bold' : row.volume >= 10000 ? 'text-white' : 'text-gray-400'">
                {{ row.volume ? row.volume.toLocaleString() : '—' }}
              </td>
              <td class="px-3 py-2 text-right">
                <template v-if="warrantAskMap[row.warrantNo]">
                  <span v-if="warrantAskMap[row.warrantNo].hasAsk" class="text-green-400 font-medium">
                    {{ warrantAskMap[row.warrantNo].ask1Price?.toFixed(2) }}
                    <span class="text-gray-400 text-xs ml-0.5">({{ warrantAskMap[row.warrantNo].ask1Qty }})</span>
                  </span>
                  <span v-else class="text-red-500 text-xs font-semibold">無量</span>
                </template>
                <span v-else class="text-gray-600">—</span>
              </td>
              <td class="px-3 py-2 text-right"
                  :class="row.premiumPct != null && row.premiumPct < 0 ? 'text-green-400' : row.premiumPct != null && row.premiumPct < 5 ? 'text-yellow-400' : 'text-gray-400'">
                {{ row.premiumPct != null ? (row.premiumPct > 0 ? '+' : '') + row.premiumPct.toFixed(2) + '%' : '—' }}
              </td>
              <td class="px-3 py-2 text-right"
                  :class="row.circulationPct != null && row.circulationPct <= 20 ? 'text-red-400 font-semibold' : row.circulationPct != null && row.circulationPct <= 50 ? 'text-yellow-400' : 'text-gray-400'">
                {{ row.circulationPct != null ? row.circulationPct.toFixed(1) + '%' : '—' }}
              </td>
              <td class="px-3 py-2 text-right text-gray-300 hidden lg:table-cell">
                {{ row.leverage != null ? row.leverage.toFixed(1) + 'x' : '—' }}
              </td>
              <td class="px-3 py-2 text-right text-gray-300 hidden lg:table-cell">
                {{ row.delta != null ? row.delta.toFixed(4) : '—' }}
              </td>
              <td class="px-3 py-2">
                <div class="flex gap-1 justify-center">
                  <button @click="openQuote(row.stockNo)"
                          class="px-1.5 py-0.5 rounded text-xs bg-green-900/40 text-green-400 hover:bg-green-800/60 border border-green-800/50 whitespace-nowrap transition">報價</button>
                  <button @click="openScenario(row)"
                          class="px-1.5 py-0.5 rounded text-xs bg-yellow-900/40 text-yellow-400 hover:bg-yellow-800/60 border border-yellow-800/50 whitespace-nowrap transition">情境</button>
                  <a :href="`https://www.warrantwin.com.tw/eyuanta/Warrant/Analyzer.aspx?WID=${row.warrantNo}`" target="_blank" rel="noopener"
                     class="px-1.5 py-0.5 rounded text-xs bg-purple-900/40 text-purple-400 hover:bg-purple-800/60 border border-purple-800/50 whitespace-nowrap transition">試算</a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <!-- 表格 -->
      <div v-if="warrantRows.length" class="bg-gray-900 rounded-xl border border-gray-800">
        <div class="overflow-x-auto overflow-y-auto max-h-[70vh]">
        <table class="w-full text-xs">
          <thead class="sticky top-0 z-10 bg-gray-900">
            <tr class="border-b border-gray-800 text-gray-500">
              <th class="text-left px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('warrantNo')">代號{{ wSortIcon('warrantNo') }}</th>
              <th class="text-left px-3 py-2.5 font-medium whitespace-nowrap">名稱</th>
              <th class="text-left px-3 py-2.5 font-medium whitespace-nowrap">類型</th>
              <th class="text-left px-3 py-2.5 font-medium whitespace-nowrap hidden sm:table-cell">發行商</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('strike')">履約價{{ wSortIcon('strike') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap hidden md:table-cell" @click="warrantSort('daysLeft')">到期日{{ wSortIcon('daysLeft') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap hidden md:table-cell" @click="warrantSort('daysLeft')">剩餘天{{ wSortIcon('daysLeft') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('price')">現價{{ wSortIcon('price') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('changePct')">漲跌%{{ wSortIcon('changePct') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('volume')">成交量{{ wSortIcon('volume') }}</th>
              <th class="text-center px-3 py-2.5 font-medium whitespace-nowrap">委賣</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('premiumPct')">溢價率{{ wSortIcon('premiumPct') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap" @click="warrantSort('circulationPct')">流通%{{ wSortIcon('circulationPct') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap hidden lg:table-cell" @click="warrantSort('leverage')">槓桿{{ wSortIcon('leverage') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap hidden lg:table-cell" @click="warrantSort('delta')">Delta{{ wSortIcon('delta') }}</th>
              <th class="text-right px-3 py-2.5 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap hidden xl:table-cell" @click="warrantSort('iv')">IV%{{ wSortIcon('iv') }}</th>
              <th class="px-3 py-2.5 font-medium whitespace-nowrap">工具</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in warrantSorted" :key="row.warrantNo"
                class="border-b border-gray-800/50 hover:bg-gray-800/40 transition"
                :class="row.daysLeft != null && row.daysLeft < 30 ? 'bg-orange-900/10' : ''">
              <td class="px-3 py-2 font-mono text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted" @click="openQuote(row.warrantNo)">{{ row.warrantNo }}</td>
              <td class="px-3 py-2 text-gray-400 max-w-[120px] truncate">{{ row.warrantName }}</td>
              <td class="px-3 py-2">
                <span class="px-1.5 py-0.5 rounded text-xs font-bold"
                      :class="row.type === 'call' ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'">
                  {{ row.type === 'call' ? '認購' : '認售' }}
                </span>
              </td>
              <td class="px-3 py-2 text-gray-400 hidden sm:table-cell">{{ row.issuer || '—' }}</td>
              <td class="px-3 py-2 text-right text-gray-300">{{ row.strike != null ? row.strike.toLocaleString() : '—' }}</td>
              <td class="px-3 py-2 text-right text-gray-400 hidden md:table-cell">{{ row.expiry || '—' }}</td>
              <td class="px-3 py-2 text-right hidden md:table-cell"
                  :class="row.daysLeft != null && row.daysLeft < 30 ? 'text-orange-400 font-semibold' : 'text-gray-400'">
                {{ row.daysLeft != null ? row.daysLeft : '—' }}
              </td>
              <td class="px-3 py-2 text-right font-medium" :class="row.noTrade ? 'text-gray-500' : 'text-white'">
                {{ row.price != null ? row.price.toFixed(2) : '—' }}
                <span v-if="row.noTrade" class="text-gray-600 text-xs ml-0.5">昨</span>
              </td>
              <td class="px-3 py-2 text-right font-medium" :class="wChangePctColor(row.changePct)">
                <span v-if="row.noTrade" class="text-gray-600 text-xs">無成交</span>
                <span v-else>{{ row.changePct != null ? (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%' : '—' }}</span>
              </td>
              <td class="px-3 py-2 text-right text-gray-300">{{ row.volume ? row.volume.toLocaleString() : '—' }}</td>
              <td class="px-3 py-2 text-center">
                <template v-if="warrantAskMap[row.warrantNo]">
                  <span v-if="warrantAskMap[row.warrantNo].hasAsk"
                        class="inline-block w-2 h-2 rounded-full bg-green-400"
                        :title="`委賣一 ${warrantAskMap[row.warrantNo].ask1Price?.toFixed(2)} (${warrantAskMap[row.warrantNo].ask1Qty}張)`">
                  </span>
                  <span v-else
                        class="inline-block w-2 h-2 rounded-full bg-red-500"
                        title="無委賣掛單">
                  </span>
                </template>
                <span v-else class="inline-block w-2 h-2 rounded-full bg-gray-700"></span>
              </td>
              <td class="px-3 py-2 text-right"
                  :class="row.premiumPct != null && row.premiumPct < 0 ? 'text-green-400' : row.premiumPct != null && row.premiumPct < 5 ? 'text-yellow-400' : 'text-gray-400'">
                {{ row.premiumPct != null ? (row.premiumPct > 0 ? '+' : '') + row.premiumPct.toFixed(2) + '%' : '—' }}
              </td>
              <td class="px-3 py-2 text-right"
                  :class="row.circulationPct != null && row.circulationPct <= 20 ? 'text-red-400 font-semibold' : row.circulationPct != null && row.circulationPct <= 50 ? 'text-yellow-400' : 'text-gray-400'">
                {{ row.circulationPct != null ? row.circulationPct.toFixed(1) + '%' : '—' }}
              </td>
              <td class="px-3 py-2 text-right text-gray-300 hidden lg:table-cell">
                {{ row.leverage != null ? row.leverage.toFixed(1) + 'x' : '—' }}
              </td>
              <td class="px-3 py-2 text-right text-gray-300 hidden lg:table-cell">
                {{ row.delta != null ? row.delta.toFixed(4) : '—' }}
              </td>
              <td class="px-3 py-2 text-right hidden xl:table-cell">
                <span v-if="row.iv != null" class="text-gray-400">{{ row.iv.toFixed(1) }}%</span>
                <span v-else-if="row.ivStale" class="text-yellow-600 text-xs" title="昨收價與今日標的股價落差過大，IV 無解（請等今日成交價更新）">價格失效</span>
                <span v-else class="text-gray-600">—</span>
              </td>
              <td class="px-3 py-2">
                <div class="flex gap-1 justify-center">
                  <button @click="openQuote(row.stockNo)"
                          class="px-1.5 py-0.5 rounded text-xs bg-green-900/40 text-green-400 hover:bg-green-800/60 border border-green-800/50 whitespace-nowrap transition">報價</button>
                  <button @click="openScenario(row)"
                          class="px-1.5 py-0.5 rounded text-xs bg-yellow-900/40 text-yellow-400 hover:bg-yellow-800/60 border border-yellow-800/50 whitespace-nowrap transition">情境</button>
                  <a :href="`https://www.warrantwin.com.tw/eyuanta/Warrant/Analyzer.aspx?WID=${row.warrantNo}`" target="_blank" rel="noopener"
                     class="px-1.5 py-0.5 rounded text-xs bg-purple-900/40 text-purple-400 hover:bg-purple-800/60 border border-purple-800/50 whitespace-nowrap transition">試算</a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <!-- IV 驗證區 -->
      <div v-if="warrantRows.length" class="bg-gray-900 rounded-xl border border-gray-700">
        <div class="px-4 py-3 border-b border-gray-800 flex items-center gap-3">
          <span class="text-sm font-medium text-gray-300">IV 正確性驗證</span>
          <span class="text-xs text-gray-500">以 bid/ask 中間價為基準，比較含/不含股息調整的 IV 差異</span>
          <button @click="runValidate" :disabled="validateLoading"
                  class="ml-auto px-3 py-1 rounded-lg text-xs font-medium bg-blue-900/50 text-blue-300 hover:bg-blue-800/60 border border-blue-800/50 transition disabled:opacity-50">
            {{ validateLoading ? '驗證中...' : '執行驗證' }}
          </button>
        </div>

        <div v-if="validateError" class="px-4 py-3 text-xs text-red-400">{{ validateError }}</div>

        <!-- 統計摘要 -->
        <div v-if="validateResult" class="px-4 py-3 border-b border-gray-800 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
          <span class="text-gray-500">標的：<span class="text-white">{{ validateResult.stockName }}</span></span>
          <span class="text-gray-500">股價：<span class="text-white">{{ validateResult.stockPrice?.toFixed(2) }}</span></span>
          <span v-if="validateResult.dividendYield" class="text-gray-500">殖利率：<span class="text-green-400">{{ validateResult.dividendYield }}%</span></span>
          <span class="text-gray-500">有 bid/ask 的權證：<span class="text-white">{{ validateResult.validCount }}</span> / {{ validateResult.total }}</span>
          <span class="text-gray-500">收盤價在 bid-ask 內：
            <span :class="validateResult.withinSpreadPct >= 80 ? 'text-green-400' : validateResult.withinSpreadPct >= 50 ? 'text-yellow-400' : 'text-red-400'">
              {{ validateResult.withinSpreadPct }}%
            </span>
            <span class="text-gray-600">（{{ validateResult.withinSpread }}/{{ validateResult.validCount }}）</span>
          </span>
          <span v-if="validateResult.ivDivEffectAvg != null" class="text-gray-500">
            股息調整平均 IV 修正：
            <span class="text-cyan-400">{{ validateResult.ivDivEffectAvg > 0 ? '+' : '' }}{{ validateResult.ivDivEffectAvg }}%</span>
          </span>
        </div>

        <!-- 明細表 -->
        <div v-if="validateResult?.rows?.length" class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="bg-gray-800/60 text-gray-400">
                <th class="px-3 py-2 text-left font-medium">權證</th>
                <th class="px-3 py-2 text-right font-medium">類型</th>
                <th class="px-3 py-2 text-right font-medium">剩餘天</th>
                <th class="px-3 py-2 text-right font-medium">收盤價</th>
                <th class="px-3 py-2 text-right font-medium">Bid</th>
                <th class="px-3 py-2 text-right font-medium">Ask</th>
                <th class="px-3 py-2 text-right font-medium">Mid</th>
                <th class="px-3 py-2 text-right font-medium">在Spread內</th>
                <th class="px-3 py-2 text-right font-medium">IV (含股息)</th>
                <th class="px-3 py-2 text-right font-medium">IV (不含)</th>
                <th class="px-3 py-2 text-right font-medium">股息修正</th>
                <th class="px-3 py-2 text-right font-medium">IV vs Mid差</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in validateResult.rows.slice(0, 50)" :key="r.code"
                  class="border-t border-gray-800/50 hover:bg-gray-800/30">
                <td class="px-3 py-1.5 font-mono text-gray-300">{{ r.code }}<div class="text-gray-600" style="font-size:10px">{{ r.name }}</div></td>
                <td class="px-3 py-1.5 text-right" :class="r.type==='call'?'text-green-400':'text-red-400'">{{ r.type==='call'?'認購':'認售' }}</td>
                <td class="px-3 py-1.5 text-right text-gray-400">{{ r.daysLeft }}</td>
                <td class="px-3 py-1.5 text-right font-mono" :class="r.tradedToday?'text-white':'text-gray-500'">{{ r.closePrice?.toFixed(2) ?? '-' }}</td>
                <td class="px-3 py-1.5 text-right font-mono text-green-400">{{ r.bid?.toFixed(2) ?? '-' }}</td>
                <td class="px-3 py-1.5 text-right font-mono text-red-400">{{ r.ask?.toFixed(2) ?? '-' }}</td>
                <td class="px-3 py-1.5 text-right font-mono text-gray-300">{{ r.midPrice?.toFixed(3) ?? '-' }}</td>
                <td class="px-3 py-1.5 text-center">
                  <span v-if="r.withinSpread === true" class="text-green-400">✓</span>
                  <span v-else-if="r.withinSpread === false" class="text-red-400">✗</span>
                  <span v-else class="text-gray-600">-</span>
                </td>
                <td class="px-3 py-1.5 text-right font-mono text-yellow-300">{{ r.ivCloseQ?.toFixed(1) ?? '-' }}%</td>
                <td class="px-3 py-1.5 text-right font-mono text-gray-400">{{ r.ivClose0?.toFixed(1) ?? '-' }}%</td>
                <td class="px-3 py-1.5 text-right font-mono"
                    :class="r.ivDivEffect && Math.abs(r.ivDivEffect) >= 0.5 ? 'text-cyan-400' : 'text-gray-600'">
                  {{ r.ivDivEffect != null ? (r.ivDivEffect > 0 ? '+' : '') + r.ivDivEffect.toFixed(2) + '%' : '-' }}
                </td>
                <td class="px-3 py-1.5 text-right font-mono"
                    :class="r.midDiffPct != null ? (Math.abs(r.midDiffPct) < 1 ? 'text-green-400' : Math.abs(r.midDiffPct) < 5 ? 'text-yellow-400' : 'text-red-400') : 'text-gray-600'">
                  {{ r.midDiffPct != null ? (r.midDiffPct > 0 ? '+' : '') + r.midDiffPct + '%' : '-' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="!validateLoading && !validateResult" class="px-4 py-4 text-xs text-gray-600 text-center">點擊「執行驗證」以對當前查詢的標的進行 IV 準確性驗證</div>
      </div>

      <!-- Loading -->
      <div v-if="warrantLoading" class="text-center py-12 text-gray-500 text-sm">查詢中，請稍候...</div>
    </div>

    <!-- ══ 漲跌排行 ══════════════════════════════════════════ -->
    <div v-if="tab === 'movers'" class="max-w-6xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-semibold text-white">漲跌排行</h2>

        <!-- 日期選單 -->
        <select v-model="moversDate" @change="onMoversDateChange"
                class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-purple-500">
          <option value="">今日即時</option>
          <option v-for="d in moversDates" :key="d" :value="d">{{ d }}</option>
        </select>

        <span v-if="moversTotal" class="text-xs text-gray-500">共 {{ moversTotal }} 支</span>
        <span v-if="moversUpdatedAt" class="text-xs text-gray-600">
          {{ moversRealtime ? '更新：' : '交易日：' }}{{ moversUpdatedAt }}
        </span>
        <span v-if="moversRealtime && !moversDate" class="text-xs text-green-600 animate-pulse">● 即時</span>
        <span v-if="moversMisEmpty" class="text-xs text-yellow-500">⚠ 交易所即時資料暫無回應，顯示上次快取</span>

        <button @click="fetchMovers" :disabled="moversLoading"
                class="ml-auto px-4 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm text-gray-300 transition disabled:opacity-50">
          {{ moversLoading ? '載入中...' : '刷新' }}
        </button>
      </div>

      <!-- 顏色與操作說明 -->
      <div class="bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3 text-xs space-y-2.5">

        <!-- 列底色 -->
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
          <span class="text-gray-600 shrink-0 font-medium">列底色</span>
          <span class="flex items-center gap-1.5">
            <span class="inline-block w-3 h-3 rounded-sm bg-red-900/60 border border-red-700/40"></span>
            <span class="text-gray-300">量增漲停</span>
            <span class="text-gray-600 ml-1">今量 1.5～3x 昨量，且漲停委買比 &gt;1.5</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="inline-block w-3 h-3 rounded-sm bg-blue-900/60 border border-blue-700/40"></span>
            <span class="text-gray-300">量縮漲停</span>
            <span class="text-gray-600 ml-1">今量 &lt; 昨量 50%，且漲停委買比 &gt;2</span>
          </span>
        </div>

        <!-- 量比數字色 -->
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
          <span class="text-gray-600 shrink-0 font-medium">量比色</span>
          <span class="text-yellow-400 font-bold">黃 ≥2x</span><span class="text-gray-600">爆量</span>
          <span class="text-gray-600">｜</span>
          <span class="text-purple-400 font-bold">紫 &lt;0.5x</span><span class="text-gray-600">大縮（1日）</span>
          <span class="text-gray-600">｜</span>
          <span class="text-red-400 font-bold">紅 0.5～0.7x</span><span class="text-gray-600">縮量（1日）</span>
          <span class="text-gray-600">｜</span>
          <span class="text-orange-400 font-bold">橙 &lt;0.5x</span><span class="text-gray-600">大縮（5日均）</span>
        </div>

        <!-- 漲停委買比色 -->
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
          <span class="text-gray-600 shrink-0 font-medium">委買比色</span>
          <span class="text-green-400 font-bold">綠 &gt;1.6</span><span class="text-gray-600">強力買壓，委買量超過成交量 1.6 倍</span>
          <span class="text-gray-600">｜</span>
          <span class="text-cyan-400">青 1～1.6</span><span class="text-gray-600">有委買意願，尚未達強力護盤門檻</span>
          <span class="text-gray-600">｜</span>
          <span class="text-gray-400">灰 ≤1</span><span class="text-gray-600">委買量未超過成交量</span>
        </div>

        <!-- 排序規則 -->
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
          <span class="text-gray-600 shrink-0 font-medium">排序</span>
          <span class="text-gray-400">① 漲跌幅%</span>
          <span class="text-gray-600">→</span>
          <span class="text-gray-400">② 成交量（張）</span>
          <span class="text-gray-600">→</span>
          <span class="text-gray-400">③ 成交金額（億）</span>
          <span class="text-gray-600 ml-1">同漲幅時量大優先，量相同時金額大優先</span>
        </div>

        <!-- 操作 -->
        <div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-800 pt-2 text-gray-600">
          <span>點<span class="text-white">名稱</span> → 權證查詢</span>
          <span>點<span class="text-blue-400 underline decoration-dotted">代號</span> → 即時五檔</span>
          <span>點觀察區整列 → 跳到量縮清單</span>
        </div>
      </div>

      <!-- 觀察名單時段快照下拉 -->
      <div class="flex items-center gap-2 px-1">
        <span class="text-xs text-gray-500">觀察時段：</span>
        <select
          v-model="limitSnapshotTime"
          class="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
          <option value="">即時</option>
          <option v-for="t in limitSnapshotTimes" :key="t" :value="t">{{ t }}</option>
        </select>
        <span v-if="limitSnapshotTime" class="text-xs text-yellow-400">歷史快照</span>
        <span v-else-if="limitSnapshotTimes.length === 0" class="text-xs text-gray-600">（今日尚無快照）</span>
        <span v-else class="text-xs text-gray-600">{{ limitSnapshotTimes.length }} 個時段可查</span>
      </div>

      <!-- 量縮漲停觀察 Telegram 測試鈕 -->
      <div class="flex items-center gap-3 px-1">
        <button
          @click="sendSqueezeTest"
          :disabled="squeezeTestLoading"
          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-900/50 border border-blue-500/40 text-blue-300 hover:bg-blue-800/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {{ squeezeTestLoading ? '傳送中…' : '📨 傳送觀察名單' }}
        </button>
        <span v-if="squeezeTestResult" :class="squeezeTestResult.ok ? 'text-green-400' : squeezeTestResult.skipped ? 'text-yellow-400' : 'text-red-400'" class="text-xs">
          {{ squeezeTestResult.message || squeezeTestResult.reason }}
        </span>
      </div>

      <!-- 量縮漲停觀察 第一順位 -->
      <div class="bg-gray-900 border border-blue-500/40 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-blue-500/30 flex items-center gap-2 flex-wrap">
          <span class="text-blue-300 font-semibold text-sm">★ 量縮漲停觀察　第一順位</span>
          <span class="text-gray-600 text-xs">5日量比 &lt; 0.5　且　委買比 &gt; 1.7</span>
          <span v-if="moversDate" class="text-xs text-gray-600">（歷史資料）</span>
          <span class="ml-auto text-xs text-blue-400">{{ limitSqueezeList1.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitSqueezeList1.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in limitSqueezeList1" :key="r.stockNo"
                class="border-b border-gray-800/50 bg-blue-900/15 hover:bg-blue-900/25 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                <template v-if="r.limitBidVol">{{ r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}</template>
                <span v-else-if="r.closedLimitUp" class="text-orange-400 text-xs">漲停收</span>
                <template v-else>-</template>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-blue-300">
                <template v-if="r.limitBidVol">{{ r.limitBidVol.toLocaleString() }}</template>
                <span v-else-if="r.closedLimitUp" class="text-orange-400 text-xs">漲停收</span>
                <template v-else>-</template>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 量縮漲停觀察 第二順位 -->
      <div class="bg-gray-900 border border-blue-900/50 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-blue-900/40 flex items-center gap-2 flex-wrap">
          <span class="text-blue-400 font-semibold text-sm">▲ 量縮漲停觀察　第二順位</span>
          <span class="text-gray-600 text-xs">5日量比 &lt; 0.7　且　委買比 &gt; 1.5</span>
          <span v-if="moversDate" class="text-xs text-gray-600">（歷史資料）</span>
          <span class="ml-auto text-xs text-blue-600">{{ limitSqueezeList2.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitSqueezeList2.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in limitSqueezeList2" :key="r.stockNo"
                class="border-b border-gray-800/50 bg-blue-900/10 hover:bg-blue-900/20 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                <template v-if="r.limitBidVol">{{ r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}</template>
                <span v-else-if="r.closedLimitUp" class="text-orange-400 text-xs">漲停收</span>
                <template v-else>-</template>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-blue-300">
                <template v-if="r.limitBidVol">{{ r.limitBidVol.toLocaleString() }}</template>
                <span v-else-if="r.closedLimitUp" class="text-orange-400 text-xs">漲停收</span>
                <template v-else>-</template>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 量縮漲停觀察 第三順位 -->
      <div class="bg-gray-900 border border-gray-800/60 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800/40 flex items-center gap-2 flex-wrap">
          <span class="text-gray-400 font-semibold text-sm">△ 量縮漲停觀察　第三順位</span>
          <span class="text-gray-600 text-xs">5日量比 &lt; 0.7　不限委買比</span>
          <span class="ml-auto text-xs text-gray-600">{{ limitSqueezeList3.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitSqueezeList3.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in limitSqueezeList3" :key="r.stockNo"
                class="border-b border-gray-800/50 hover:bg-gray-800/20 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                {{ r.limitBidVol && r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-500">{{ r.limitBidVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 量增漲停觀察 第一順位 -->
      <div class="bg-gray-900 border border-amber-500/40 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-amber-500/30 flex items-center gap-2 flex-wrap">
          <span class="text-amber-300 font-semibold text-sm">★ 量增漲停觀察（主力換手）　第一順位</span>
          <span class="text-gray-600 text-xs">5日量比 1.5～5x　且　委買比 &gt; 2　且　首板／二板</span>
          <span v-if="moversDate" class="text-xs text-gray-600">（歷史資料）</span>
          <span class="ml-auto text-xs text-amber-400">{{ volIncreaseLimitList1.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!volIncreaseLimitList1.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in volIncreaseLimitList1" :key="r.stockNo"
                class="border-b border-gray-800/50 bg-amber-900/15 hover:bg-amber-900/25 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                {{ r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-amber-300">{{ r.limitBidVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 量增漲停觀察 第二順位 -->
      <div class="bg-gray-900 border border-amber-900/50 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-amber-900/40 flex items-center gap-2 flex-wrap">
          <span class="text-amber-400 font-semibold text-sm">▲ 量增漲停觀察（主力換手）　第二順位</span>
          <span class="text-gray-600 text-xs">5日量比 1.5～5x　且　委買比 &gt; 1.5</span>
          <span v-if="moversDate" class="text-xs text-gray-600">（歷史資料）</span>
          <span class="ml-auto text-xs text-amber-600">{{ volIncreaseLimitList2.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!volIncreaseLimitList2.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in volIncreaseLimitList2" :key="r.stockNo"
                class="border-b border-gray-800/50 bg-amber-900/10 hover:bg-amber-900/20 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                {{ r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-amber-400">{{ r.limitBidVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 量增漲停觀察 第三順位 -->
      <div class="bg-gray-900 border border-amber-900/30 rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b border-amber-900/20 flex items-center gap-2 flex-wrap">
          <span class="text-amber-600 font-semibold text-sm">△ 量增漲停觀察（主力換手）　第三順位</span>
          <span class="text-gray-600 text-xs">5日量比 1.5～5x　不限委買比</span>
          <span class="ml-auto text-xs text-amber-800">{{ volIncreaseLimitList3.length }} 支</span>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950">
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-normal">代號／名稱</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日均量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">今日量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">5日量比</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">漲停委買量</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">連漲停</th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-normal">委買可信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!volIncreaseLimitList3.length">
              <td colspan="8" class="px-3 py-4 text-center text-gray-700 text-xs">目前無符合條件</td>
            </tr>
            <tr v-for="r in volIncreaseLimitList3" :key="r.stockNo"
                class="border-b border-gray-800/50 hover:bg-amber-900/10 transition cursor-pointer"
                @click="goToWarrant(r.stockNo)">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium hover:text-purple-400 transition">{{ r.stockName }}</span>
                  <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded">有證</span>
                </div>
                <div class="text-xs text-gray-500">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-400">{{ r.volMa5?.toLocaleString() ?? r.prevVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : 'text-gray-400'">{{ r.volume.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                {{ r.limitBidVol && r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-gray-500">{{ r.limitBidVol?.toLocaleString() ?? '-' }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-yellow-400">
                {{ r.limitDays ? r.limitDays + '天' : '-' }}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">
                <span v-if="bidCredibility(r) === 'high'"   class="text-green-400">●高</span>
                <span v-else-if="bidCredibility(r) === 'medium'" class="text-yellow-400">●中</span>
                <span v-else-if="bidCredibility(r) === 'low'"    class="text-red-400">●低</span>
                <span v-else class="text-gray-600">－</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 顏色規則說明 -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 text-xs text-gray-400 space-y-2">
        <div class="font-semibold text-gray-300 mb-1">顏色規則說明</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
          <div class="font-semibold text-gray-500 col-span-full">1日量比（今日量 ÷ 昨日量）</div>
          <div class="flex items-center gap-2"><span class="text-yellow-400 font-bold">■ 黃色粗體</span><span>≥ 2　爆量</span></div>
          <div class="flex items-center gap-2"><span class="text-gray-400">■ 灰色</span><span>0.7 ～ 2　正常</span></div>
          <div class="flex items-center gap-2"><span class="text-red-400 font-bold">■ 紅色粗體</span><span>0.5 ～ 0.7　縮量</span></div>
          <div class="flex items-center gap-2"><span class="text-purple-400 font-bold">■ 紫色粗體</span><span>&lt; 0.5　極度縮量</span></div>
          <div class="font-semibold text-gray-500 col-span-full mt-1">5日量比（今日量 ÷ 5日均量）</div>
          <div class="flex items-center gap-2"><span class="text-yellow-400 font-bold">■ 黃色粗體</span><span>≥ 2　爆量</span></div>
          <div class="flex items-center gap-2"><span class="text-gray-400">■ 灰色</span><span>0.5 ～ 2　正常</span></div>
          <div class="flex items-center gap-2"><span class="text-orange-400 font-bold">■ 橘色粗體</span><span>&lt; 0.5　縮量</span></div>
          <div class="font-semibold text-gray-500 col-span-full mt-1">今日成交量欄顏色</div>
          <div class="flex items-center gap-2"><span class="text-rose-400 font-bold">■ 玫瑰色粗體</span><span>≥ 10萬張　超大量，市場高度關注，籌碼流動快、主力動向值得追蹤</span></div>
          <div class="flex items-center gap-2"><span class="text-red-300">■ 淡紅色</span><span>有漲停委買且比值 &gt; 1.6　強力護盤訊號</span></div>
          <div class="flex items-center gap-2"><span class="text-gray-400">■ 灰色</span><span>一般成交量</span></div>
          <div class="font-semibold text-gray-500 col-span-full mt-1">列背景</div>
          <div class="flex items-center gap-2"><span class="px-2 py-0.5 rounded bg-red-900/40 text-red-300">紅底（主力換手）</span><span>符合量增漲停觀察第一或第二順位</span></div>
          <div class="flex items-center gap-2"><span class="px-2 py-0.5 rounded bg-blue-900/40 text-blue-300">藍底（量縮漲停）</span><span>符合量縮漲停觀察第一、二或三順位</span></div>
          <div class="font-semibold text-gray-500 col-span-full mt-1">股名旁徽章</div>
          <div class="flex items-center gap-2"><span class="text-yellow-300 text-xs">⚡</span><span>開盤後一小時內（09:00–10:00）即達漲停，強勢訊號</span></div>
          <div class="flex items-center gap-2"><span class="px-1 py-0.5 rounded bg-purple-900/60 text-purple-300 text-xs">有證</span><span>該股今日仍有券商發行的有效權證（認購或認售），點擊可直接跳至權證查詢頁</span></div>

          <div class="font-semibold text-gray-500 col-span-full mt-2">量縮漲停觀察區（籌碼集中、惜售）</div>
          <div class="text-gray-600 col-span-full text-xs mb-0.5">
            共同前提：漲停（漲幅 ≥ 9.5%）＋ 成交量 ≥ 50張 ＋ 外盤量 &gt; 內盤量（無資料略過）<br>
            量比基準：<b class="text-gray-400">5日均量</b>（前5個交易日平均成交量）；無5日資料時退用昨日量<br>
            邏輯：量縮 → 籌碼集中、市場惜售；委買比高 → 仍有大量資金排隊，隔日續漲機率高
          </div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-blue-300 font-bold">★ 第一順位</span><span>5日量比 &lt; 0.5 且 漲停委買比 &gt; 1.7　→ 極度縮量＋強力護盤</span></div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-blue-400">▲ 第二順位</span><span>5日量比 &lt; 0.7 且 漲停委買比 &gt; 1.5　→ 縮量＋明顯護盤（不與一重複）</span></div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-gray-400">△ 第三順位</span><span>5日量比 &lt; 0.7 不限委買比　→ 縮量觀察，委買資料不足時仍列入（不與一、二重複）</span></div>

          <div class="font-semibold text-gray-500 col-span-full mt-2">量增漲停觀察區（主力換手）</div>
          <div class="text-gray-600 col-span-full text-xs mb-0.5">
            共同前提：漲停（漲幅 ≥ 9.5%）＋ 5日量比 1.5～5x ＋ 成交量 ≥ 50張 ＋ 外盤量 &gt; 內盤量（無資料略過）<br>
            量比上限 5x：超過5倍多為散戶追買或炒作，排除；1.5～5x 為主力積極換手的合理區間<br>
            邏輯：量增說明主力在積極建倉或換手；委買比高說明漲停後仍有資金護盤意願<br>
            連板分層：<b class="text-gray-400">首板（首次漲停）</b>量增最值得關注；<b class="text-gray-400">二板</b>仍可追蹤；三板以上已有溢價風險，退入第二以下順位
          </div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-amber-300 font-bold">★ 第一順位</span><span>5日量比 1.5～5x 且 委買比 &gt; 2 且 首板或二板　→ 最佳換手訊號</span></div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-amber-400">▲ 第二順位</span><span>5日量比 1.5～5x 且 委買比 &gt; 1.5　→ 換手充分，含三板以上（不與一重複）</span></div>
          <div class="flex items-center gap-2 col-span-full"><span class="text-amber-600">△ 第三順位</span><span>5日量比 1.5～5x 不限委買比　→ 量增觀察，委買資料不足時仍列入（不與一、二重複）</span></div>

          <div class="font-semibold text-gray-500 col-span-full mt-2">委買可信度（假掛單過濾）</div>
          <div class="text-gray-600 col-span-full text-xs mb-0.5">
            假掛單手法：主力先掛出大量委買造成護盤假象，待散戶追價後悄悄撤單。<br>
            系統每 30 分鐘對所有漲停股拍攝委買快照，並以三項指標判斷委買真實性：
          </div>
          <div class="flex items-start gap-2 col-span-full">
            <span class="text-green-400 font-bold whitespace-nowrap">① 快照持續性</span>
            <span>委買需在 ≥ 2 次快照中出現（間距 30 分鐘）。僅出現一次即排除，因真實護盤方不敢讓委買消失超過半小時。</span>
          </div>
          <div class="flex items-start gap-2 col-span-full">
            <span class="text-green-400 font-bold whitespace-nowrap">② 委買穩定性</span>
            <span>各快照的平均委買量 ÷ 最大委買量 ≥ 0.25。假掛單通常「早盤衝高、盤中撤掉」，使平均值遠低於峰值；真實護盤則全天穩定。</span>
          </div>
          <div class="flex items-start gap-2 col-span-full">
            <span class="text-green-400 font-bold whitespace-nowrap">③ 收盤前委買</span>
            <span>若未漲停收盤，收盤快照委買量必須 &gt; 0；否則代表委買在收盤前被撤走（假掛單最常見的收尾方式）。</span>
          </div>
          <div class="flex items-center gap-2 col-span-full mt-0.5">
            <span class="text-green-400">●高</span><span>三項全通過（快照 ≥ 3、穩定性 ≥ 0.5、收盤有委買）</span>
          </div>
          <div class="flex items-center gap-2 col-span-full">
            <span class="text-yellow-400">●中</span><span>快照 ≥ 2 且穩定性 ≥ 0.25（收盤資料待確認）</span>
          </div>
          <div class="flex items-center gap-2 col-span-full">
            <span class="text-red-400">●低</span><span>未通過過濾（不應出現在觀察區，若出現代表剛進入第一個快照周期）</span>
          </div>
          <div class="flex items-center gap-2 col-span-full">
            <span class="text-gray-600">－</span><span>無快照資料（歷史資料、或今日首次入選尚未完成第二次快照）</span>
          </div>
        </div>
      </div>

      <!-- 錯誤 -->
      <div v-if="moversError" class="bg-red-900/30 border border-red-800 rounded-xl px-4 py-3 text-sm text-red-400">{{ moversError }}</div>

      <!-- Loading skeleton -->
      <div v-if="moversLoading && !moversGainers.length" class="text-center py-20 text-gray-500 text-sm">資料載入中，請稍候...</div>

      <!-- 非交易時段提示 -->
      <div v-if="!moversLoading && !moversDate && !moversGainers.length && !moversLosers.length" class="text-center py-20 space-y-3">
        <div class="text-gray-500 text-sm">
          {{ isMarketHours() ? '市場剛開盤，資料更新中…' : '非交易時段，目前無即時資料' }}
        </div>
        <button @click="fetchMovers()" class="px-4 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-700 transition">
          手動重新整理
        </button>
      </div>

      <!-- 兩欄排行表 -->
      <div v-if="moversGainers.length || moversLosers.length" class="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <!-- 漲幅排行 -->
        <div class="bg-gray-900 rounded-xl border border-gray-800">
          <div class="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <span class="text-red-400 font-semibold text-sm">▲ 漲停個股</span>
            <span class="ml-auto text-xs text-gray-500">{{ limitUpDisplay.length }} 支</span>
          </div>
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10">
              <tr class="text-xs text-gray-500 border-b border-gray-800 bg-gray-900">
                <th class="px-3 py-2 text-left w-8">#</th>
                <th class="px-3 py-2 text-left">代號／名稱</th>
                <th class="px-3 py-2 text-right">昨日價格</th>
                <th class="px-3 py-2 text-right">現價</th>
                <th class="px-3 py-2 text-right leading-tight">漲跌幅<br><span class="text-gray-600">(連續天數)</span></th>
                <th class="px-3 py-2 text-right">5日均量</th>
                <th class="px-3 py-2 text-right">1日量</th>
                <th class="px-3 py-2 text-right leading-tight">今日成交量<br><span class="text-gray-600">(漲停委買量)</span></th>
                <th class="px-3 py-2 text-right leading-tight">成交金額<br><span class="text-gray-600">(億元)</span></th>
                <th class="px-3 py-2 text-right leading-tight">漲停委買比<br><span class="text-gray-600">委買量÷成交量</span></th>
                <th class="px-3 py-2 text-right leading-tight">1日量比<br><span class="text-gray-600">今÷昨</span></th>
                <th class="px-3 py-2 text-right leading-tight">5日量比<br><span class="text-gray-600">今÷5日均</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in limitUpDisplay" :key="r.stockNo"
                  class="border-b border-gray-800/50 transition"
                  :class="rowBgClass(r)">
                <td class="px-3 py-2 text-gray-600 text-xs">{{ i + 1 }}</td>
                <td class="px-3 py-2">
                  <div class="flex items-center gap-1">
                    <span class="text-white font-medium hover:text-purple-400 transition cursor-pointer" @click="goToWarrant(r.stockNo)">{{ r.stockName }}</span>
                    <span v-if="r.earlyLimitUp" class="text-yellow-300 text-xs" title="開盤一小時內漲停">⚡</span>
                    <span v-if="warrantCoveredSet.has(r.stockNo)"
                      class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded cursor-pointer hover:bg-purple-800/80 transition"
                      title="有券商發行權證，點此查詢" @click.stop="goToWarrant(r.stockNo)">有證</span>
                  </div>
                  <div class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted" @click.stop="openQuote(r.stockNo)">{{ r.stockNo }}</div>
                </td>
                <td class="px-3 py-2 text-right text-gray-400 font-mono text-xs">{{ fmtPrice(r.prevClose) }}</td>
                <td class="px-3 py-2 text-right text-red-300 font-mono">{{ fmtPrice(r.price) }}</td>
                <td class="px-3 py-2 text-right font-bold text-red-400">
                  +{{ r.changePct.toFixed(1) }}%<span v-if="r.limitDays" class="text-yellow-400"> ({{ r.limitDays }})</span>
                </td>
                <td class="px-3 py-2 text-right text-gray-400 font-mono text-xs">{{ r.volMa5 != null ? r.volMa5.toLocaleString() : '-' }}</td>
                <td class="px-3 py-2 text-right text-gray-500 font-mono text-xs">{{ r.prevVol != null ? r.prevVol.toLocaleString() : '-' }}</td>
                <td class="px-3 py-2 text-right font-mono text-xs"
                    :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : r.limitBidVol && r.limitBidVol / r.volume > 1.6 ? 'text-red-300' : 'text-gray-400'">
                  {{ r.volume.toLocaleString() }}<span v-if="r.limitBidVol" :class="r.limitBidVol / r.volume > 1.6 ? 'text-green-400' : 'text-gray-500'"> ({{ r.limitBidVol.toLocaleString() }})</span>
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs text-gray-300">
                  {{ r.turnover != null ? r.turnover.toFixed(1) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                  {{ r.limitBidVol && r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio1dClass(r)">
                  {{ r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                  {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : '-' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 跌幅排行 -->
        <div class="bg-gray-900 rounded-xl border border-gray-800">
          <div class="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <span class="text-green-400 font-semibold text-sm">▼ 跌停個股</span>
            <span class="ml-auto text-xs text-gray-500">{{ limitDownDisplay.length }} 支</span>
          </div>
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10">
              <tr class="text-xs text-gray-500 border-b border-gray-800 bg-gray-900">
                <th class="px-3 py-2 text-left w-8">#</th>
                <th class="px-3 py-2 text-left">代號／名稱</th>
                <th class="px-3 py-2 text-right">昨日價格</th>
                <th class="px-3 py-2 text-right">現價</th>
                <th class="px-3 py-2 text-right leading-tight">漲跌幅<br><span class="text-gray-600">(連續天數)</span></th>
                <th class="px-3 py-2 text-right">5日均量</th>
                <th class="px-3 py-2 text-right">1日量</th>
                <th class="px-3 py-2 text-right leading-tight">今日成交量<br><span class="text-gray-600">(漲停委買量)</span></th>
                <th class="px-3 py-2 text-right leading-tight">成交金額<br><span class="text-gray-600">(億元)</span></th>
                <th class="px-3 py-2 text-right leading-tight">漲停委買比<br><span class="text-gray-600">委買量÷成交量</span></th>
                <th class="px-3 py-2 text-right leading-tight">1日量比<br><span class="text-gray-600">今÷昨</span></th>
                <th class="px-3 py-2 text-right leading-tight">5日量比<br><span class="text-gray-600">今÷5日均</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in limitDownDisplay" :key="r.stockNo"
                  class="border-b border-gray-800/50 transition"
                  :class="rowBgClass(r)">
                <td class="px-3 py-2 text-gray-600 text-xs">{{ i + 1 }}</td>
                <td class="px-3 py-2">
                  <div class="flex items-center gap-1">
                    <span class="text-white font-medium hover:text-purple-400 transition cursor-pointer" @click="goToWarrant(r.stockNo)">{{ r.stockName }}</span>
                    <span v-if="warrantCoveredSet.has(r.stockNo)"
                      class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded cursor-pointer hover:bg-purple-800/80 transition"
                      title="有券商發行權證，點此查詢" @click.stop="goToWarrant(r.stockNo)">有證</span>
                  </div>
                  <div class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted" @click.stop="openQuote(r.stockNo)">{{ r.stockNo }}</div>
                </td>
                <td class="px-3 py-2 text-right text-gray-400 font-mono text-xs">{{ fmtPrice(r.prevClose) }}</td>
                <td class="px-3 py-2 text-right text-green-300 font-mono">{{ fmtPrice(r.price) }}</td>
                <td class="px-3 py-2 text-right font-bold text-green-400">
                  {{ r.changePct.toFixed(1) }}%<span v-if="r.limitDays" class="text-yellow-400"> ({{ r.limitDays }})</span>
                </td>
                <td class="px-3 py-2 text-right text-gray-400 font-mono text-xs">{{ r.volMa5 != null ? r.volMa5.toLocaleString() : '-' }}</td>
                <td class="px-3 py-2 text-right text-gray-500 font-mono text-xs">{{ r.prevVol != null ? r.prevVol.toLocaleString() : '-' }}</td>
                <td class="px-3 py-2 text-right font-mono text-xs"
                    :class="r.volume >= 100000 ? 'text-rose-400 font-bold' : r.limitBidVol && r.limitBidVol / r.volume > 1.6 ? 'text-red-300' : 'text-gray-400'">
                  {{ r.volume.toLocaleString() }}<span v-if="r.limitBidVol" :class="r.limitBidVol / r.volume > 1.6 ? 'text-green-400' : 'text-gray-500'"> ({{ r.limitBidVol.toLocaleString() }})</span>
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs text-gray-300">
                  {{ r.turnover != null ? r.turnover.toFixed(1) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="bidRatioClass(r)">
                  {{ r.limitBidVol && r.volume ? (r.limitBidVol / r.volume).toFixed(2) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio1dClass(r)">
                  {{ r.prevVol ? (r.volume / r.prevVol).toFixed(2) : '-' }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs" :class="volRatio5dClass(r)">
                  {{ r.volMa5 ? (r.volume / r.volMa5).toFixed(2) : '-' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>

      <div class="text-right text-xs text-gray-700">
        {{ moversRealtime ? '今日即時：TWSE MIS，每 60 秒自動刷新' : '歷史資料：DB market_daily' }}
      </div>
    </div>

    <!-- ══ 庫藏股買回 ══════════════════════════════════════════ -->
    <div v-if="tab === 'buyback'" class="max-w-7xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold text-white">庫藏股買回公告</h2>
          <span class="text-xs text-gray-500">資料來源：MOPS 公開資訊觀測站</span>
        </div>
        <button @click="fetchBuyback" :disabled="buybackLoading"
          class="px-3 py-1.5 text-xs rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50">
          {{ buybackLoading ? '載入中...' : '重新整理' }}
        </button>
      </div>

      <!-- 篩選列 -->
      <div class="flex flex-wrap gap-3 items-center">
        <div class="flex gap-1">
          <button v-for="m in ['all', '上市', '上櫃']" :key="m"
            @click="buybackFilter = m"
            class="px-3 py-1 text-xs rounded border"
            :class="buybackFilter === m ? 'bg-purple-700 border-purple-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-400'">
            {{ m === 'all' ? '全部' : m }}
          </button>
        </div>
        <input v-model="buybackSearch" placeholder="搜尋代碼或名稱…"
          class="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-600 text-gray-200 placeholder-gray-600 w-40">
        <span class="text-xs text-gray-600 ml-auto">
          共 {{ buybackFiltered.length }} 筆
          <template v-if="buybackUpdated"> · 更新於 {{ new Date(buybackUpdated).toLocaleString('zh-TW') }}</template>
        </span>
      </div>

      <!-- 錯誤 -->
      <div v-if="buybackError" class="text-red-400 text-sm">{{ buybackError }}</div>

      <!-- 載入中 -->
      <div v-if="buybackLoading && !buybackRows.length" class="text-center py-16 text-gray-500">
        載入庫藏股資料中，請稍候...（初次載入約需 10-20 秒）
      </div>

      <!-- 空白提示 -->
      <div v-if="!buybackLoading && !buybackRows.length && !buybackError"
        class="text-center py-16 text-gray-600 text-sm">
        尚無資料，請點擊「重新整理」載入
      </div>

      <!-- 主表格 -->
      <div v-if="buybackFiltered.length" class="overflow-x-auto rounded-lg border border-gray-700">
        <table class="w-full text-xs">
          <thead class="bg-gray-800 text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left">市場</th>
              <th class="px-3 py-2 text-left">代碼</th>
              <th class="px-3 py-2 text-left">公司名稱</th>
              <th class="px-3 py-2 text-right">即時股價</th>
              <th class="px-3 py-2 text-right">漲跌幅</th>
              <th class="px-3 py-2 text-right">區間中位數</th>
              <th class="px-3 py-2 text-right">溢價比</th>
              <th class="px-3 py-2 text-center">決議日</th>
              <th class="px-3 py-2 text-center">預定買回區間</th>
              <th class="px-3 py-2 text-center">買回價格區間（元）</th>
              <th class="px-3 py-2 text-right">預定買回張數</th>
              <th class="px-3 py-2 text-center">目的</th>
              <th class="px-3 py-2 text-center">狀態</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-800">
            <tr v-for="r in buybackFiltered" :key="r.stockNo + r.resolveDate"
              class="hover:bg-gray-800/50 transition">
              <td class="px-3 py-2">
                <span class="text-xs px-1.5 py-0.5 rounded"
                  :class="r.market === '上市' ? 'bg-blue-900/50 text-blue-300' : 'bg-green-900/50 text-green-300'">
                  {{ r.market }}
                </span>
              </td>
              <td class="px-3 py-2 font-mono font-semibold text-yellow-300">{{ r.stockNo }}</td>
              <td class="px-3 py-2 text-white font-medium">{{ r.stockName }}</td>
              <td class="px-3 py-2 text-right font-mono font-semibold"
                  :class="r.priceInfo ? (r.priceInfo.changePct > 0 ? 'text-red-400' : r.priceInfo.changePct < 0 ? 'text-green-400' : 'text-gray-300') : ''">
                <template v-if="r.priceInfo">{{ r.priceInfo.price }}</template>
                <span v-else class="text-gray-700">—</span>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs"
                  :class="r.priceInfo ? (r.priceInfo.changePct > 0 ? 'text-red-500' : r.priceInfo.changePct < 0 ? 'text-green-500' : 'text-gray-500') : ''">
                <template v-if="r.priceInfo">{{ r.priceInfo.changePct > 0 ? '+' : '' }}{{ r.priceInfo.changePct }}%</template>
                <span v-else class="text-gray-700">—</span>
              </td>
              <td class="px-3 py-2 text-right font-mono text-yellow-200">
                <template v-if="r.minPrice != null && r.maxPrice != null">
                  {{ ((+r.minPrice + +r.maxPrice) / 2).toFixed(1) }}
                </template>
                <span v-else class="text-gray-700">—</span>
              </td>
              <td class="px-3 py-2 text-right font-mono font-semibold"
                  :class="r.priceInfo && r.minPrice != null && r.maxPrice != null
                    ? ((+r.minPrice + +r.maxPrice) / 2 - r.priceInfo.price) / r.priceInfo.price * 100 > 0 ? 'text-red-400' : 'text-green-400'
                    : ''">
                <template v-if="r.priceInfo && r.minPrice != null && r.maxPrice != null">
                  {{ (pct => (pct > 0 ? '+' : '') + pct.toFixed(1) + '%')(((+r.minPrice + +r.maxPrice) / 2 - r.priceInfo.price) / r.priceInfo.price * 100) }}
                </template>
                <span v-else class="text-gray-700">—</span>
              </td>
              <td class="px-3 py-2 text-center text-gray-300 font-mono">{{ r.resolveDate }}</td>
              <td class="px-3 py-2 text-center text-gray-300 font-mono whitespace-nowrap">
                {{ r.periodStart }} ~ {{ r.periodEnd }}
              </td>
              <td class="px-3 py-2 text-center font-mono">
                <span class="text-green-400">{{ r.minPrice }}</span>
                <span class="text-gray-500"> ~ </span>
                <span class="text-red-400">{{ r.maxPrice }}</span>
              </td>
              <td class="px-3 py-2 text-right font-mono text-purple-300">
                {{ r.plannedLots.toLocaleString() }}
              </td>
              <td class="px-3 py-2 text-center text-gray-400 text-xs">
                {{ buybackPurposeLabel(r.purpose) }}
              </td>
              <td class="px-3 py-2 text-center">
                <span class="px-1.5 py-0.5 rounded text-xs"
                  :class="r.completed ? 'bg-gray-700 text-gray-400' : 'bg-emerald-900/50 text-emerald-300'">
                  {{ r.completed ? '執行完畢' : '執行中' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="text-right text-xs text-gray-700">
        資料範圍：近 6 個月董事會決議 · 上市 + 上櫃 · MOPS t35sc09 · 每 2 小時快取
      </div>
    </div>

    <!-- ══ 三維財務分析 ══════════════════════════════════════ -->
    <div v-if="tab === 'finance'" class="max-w-5xl mx-auto px-4 py-6 space-y-5">

      <!-- 搜尋列 -->
      <div class="flex items-center gap-3 flex-wrap">
        <h2 class="text-lg font-semibold text-white">三維財務分析</h2>
        <span class="text-xs text-gray-500">Yahoo Finance · 最近 4 年損益表 · 可輸入代號或名稱</span>
      </div>
      <div class="flex gap-2 items-center">
        <div class="relative">
          <input v-model="finStockNo" @input="onFinInput" @keyup.enter="fetchFinance" @blur="() => setTimeout(() => { finShowSuggestions.value = false }, 150)"
                 type="text" placeholder="代號或名稱，例：2330 或 台積電"
                 class="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 w-56 focus:outline-none focus:border-blue-500" />
          <div v-if="finShowSuggestions && finSuggestions.length"
               class="absolute z-50 top-full left-0 mt-1 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
            <div v-for="item in finSuggestions" :key="item.no"
                 @mousedown.prevent="selectFinSuggestion(item)"
                 class="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 cursor-pointer text-sm">
              <span class="text-blue-400 font-mono w-12 shrink-0">{{ item.no }}</span>
              <span class="text-gray-200 truncate">{{ item.name }}</span>
            </div>
          </div>
        </div>
        <button @click="fetchFinance" :disabled="finLoading"
                class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-sm font-medium transition disabled:opacity-50">
          {{ finLoading ? '分析中...' : '開始分析' }}
        </button>
        <span v-if="finData" class="text-xs text-gray-500">快取 4 小時 · {{ finData.source ?? 'Yahoo Finance' }} · {{ new Date(finData.fetchedAt).toLocaleString('zh-TW') }}</span>
      </div>

      <p v-if="finError" class="text-red-400 text-sm bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3">{{ finError }}</p>

      <!-- 主畫面 -->
      <div v-if="finData">
        <!-- 公司標題 -->
        <div class="bg-gradient-to-r from-blue-900/40 to-purple-900/30 border border-blue-800/40 rounded-xl px-5 py-4 mb-4">
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-xl font-bold text-white">{{ finData.stockName }}</span>
            <span class="text-gray-400 font-mono text-sm">{{ finData.stockNo }}</span>
            <span class="text-xs px-2 py-0.5 rounded bg-blue-900/50 text-blue-300">年報分析</span>
            <span class="text-xs text-gray-500 ml-auto">資料年度：{{ finData.years.join(' / ') }}</span>
          </div>
        </div>

        <!-- 三個子分頁 -->
        <div class="flex gap-1 border-b border-gray-800 mb-5">
          <button v-for="t in [{ id:'ops', label:'📊 經營分析' }, { id:'profit', label:'💰 獲利分析' }, { id:'health', label:'🏦 財務健全度' }]"
                  :key="t.id" @click="finSubTab = t.id"
                  class="px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px"
                  :class="finSubTab === t.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'">
            {{ t.label }}
          </button>
        </div>

        <!-- ── 經營分析 ── -->
        <div v-if="finSubTab === 'ops'" class="space-y-5">
          <!-- KPI -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div v-for="yr in finData.years" :key="yr" class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">{{ yr }} 營收</div>
              <div class="text-lg font-bold text-blue-300">{{ finData.metrics[yr]?.revenue != null ? finData.metrics[yr].revenue.toLocaleString() : '—' }} <span class="text-xs font-normal text-gray-500">億</span></div>
              <div class="text-xs mt-1" :class="(finData.metrics[yr]?.grossMargin ?? 0) >= 30 ? 'text-green-400' : 'text-gray-400'">毛利率 {{ finData.metrics[yr]?.grossMargin != null ? finData.metrics[yr].grossMargin + '%' : '—' }}</div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">營業利益率（最新）</div>
              <div class="text-lg font-bold text-orange-300">{{ finData.metrics[finData.years[0]]?.opMargin != null ? finData.metrics[finData.years[0]].opMargin + '%' : '—' }}</div>
              <div class="text-xs text-gray-500 mt-1">稅後淨利率 {{ finData.metrics[finData.years[0]]?.netMargin != null ? finData.metrics[finData.years[0]].netMargin + '%' : '—' }}</div>
            </div>
          </div>
          <!-- 圖表 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">營收趨勢與毛利率</div>
              <div style="height:220px"><canvas id="fc-revenue"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">營收 vs 淨利對比</div>
              <div style="height:220px"><canvas id="fc-opex"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 md:col-span-2">
              <div class="text-xs text-gray-400 mb-2 font-medium">三層利潤率趨勢</div>
              <div style="height:220px"><canvas id="fc-opmargin"></canvas></div>
            </div>
          </div>
          <!-- 數據表 -->
          <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full text-xs">
              <thead class="bg-gray-800 text-gray-400">
                <tr><th class="px-4 py-2 text-left">指標</th><th v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right">{{ yr }}</th></tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="row in [
                  { label:'營業收入（億）', key:'revenue' },
                  { label:'毛利（億）', key:'grossProfit' },
                  { label:'毛利率', key:'grossMargin', pct:true },
                  { label:'營業利益（億）', key:'opIncome' },
                  { label:'營業利益率', key:'opMargin', pct:true },
                  { label:'推銷費用（億）', key:'sellExp' },
                  { label:'管理費用（億）', key:'adminExp' },
                  { label:'研發費用（億）', key:'rdExp' },
                ]" :key="row.key" class="hover:bg-gray-800/40">
                  <td class="px-4 py-2 text-gray-400">{{ row.label }}</td>
                  <td v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right font-mono text-gray-200">
                    {{ finData.metrics[yr]?.[row.key] != null ? (row.pct ? finData.metrics[yr][row.key] + '%' : finData.metrics[yr][row.key].toLocaleString()) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── 獲利分析 ── -->
        <div v-if="finSubTab === 'profit'" class="space-y-5">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div v-for="yr in finData.years" :key="yr" class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">{{ yr }} EPS</div>
              <div class="text-lg font-bold text-yellow-300">{{ finData.metrics[yr]?.eps != null ? finData.metrics[yr].eps : '—' }} <span class="text-xs font-normal text-gray-500">元</span></div>
              <div class="text-xs mt-1 text-gray-400">淨利率 {{ finData.metrics[yr]?.netMargin != null ? finData.metrics[yr].netMargin + '%' : '—' }}</div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">ROE / ROA（最新）</div>
              <div class="text-base font-bold text-orange-300">{{ finData.metrics[finData.years[0]]?.roe != null ? finData.metrics[finData.years[0]].roe + '%' : '—' }}</div>
              <div class="text-xs text-gray-400 mt-0.5">ROA {{ finData.metrics[finData.years[0]]?.roa != null ? finData.metrics[finData.years[0]].roa + '%' : '—' }}</div>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">稅後淨利與淨利率</div>
              <div style="height:220px"><canvas id="fc-netincome"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">每股盈餘（EPS）</div>
              <div style="height:220px"><canvas id="fc-eps"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 md:col-span-2">
              <div class="text-xs text-gray-400 mb-2 font-medium">ROE / ROA 趨勢</div>
              <div style="height:220px"><canvas id="fc-roe"></canvas></div>
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full text-xs">
              <thead class="bg-gray-800 text-gray-400">
                <tr><th class="px-4 py-2 text-left">指標</th><th v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right">{{ yr }}</th></tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="row in [
                  { label:'稅後淨利（億）', key:'netIncome' },
                  { label:'淨利率', key:'netMargin', pct:true },
                  { label:'EPS（元）', key:'eps' },
                  { label:'ROE', key:'roe', pct:true },
                  { label:'ROA', key:'roa', pct:true },
                ]" :key="row.key" class="hover:bg-gray-800/40">
                  <td class="px-4 py-2 text-gray-400">{{ row.label }}</td>
                  <td v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right font-mono text-gray-200">
                    {{ finData.metrics[yr]?.[row.key] != null ? (row.pct ? finData.metrics[yr][row.key] + '%' : finData.metrics[yr][row.key].toLocaleString()) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── 財務健全度 ── -->
        <div v-if="finSubTab === 'health'" class="space-y-5">
          <div class="text-xs text-yellow-600/80 bg-yellow-900/10 border border-yellow-800/30 rounded-lg px-3 py-2">
            財務健全度數據來源為 Yahoo Finance，流動比率 / 自由現金流 僅顯示最近一期數據；負債比率、現金部位等資料暫不提供。
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">流動比率（最新）</div>
              <div class="text-lg font-bold" :class="(finData.metrics[finData.years[0]]?.currentRatio ?? 0) >= 200 ? 'text-green-400' : (finData.metrics[finData.years[0]]?.currentRatio ?? 0) >= 150 ? 'text-yellow-400' : 'text-red-400'">
                {{ finData.metrics[finData.years[0]]?.currentRatio != null ? finData.metrics[finData.years[0]].currentRatio + '%' : '—' }}
              </div>
              <div class="text-xs mt-1 text-gray-500">負債比率 —</div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">ROE（最新）</div>
              <div class="text-lg font-bold text-orange-300">{{ finData.metrics[finData.years[0]]?.roe != null ? finData.metrics[finData.years[0]].roe + '%' : '—' }}</div>
              <div class="text-xs mt-1 text-gray-400">ROA {{ finData.metrics[finData.years[0]]?.roa != null ? finData.metrics[finData.years[0]].roa + '%' : '—' }}</div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">自由現金流（最新）</div>
              <div class="text-base font-bold" :class="(finData.metrics[finData.years[0]]?.fcf ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
                {{ finData.metrics[finData.years[0]]?.fcf != null ? finData.metrics[finData.years[0]].fcf.toLocaleString() : '—' }} <span class="text-xs font-normal text-gray-500">億</span>
              </div>
              <div class="text-xs text-gray-500 mt-0.5">Free Cash Flow</div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div class="text-xs text-gray-500 mb-1">營業現金流（最新）</div>
              <div class="text-base font-bold" :class="(finData.metrics[finData.years[0]]?.operatingCF ?? 0) >= 0 ? 'text-blue-300' : 'text-red-400'">
                {{ finData.metrics[finData.years[0]]?.operatingCF != null ? finData.metrics[finData.years[0]].operatingCF.toLocaleString() : '—' }} <span class="text-xs font-normal text-gray-500">億</span>
              </div>
              <div class="text-xs text-gray-500 mt-0.5">Operating Cash Flow</div>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 md:col-span-2">
              <div class="text-xs text-gray-400 mb-2 font-medium">營業現金流 / 自由現金流（最新一期）</div>
              <div style="height:220px"><canvas id="fc-cf"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">流動比率（最新一期）</div>
              <div style="height:220px"><canvas id="fc-ratios"></canvas></div>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-400 mb-2 font-medium">ROE / ROA 趨勢</div>
              <div style="height:220px"><canvas id="fc-cash"></canvas></div>
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full text-xs">
              <thead class="bg-gray-800 text-gray-400">
                <tr><th class="px-4 py-2 text-left">指標</th><th v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right">{{ yr }}</th></tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="row in [
                  { label:'現金及約當現金（億）', key:'cash' },
                  { label:'流動資產（億）', key:'currentAssets' },
                  { label:'流動負債（億）', key:'currentLiabilities' },
                  { label:'流動比率', key:'currentRatio', pct:true },
                  { label:'總資產（億）', key:'totalAssets' },
                  { label:'負債總額（億）', key:'totalLiabilities' },
                  { label:'負債比率', key:'debtRatio', pct:true },
                  { label:'股東權益（億）', key:'equity' },
                  { label:'營業現金流（億）', key:'operatingCF' },
                  { label:'投資現金流（億）', key:'investingCF' },
                  { label:'融資現金流（億）', key:'financingCF' },
                  { label:'自由現金流（億）', key:'fcf' },
                ]" :key="row.key" class="hover:bg-gray-800/40">
                  <td class="px-4 py-2 text-gray-400">{{ row.label }}</td>
                  <td v-for="yr in finData.years" :key="yr" class="px-4 py-2 text-right font-mono"
                      :class="['operatingCF','fcf'].includes(row.key) ? ((finData.metrics[yr]?.[row.key] ?? 0) >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-200'">
                    {{ finData.metrics[yr]?.[row.key] != null ? (row.pct ? finData.metrics[yr][row.key] + '%' : finData.metrics[yr][row.key].toLocaleString()) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="text-xs text-gray-600 text-right">資料來源：Goodinfo.tw ／ 僅供參考，不構成投資建議</div>
      </div>
    </div>

    <!-- ══ 處置股 ══════════════════════════════════════════ -->
    <div v-if="tab === 'disposal'" class="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div class="flex items-center gap-3 flex-wrap">
        <h2 class="text-lg font-semibold text-white">處置股</h2>
        <span class="text-xs text-gray-500">TWSE 公布處置有價證券 · 每 30 分鐘快取</span>
        <span v-if="disposalRows.length" class="text-xs px-2 py-0.5 rounded bg-orange-900/40 text-orange-300 font-semibold">
          處置中 {{ disposalRows.filter(r => r.isActive).length }} 筆
        </span>
        <div class="ml-auto flex items-center gap-2">
          <input v-model="disposalSearch" placeholder="搜尋代碼/名稱" class="px-2 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 placeholder-gray-600 w-32 focus:outline-none focus:border-gray-500" />
          <button @click="fetchDisposal" :disabled="disposalLoading" class="px-3 py-1.5 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 disabled:opacity-50 transition">
            {{ disposalLoading ? '載入中...' : '刷新' }}
          </button>
        </div>
      </div>

      <div v-if="disposalUpdated" class="text-xs text-gray-600">資料時間：{{ disposalUpdated }}</div>
      <div v-if="disposalError" class="bg-red-900/30 border border-red-800 rounded-xl px-4 py-3 text-sm text-red-400">{{ disposalError }}</div>
      <div v-if="disposalLoading && !disposalRows.length" class="text-center py-20 text-gray-500 text-sm">載入中，請稍候...</div>

      <div v-if="!disposalLoading && !disposalRows.length && !disposalError" class="text-center py-20 text-gray-600 text-sm">尚無資料，請點「刷新」</div>

      <div v-if="disposalFiltered.length" class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-950 text-xs text-gray-500 font-normal">
              <th class="px-3 py-2 text-left">代號／名稱</th>
              <th class="px-3 py-2 text-center">措施</th>
              <th class="px-3 py-2 text-center">累計</th>
              <th class="px-3 py-2 text-left">處置條件</th>
              <th class="px-3 py-2 text-center">公布日期</th>
              <th class="px-3 py-2 text-center">處置期間</th>
              <th class="px-3 py-2 text-center">剩餘天數</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in disposalFiltered" :key="r.stockNo + r.periodStr"
                class="border-b border-gray-800/50 transition hover:bg-gray-800/30"
                :class="!r.isActive ? 'opacity-40' : ''">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="text-white font-medium cursor-pointer hover:text-purple-400 transition" @click="goToWarrant(r.stockNo)">{{ r.stockName }}</span>
                  <span v-if="warrantCoveredSet.has(r.stockNo)" class="text-xs bg-purple-900/60 text-purple-300 px-1 py-0.5 rounded cursor-pointer hover:bg-purple-800/80 transition" @click.stop="goToWarrant(r.stockNo)" title="有券商發行權證">有證</span>
                </div>
                <div class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted" @click.stop="openQuote(r.stockNo)">{{ r.stockNo }}</div>
              </td>
              <td class="px-3 py-2 text-center">
                <span class="text-xs px-1.5 py-0.5 rounded font-semibold"
                  :class="r.measure === '第一次處置' ? 'bg-yellow-900/50 text-yellow-300' : 'bg-red-900/50 text-red-300'">
                  {{ r.measure }}
                </span>
              </td>
              <td class="px-3 py-2 text-center">
                <span class="text-xs font-mono" :class="r.count >= 3 ? 'text-red-400 font-bold' : r.count === 2 ? 'text-orange-400' : 'text-gray-400'">
                  {{ r.count }}次
                </span>
              </td>
              <td class="px-3 py-2 text-xs text-gray-400">{{ r.condition }}</td>
              <td class="px-3 py-2 text-center text-xs text-gray-500 font-mono">{{ r.announceDate }}</td>
              <td class="px-3 py-2 text-center text-xs text-gray-400 font-mono whitespace-nowrap">{{ r.periodStr }}</td>
              <td class="px-3 py-2 text-center font-mono text-xs font-bold"
                  :class="!r.isActive ? (r.isFuture ? 'text-blue-400' : 'text-gray-600') : r.daysLeft <= 3 ? 'text-red-400' : r.daysLeft <= 7 ? 'text-orange-400' : 'text-green-400'">
                {{ r.isActive ? r.daysLeft + '天' : r.isFuture ? '未開始' : '已到期' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="text-xs text-gray-700 grid grid-cols-1 sm:grid-cols-2 gap-1">
        <span><span class="text-yellow-300">黃色</span> 第一次處置　<span class="text-red-300">紅色</span> 再次處置</span>
        <span><span class="text-green-400">綠色</span> 剩餘 &gt;7天　<span class="text-orange-400">橙色</span> ≤7天　<span class="text-red-400">紅色</span> ≤3天</span>
        <span>措施：以人工撮合（約每5分鐘一次）＋超過限額需繳保證金</span>
        <span>資料來源：TWSE 公告處置有價證券（上市股票）</span>
      </div>
    </div>

  </div>

  <!-- 情境分析 Modal -->
  <Teleport to="body">
    <div v-if="scenarioVisible" class="fixed inset-0 z-50 flex items-center justify-center" @click.self="scenarioVisible=false">
      <div class="absolute inset-0 bg-black/75"></div>
      <div class="relative bg-gray-950 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col" style="max-width:92vw;max-height:90vh">
        <!-- 標題 -->
        <div class="flex items-center justify-between px-4 py-2.5 bg-gray-900 border-b border-gray-800 shrink-0">
          <div class="flex items-baseline gap-2">
            <span class="text-yellow-400 font-bold text-sm">情境分析－權證價格</span>
            <span class="text-gray-400 text-xs">{{ scenarioWarrant?.warrantName }}</span>
          </div>
          <div class="flex items-center gap-3 text-xs text-gray-500">
            <span>標的現價 {{ scenarioWarrant?.stockPrice?.toFixed(2) }}</span>
            <span>履約價 {{ scenarioWarrant?.strike }}</span>
            <span>剩餘 {{ scenarioWarrant?.daysLeft }} 天</span>
            <span>IV {{ scenarioWarrant?.iv?.toFixed(1) }}%</span>
            <span v-if="scenarioWarrant?.dividendYield" class="text-green-500">殖利率 {{ scenarioWarrant.dividendYield }}%（已調整）</span>
            <button @click="scenarioVisible=false" class="text-gray-500 hover:text-white px-1">✕</button>
          </div>
        </div>
        <!-- 表格 -->
        <div class="overflow-auto p-3">
          <div v-if="!scenarioTable" class="text-gray-500 text-sm py-8 px-6 text-center">缺少計算所需資料（需有 IV、履約價、剩餘天數）</div>
          <table v-else class="text-xs border-collapse">
            <thead>
              <tr>
                <th class="px-4 py-2 text-left text-gray-400 font-medium whitespace-nowrap border border-gray-800 bg-gray-900">標的價格 / 隱含波動率</th>
                <th v-for="iv in scenarioTable.ivCols" :key="iv"
                    class="px-4 py-2 text-center font-semibold border border-gray-800 bg-gray-900"
                    :class="iv === scenarioWarrant.iv ? 'text-yellow-400' : 'text-gray-300'">
                  {{ iv.toFixed(1) }}%
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scenarioTable.rows" :key="row.pct"
                  :class="row.pct === 0 ? 'bg-gray-800' : ''">
                <td class="px-4 py-2 whitespace-nowrap border border-gray-800"
                    :class="row.pct === 0 ? 'text-white font-bold' : row.pct > 0 ? 'text-red-400' : 'text-green-400'">
                  {{ row.S.toFixed(2) }}
                  <span class="ml-1 text-xs" :class="row.pct === 0 ? 'text-gray-400' : row.pct > 0 ? 'text-red-500' : 'text-green-500'">
                    {{ row.pct === 0 ? '（市價）' : (row.pct > 0 ? '+' : '') + row.pct + '%' }}
                  </span>
                </td>
                <td v-for="(p, i) in row.prices" :key="i"
                    class="px-4 py-2 text-center border border-gray-800"
                    :class="[
                      row.pct === 0 ? 'font-bold text-lg' : '',
                      row.pct > 0 ? 'text-red-400' : row.pct < 0 ? 'text-green-400' : 'text-white',
                      i === scenarioTable.currentIVIdx && row.pct === 0 ? 'bg-yellow-900/30' : ''
                    ]">
                  {{ p != null ? p.toFixed(2) : '—' }}
                  <template v-if="i === scenarioTable.currentIVIdx && row.pct === 0 && scenarioWarrant.price != null">
                    <div class="text-xs font-normal mt-0.5"
                         :class="Math.abs(p - scenarioWarrant.price) < 0.01 ? 'text-gray-500' : 'text-yellow-400'">
                      市價 {{ scenarioWarrant.price.toFixed(2) }}
                    </div>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 五檔報價 Modal -->
  <Teleport to="body">
    <div v-if="quoteVisible" class="fixed inset-0 z-50 flex items-center justify-center" @click.self="closeQuote">
      <div class="absolute inset-0 bg-black/75"></div>
      <div class="relative bg-black border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col" style="width:340px;max-height:90vh">

        <!-- 標題列 -->
        <div class="flex items-center justify-between px-3 py-2 bg-gray-900 shrink-0">
          <div class="flex items-baseline gap-2">
            <span class="text-white font-bold text-sm">{{ quoteData?.stockName || quoteStockNo }}</span>
            <span class="text-gray-500 text-xs">{{ quoteData?.stockNo }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-gray-500 text-xs font-mono">{{ quoteData?.time || '' }}</span>
            <button @click="closeQuote" class="text-gray-500 hover:text-white leading-none px-1">✕</button>
          </div>
        </div>

        <!-- Tab 切換 -->
        <div class="flex shrink-0 border-b border-gray-800 bg-gray-900">
          <button @click="quoteTab='quote'"
                  class="flex-1 py-1.5 text-xs font-medium transition"
                  :class="quoteTab==='quote' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'">
            五檔報價
          </button>
          <button @click="quoteTab='ticks'"
                  class="flex-1 py-1.5 text-xs font-medium transition"
                  :class="quoteTab==='ticks' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'">
            價量明細 <span v-if="quoteTicks.length" class="text-gray-500">({{ quoteTicks.length }})</span>
          </button>
        </div>

        <!-- 載入中 -->
        <div v-if="!quoteData && quoteTab==='quote'" class="py-10 text-center text-gray-500 text-sm">載入中...</div>

        <div v-if="quoteData" v-show="quoteTab==='quote'" class="overflow-y-auto">
          <!-- 委買 / 委賣 標頭 -->
          <div class="grid grid-cols-2 text-center text-base font-bold">
            <div class="py-1.5 bg-red-600 text-white tracking-widest">委 買</div>
            <div class="py-1.5 bg-blue-600 text-white tracking-widest">委 賣</div>
          </div>

          <!-- 五檔 -->
          <div class="bg-black">
            <div v-for="i in 5" :key="i"
                 class="grid text-sm font-mono border-b border-gray-900"
                 style="grid-template-columns: 1.5rem 1fr 1fr 1.5rem"
                 :class="i === 1 && quoteData.bids[0]?.price === quoteData.limitUp ? 'bg-orange-900/40' : ''">
              <!-- H 標記 -->
              <div class="flex items-center justify-center text-red-500 font-bold text-xs pl-1">
                {{ i === 1 && quoteData.bids[0]?.price != null ? 'H' : '' }}
              </div>
              <!-- 委買：量 | 價 -->
              <div class="flex items-center justify-between px-2 py-1.5"
                   :class="i === 1 && quoteData.bids[0]?.price === quoteData.limitUp ? 'text-red-300' : 'text-yellow-400'">
                <span>{{ quoteData.bids[i-1]?.qty != null ? quoteData.bids[i-1].qty : '-' }}</span>
                <span :class="i === 1 && quoteData.bids[0]?.price === quoteData.limitUp ? 'text-red-300 font-bold' : 'text-yellow-400'">
                  {{ quoteData.bids[i-1]?.price ?? '-' }}
                </span>
              </div>
              <!-- 委賣：價 | 量 -->
              <div class="flex items-center justify-between px-2 py-1.5 text-yellow-400">
                <span>{{ quoteData.asks[i-1]?.price ?? '-' }}</span>
                <span>{{ quoteData.asks[i-1]?.qty != null ? quoteData.asks[i-1].qty : '-' }}</span>
              </div>
              <!-- 右側空欄 -->
              <div></div>
            </div>

            <!-- 委買委賣總量 -->
            <div class="grid text-xs font-mono py-1.5 border-b border-gray-800"
                 style="grid-template-columns: 1.5rem 1fr 1fr 1.5rem">
              <div></div>
              <div class="px-2 text-gray-400">
                ({{ quoteData.totalBid != null ? quoteData.totalBid : '-' }})
              </div>
              <div class="px-2 text-right text-gray-400">
                ({{ quoteData.totalAsk != null ? quoteData.totalAsk : '-' }})
              </div>
              <div></div>
            </div>
          </div>

          <!-- 詳細報價 分隔列 -->
          <div class="px-3 py-1 bg-gray-800/60 text-gray-400 text-xs tracking-widest">詳細報價</div>

          <!-- 詳細資訊格 -->
          <div class="bg-black text-xs font-mono">
            <!-- 成交 / 漲跌 / 幅度 -->
            <div class="grid grid-cols-3 border-b border-gray-900">
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">成交</span>
                <span class="px-1 rounded font-bold"
                  :class="quoteData.price != null && quoteData.limitUp != null && quoteData.price >= quoteData.limitUp ? 'bg-red-700 text-white' : quoteData.price != null && quoteData.limitDown != null && quoteData.price <= quoteData.limitDown ? 'bg-green-700 text-white' : quoteData.changePct > 0 ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'">
                  {{ quoteData.price ?? '-' }}
                </span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">漲跌</span>
                <span :class="quoteData.change > 0 ? 'text-red-400' : quoteData.change < 0 ? 'text-green-400' : 'text-gray-300'">
                  {{ quoteData.change != null ? (quoteData.change > 0 ? '+' : '') + quoteData.change : '-' }}
                </span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">幅度</span>
                <span :class="quoteData.changePct > 0 ? 'text-red-400' : quoteData.changePct < 0 ? 'text-green-400' : 'text-gray-300'">
                  {{ quoteData.changePct != null ? (quoteData.changePct > 0 ? '+' : '') + quoteData.changePct + '%' : '-' }}
                </span>
              </div>
            </div>
            <!-- 單量 / 總量 / 內盤外盤 -->
            <div class="grid grid-cols-3 border-b border-gray-900">
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">單量</span>
                <span class="text-gray-200">{{ quoteData.lastQty ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">總量</span>
                <span class="text-yellow-400">{{ quoteData.volume != null ? quoteData.volume.toLocaleString() : '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">振幅</span>
                <span class="text-yellow-400">{{ quoteData.amplitude != null ? quoteData.amplitude + '%' : '-' }}</span>
              </div>
            </div>
            <!-- 內盤 / 外盤 -->
            <div class="grid grid-cols-3 border-b border-gray-900">
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">內盤</span>
                <span class="text-green-400">{{ quoteData.innerVol ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">外盤</span>
                <span class="text-red-400">{{ quoteData.outerVol ?? '-' }}</span>
              </div>
              <div></div>
            </div>
            <!-- 跌停 / 漲停 / 昨收 -->
            <div class="grid grid-cols-3 border-b border-gray-900">
              <div class="flex items-center gap-1 px-2 py-1.5 bg-green-900/40">
                <span class="text-gray-400 shrink-0">跌停</span>
                <span class="text-green-400">{{ quoteData.limitDown ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5 bg-red-900/40">
                <span class="text-gray-400 shrink-0">漲停</span>
                <span class="text-red-400">{{ quoteData.limitUp ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5 bg-yellow-900/20">
                <span class="text-gray-400 shrink-0">昨收</span>
                <span class="text-yellow-400">{{ quoteData.prevClose ?? '-' }}</span>
              </div>
            </div>
            <!-- 最低 / 最高 / 開盤 -->
            <div class="grid grid-cols-3">
              <div class="flex items-center gap-1 px-2 py-1.5">
                <span class="text-gray-400 shrink-0">最低</span>
                <span class="text-green-300">{{ quoteData.low ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5"
                   :class="quoteData.high != null && quoteData.limitUp != null && quoteData.high >= quoteData.limitUp ? 'bg-red-900/40' : ''">
                <span class="text-gray-400 shrink-0">最高</span>
                <span :class="quoteData.high != null && quoteData.limitUp != null && quoteData.high >= quoteData.limitUp ? 'text-red-300' : 'text-red-400'">{{ quoteData.high ?? '-' }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1.5"
                   :class="quoteData.open != null && quoteData.limitUp != null && quoteData.open >= quoteData.limitUp ? 'bg-red-900/40' : ''">
                <span class="text-gray-400 shrink-0">開盤</span>
                <span :class="quoteData.open != null && quoteData.limitUp != null && quoteData.open >= quoteData.limitUp ? 'text-red-300' : 'text-gray-300'">{{ quoteData.open ?? '-' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 價量明細 Tab -->
        <div v-show="quoteTab==='ticks'" class="overflow-y-auto flex-1" style="max-height:75vh">
          <div v-if="!quoteTicks.length" class="py-10 text-center text-gray-600 text-sm">
            {{ quoteLoading ? '載入中...' : '尚無資料（開盤後進入漲跌榜才會開始累積）' }}
          </div>
          <table v-else class="w-full text-xs font-mono">
            <thead class="sticky top-0 bg-gray-900">
              <tr class="text-gray-500 border-b border-gray-800">
                <th class="px-2 py-1.5 text-left">時間</th>
                <th class="px-2 py-1.5 text-right">成交價</th>
                <th class="px-2 py-1.5 text-right">漲跌</th>
                <th class="px-2 py-1.5 text-right">分量(張)</th>
                <th class="px-2 py-1.5 text-right">累計量</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in quoteTicks" :key="i"
                  class="border-b border-gray-900/60"
                  :class="i % 2 === 0 ? 'bg-black' : 'bg-gray-950'">
                <td class="px-2 py-1 text-gray-400">{{ r.time }}</td>
                <td class="px-2 py-1 text-right">
                  <span class="px-1 rounded"
                    :class="quoteData?.limitUp && r.price >= quoteData.limitUp ? 'bg-red-700 text-white' :
                            r.change_val > 0 ? 'text-red-300' : r.change_val < 0 ? 'text-green-300' : 'text-gray-300'">
                    {{ r.price }}
                  </span>
                </td>
                <td class="px-2 py-1 text-right"
                    :class="r.change_val > 0 ? 'text-red-400' : r.change_val < 0 ? 'text-green-400' : 'text-gray-400'">
                  {{ r.change_val != null ? (r.change_val > 0 ? '+' : '') + r.change_val : '-' }}
                </td>
                <td class="px-2 py-1 text-right"
                    :class="r.qty >= 10 ? 'text-yellow-400 font-bold' : r.qty >= 3 ? 'text-red-400' : 'text-gray-400'">
                  {{ r.qty ?? '-' }}
                </td>
                <td class="px-2 py-1 text-right text-gray-400">{{ r.cum_vol?.toLocaleString() ?? '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>
    </div>
  </Teleport>

  <!-- ══ 雙模選股 ══════════════════════════════════════════ -->
  <div v-if="tab === 'strongweak'"
       class="fixed left-0 right-0 bottom-0"
       :style="{ top: navbarBottom + 'px' }">
    <iframe
      src="https://stockai-frontend-ten.vercel.app"
      class="w-full h-full border-0"
      allow="fullscreen"
    />

    <template v-if="false">
      <!-- 市場狀態橫幅（舊版保留，不渲染）-->
      <div class="rounded-xl border p-4 flex items-center justify-between flex-wrap gap-3"
           :class="swStateBg(swData.regime?.state)">
        <div class="flex items-center gap-3">
          <span class="text-lg font-bold">{{ swStateLabel(swData.regime?.state) }}</span>
          <span class="text-sm opacity-70">{{ swData.regime?.tradeDate }}</span>
        </div>
        <div class="flex gap-5 text-sm">
          <span>趨勢強度 <span class="font-bold tabular-nums">{{ swData.regime?.trendStrength > 0 ? '+' : '' }}{{ swData.regime?.trendStrength }}</span></span>
          <span>資金熱度 <span class="font-bold tabular-nums">{{ swData.regime?.capitalHeat }}</span></span>
          <span>風險分數 <span class="font-bold tabular-nums">{{ swData.regime?.riskScore }}</span></span>
        </div>
      </div>

      <!-- 雙模分頁 -->
      <div class="flex gap-1 border-b border-gray-700">
        <button @click="swMode='momentum'"
          :class="swMode==='momentum'
            ? 'text-green-400 border-b-2 border-green-500'
            : 'text-gray-500 border-b-2 border-transparent hover:text-gray-300'"
          class="px-4 py-2 text-sm font-medium -mb-px transition-colors">
          動能模式
          <span v-if="swData.regime?.state === 'bull'"
            class="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-green-900/50 text-green-400 border border-green-700/40">啟用</span>
        </button>
        <button @click="swMode='value'"
          :class="swMode==='value'
            ? 'text-blue-400 border-b-2 border-blue-500'
            : 'text-gray-500 border-b-2 border-transparent hover:text-gray-300'"
          class="px-4 py-2 text-sm font-medium -mb-px transition-colors">
          價值模式
          <span v-if="swData.regime?.state === 'bear'"
            class="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-blue-900/50 text-blue-400 border border-blue-700/40">啟用</span>
        </button>
      </div>

      <!-- ── 動能排行表 ── -->
      <div v-if="swMode === 'momentum'" class="rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <span class="text-sm font-semibold text-white">動能排行 Top 50</span>
          <span class="text-xs text-gray-500">{{ swData.momentum?.scoreDate }} · {{ swData.momentum?.total }} 支</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-800/50">
              <tr class="text-xs text-gray-500">
                <th class="px-3 py-2 text-left w-8">#</th>
                <th class="px-3 py-2 text-left">股票</th>
                <th class="px-3 py-2 text-left">綜合分</th>
                <th class="px-3 py-2 text-left">趨勢</th>
                <th class="px-3 py-2 text-left">籌碼</th>
                <th class="px-3 py-2 text-left hidden md:table-cell">標籤</th>
                <th class="px-3 py-2 text-right">收盤</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              <tr v-for="(s, i) in (swData.momentum?.items ?? [])" :key="s.stockNo"
                  class="hover:bg-white/[0.02]">
                <td class="px-3 py-2 text-gray-600 tabular-nums text-xs">{{ i + 1 }}</td>
                <td class="px-3 py-2">
                  <div class="font-bold text-gray-100 text-sm">{{ s.stockNo }}</div>
                  <div class="text-xs text-gray-500">{{ s.stockName }}</div>
                </td>
                <td class="px-3 py-2">
                  <div class="flex items-center gap-1.5">
                    <div class="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div class="h-full rounded-full" :class="swScoreBg(s.totalScore)" :style="`width:${Math.min(100,s.totalScore)}%`"/>
                    </div>
                    <span class="text-xs font-bold tabular-nums" :class="swScoreColor(s.totalScore)">{{ s.totalScore.toFixed(1) }}</span>
                  </div>
                </td>
                <td class="px-3 py-2 text-xs tabular-nums" :class="swScoreColor(s.trendScore)">{{ s.trendScore.toFixed(1) }}</td>
                <td class="px-3 py-2 text-xs tabular-nums" :class="swScoreColor(s.chipsScore)">{{ s.chipsScore.toFixed(1) }}</td>
                <td class="px-3 py-2 hidden md:table-cell">
                  <div class="flex gap-1 flex-wrap">
                    <span v-if="s.isAboveMa2060" class="px-1 py-0.5 rounded text-[10px] bg-green-900/40 text-green-400 border border-green-700/40">MA多頭</span>
                    <span v-if="s.isNewHigh20d" class="px-1 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-400 border border-blue-700/40">20高</span>
                    <span v-if="s.trustConsecDays >= 3" class="px-1 py-0.5 rounded text-[10px] bg-purple-900/40 text-purple-400 border border-purple-700/40">投信+{{ s.trustConsecDays }}</span>
                  </div>
                </td>
                <td class="px-3 py-2 text-right text-xs tabular-nums text-gray-300">
                  {{ s.close != null ? s.close.toFixed(1) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ── 價值排行表 ── -->
      <div v-else-if="swMode === 'value'">
        <div v-if="!swData.value" class="rounded-xl border border-gray-700 bg-gray-900/60 p-8 text-center text-gray-500 text-sm">
          價值評分資料尚未生成，請先執行 sync_bwibbu 後再計算
        </div>
        <div v-else class="rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <div>
              <span class="text-sm font-semibold text-white">價值排行 Top 50</span>
              <span class="ml-2 px-2 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-400 border border-blue-700/40">品質 × 估值 × 防禦</span>
            </div>
            <span class="text-xs text-gray-500">{{ swData.value?.scoreDate }} · {{ swData.value?.total }} 支</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-gray-800/50">
                <tr class="text-xs text-gray-500">
                  <th class="px-3 py-2 text-left w-8">#</th>
                  <th class="px-3 py-2 text-left">股票</th>
                  <th class="px-3 py-2 text-left">綜合分</th>
                  <th class="px-3 py-2 text-left hidden sm:table-cell">品質</th>
                  <th class="px-3 py-2 text-left hidden sm:table-cell">估值</th>
                  <th class="px-3 py-2 text-right hidden md:table-cell">PE</th>
                  <th class="px-3 py-2 text-right hidden md:table-cell">PBR</th>
                  <th class="px-3 py-2 text-right hidden md:table-cell">ROE%</th>
                  <th class="px-3 py-2 text-right hidden lg:table-cell">殖利率</th>
                  <th class="px-3 py-2 text-right hidden lg:table-cell">營收YoY</th>
                  <th class="px-3 py-2 text-right">收盤</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr v-for="(s, i) in (swData.value?.items ?? [])" :key="s.stockNo"
                    class="hover:bg-white/[0.02]">
                  <td class="px-3 py-2 text-gray-600 tabular-nums text-xs">{{ i + 1 }}</td>
                  <td class="px-3 py-2">
                    <div class="font-bold text-gray-100 text-sm">{{ s.stockNo }}</div>
                    <div class="text-xs text-gray-500">{{ s.stockName }}</div>
                  </td>
                  <td class="px-3 py-2">
                    <div class="flex items-center gap-1.5">
                      <div class="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full" :class="valScoreBg(s.totalScore)" :style="`width:${Math.min(100,s.totalScore)}%`"/>
                      </div>
                      <span class="text-xs font-bold tabular-nums" :class="valScoreColor(s.totalScore)">{{ s.totalScore.toFixed(1) }}</span>
                    </div>
                  </td>
                  <td class="px-3 py-2 hidden sm:table-cell">
                    <div class="flex items-center gap-1.5">
                      <div class="w-8 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-indigo-500" :style="`width:${Math.min(100,(s.qualityScore/50)*100)}%`"/>
                      </div>
                      <span class="text-xs tabular-nums text-indigo-400">{{ s.qualityScore?.toFixed(0) }}</span>
                    </div>
                  </td>
                  <td class="px-3 py-2 hidden sm:table-cell">
                    <div class="flex items-center gap-1.5">
                      <div class="w-8 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-sky-500" :style="`width:${Math.min(100,(s.valuationScore/30)*100)}%`"/>
                      </div>
                      <span class="text-xs tabular-nums text-sky-400">{{ s.valuationScore?.toFixed(0) }}</span>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right hidden md:table-cell text-xs tabular-nums text-gray-300">
                    {{ s.pe != null ? s.pe.toFixed(1) : '—' }}
                  </td>
                  <td class="px-3 py-2 text-right hidden md:table-cell text-xs tabular-nums text-gray-300">
                    {{ s.pbr != null ? s.pbr.toFixed(2) : '—' }}
                  </td>
                  <td class="px-3 py-2 text-right hidden md:table-cell text-xs tabular-nums"
                      :class="s.roe > 0 ? 'text-green-400' : 'text-gray-500'">
                    {{ s.roe != null ? s.roe.toFixed(1) + '%' : '—' }}
                  </td>
                  <td class="px-3 py-2 text-right hidden lg:table-cell text-xs tabular-nums text-amber-400">
                    {{ s.dividendYield != null ? s.dividendYield.toFixed(2) + '%' : '—' }}
                  </td>
                  <td class="px-3 py-2 text-right hidden lg:table-cell text-xs tabular-nums"
                      :class="s.revYoyPct > 0 ? 'text-green-400' : s.revYoyPct < 0 ? 'text-red-400' : 'text-gray-500'">
                    {{ s.revYoyPct != null ? (s.revYoyPct > 0 ? '+' : '') + s.revYoyPct.toFixed(1) + '%' : '—' }}
                  </td>
                  <td class="px-3 py-2 text-right text-xs tabular-nums text-gray-300">
                    {{ s.close != null ? s.close.toFixed(1) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </template>

    </div><!-- end 分頁內容區 -->
  </div>

</template>
