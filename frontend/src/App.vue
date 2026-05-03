<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { createChart, CandlestickSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'

const tab = ref('monitor') // 'monitor' | 'analysis'
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
  Object.fromEntries(STOCKS.map(s => [s.no, { latest: null, logs: [], connected: false, sse: null }]))
)

function startOne(stockNo) {
  const st = stocks[stockNo]
  if (st.sse) st.sse.close()
  st.sse = new EventSource(`${API}/api/stock/monitor/stream?stockNo=${stockNo}`)
  st.connected = true
  st.sse.onmessage = (e) => {
    const data = JSON.parse(e.data)
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
  if (t === 'conc')     loadConcentration()
  if (t === 'screener') loadScreener()
}

// ── 日報表 ────────────────────────────────────────
const reportStockNo = ref('2059')
const reportDate    = ref('2026-04-28')
const reportLoading = ref(false)
const reportData    = ref(null)
const reportError   = ref('')

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

// ── 大股東吃貨排行榜 ─────────────────────────────────
const concLoading  = ref(false)
const concRows     = ref([])
const concError    = ref('')
const concTotal    = ref(0)
const concMinStreak = ref(1)
const concSyncing  = ref(false)
const concLatestDate = ref('')
const concHasMultiWeek = ref(false)

async function loadConcentration() {
  concLoading.value = true
  concError.value   = ''
  try {
    const r = await fetch(`${API}/api/concentration/ranking?minStreak=${concMinStreak.value}&limit=100`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    concRows.value       = d.rows || []
    concTotal.value      = d.total || 0
    concLatestDate.value = d.latest_date ? d.latest_date.slice(0,10) : ''
    concHasMultiWeek.value = !!d.has_multi_week
  } catch(e) {
    concError.value = '載入失敗：' + e.message
  } finally {
    concLoading.value = false
  }
}

async function manualSyncConc() {
  concSyncing.value = true
  concError.value   = ''
  try {
    await fetch(`${API}/api/sync/concentration`, { method: 'POST' })
    // 等候後台同步完成（全市場約 10-15 秒）
    await new Promise(r => setTimeout(r, 15000))
    await loadConcentration()
  } catch(e) {
    concError.value = '同步失敗：' + e.message
  } finally {
    concSyncing.value = false
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

async function generateReport() {
  reportLoading.value = true
  reportError.value   = ''
  reportData.value    = null
  try {
    const r = await fetch(`${API}/api/daily-report?stockNo=${reportStockNo.value}&date=${reportDate.value}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    reportData.value = d
  } catch(e) {
    reportError.value = '報表生成失敗：' + e.message
  } finally {
    reportLoading.value = false
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

onMounted(() => startAll())
onUnmounted(() => stopAll())

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
    <div class="border-b border-gray-800 px-6 flex gap-1">
      <button v-for="t in [{ id:'monitor', label:'即時監控' }, { id:'db', label:'歷史資料' }, { id:'report', label:'日報表' }, { id:'breadth', label:'漲跌家數' }, { id:'chips', label:'台指期籌碼' }, { id:'sector', label:'強勢族群' }, { id:'conc', label:'大股東吃貨' }, { id:'screener', label:'台股選股' }]" :key="t.id"
              @click="selectTab(t.id)"
              class="px-4 py-3 text-sm font-medium transition border-b-2 -mb-px"
              :class="tab === t.id ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-500 hover:text-gray-300'">
        {{ t.label }}
      </button>
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
        <span v-if="telegramStatus" class="text-sm text-cyan-400 self-center">{{ telegramStatus }}</span>
        <span class="text-xs text-gray-600 self-center">每 30 秒自動更新</span>
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
             class="rounded-2xl border p-4 transition-all"
             :class="stocks[s.no].latest ? SIGNAL_META[stocks[s.no].latest.signal]?.border || 'border-gray-800' : 'border-gray-800'">

          <!-- 股票標題 -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full flex-shrink-0"
                    :class="stocks[s.no].connected ? 'bg-green-400 animate-pulse' : 'bg-gray-600'"></span>
              <span class="font-bold text-white">{{ s.name }}</span>
              <span class="text-xs text-gray-500 font-mono">{{ s.no }}</span>
            </div>
            <div v-if="stocks[s.no].latest" class="text-right text-xs text-gray-600 font-mono">
              {{ stocks[s.no].latest.checkTime }}
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
    <div v-if="tab === 'conc'" class="max-w-5xl mx-auto px-4 py-6 space-y-4">

      <!-- 標題列 -->
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-base font-bold text-white">🐋 大股東持續吃貨排行榜</h2>
          <p class="text-xs text-gray-600 mt-0.5">
            全市場上市個股・大戶（≥400張）集保持股排行・每週更新（集保每週公布一次）
            <span v-if="concLatestDate" class="ml-2 text-gray-500">資料日期：{{ concLatestDate }}</span>
            <span v-if="concTotal" class="ml-2 text-gray-500">共 {{ concTotal }} 檔</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs text-gray-500">週增加篩選</label>
          <select v-model="concMinStreak" @change="loadConcentration()"
                  class="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
            <option :value="1">顯示全部</option>
            <option :value="2">2 週+ 連增</option>
            <option :value="3">3 週+ 連增</option>
            <option :value="5">5 週+ 連增</option>
          </select>
          <button @click="loadConcentration()" :disabled="concLoading"
                  class="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm transition">
            {{ concLoading ? '載入中...' : '重新整理' }}
          </button>
          <button @click="manualSyncConc()" :disabled="concSyncing"
                  class="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm transition">
            {{ concSyncing ? '同步中...' : '立即同步' }}
          </button>
        </div>
      </div>

      <!-- 只有 1 週資料時的提示 -->
      <div v-if="concRows.length && !concHasMultiWeek"
           class="rounded-xl bg-yellow-900/20 border border-yellow-800/50 px-4 py-3 text-xs text-yellow-400">
        ⚠️ 目前只有一週資料，尚無法計算連續增加天數。集保資料每週更新，下週同步後將顯示週增加趨勢。
      </div>

      <p v-if="concError" class="text-red-400 text-sm">{{ concError }}</p>

      <div v-if="!concRows.length && !concLoading" class="text-center text-gray-600 text-sm py-12">
        點擊「立即同步」先抓取集保資料（約需 15 秒），完成後點「重新整理」查看排行榜。
      </div>

      <!-- 排行榜 -->
      <div v-if="concRows.length" class="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-xs text-gray-500 border-b border-gray-800 bg-gray-900/80 sticky top-0">
              <tr>
                <th class="px-3 py-3 text-center w-10">#</th>
                <th class="px-4 py-3 text-left">個股</th>
                <th class="px-4 py-3 text-center">連續週增</th>
                <th class="px-4 py-3 text-right">大戶持股%</th>
                <th class="px-4 py-3 text-right">週增減</th>
                <th class="px-4 py-3 text-right">累計增加</th>
                <th class="px-4 py-3 text-right">大戶人數</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              <tr v-for="(row, idx) in concRows" :key="row.stock_no"
                  class="hover:bg-gray-800/40 transition">
                <td class="px-3 py-2.5 text-center text-gray-600 text-xs">{{ idx + 1 }}</td>
                <td class="px-4 py-2.5">
                  <div class="font-semibold text-white">{{ row.stock_name }}</div>
                  <div class="text-xs text-gray-500 font-mono">{{ row.stock_no }}</div>
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span v-if="row.streak_days > 0"
                        class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold"
                        :class="row.streak_days >= 5 ? 'bg-red-500/20 text-red-400' :
                                row.streak_days >= 3 ? 'bg-orange-500/20 text-orange-400' :
                                row.streak_days >= 2 ? 'bg-yellow-500/20 text-yellow-400' :
                                'bg-green-500/20 text-green-400'">
                    🔥 {{ row.streak_days }} 週
                  </span>
                  <span v-else class="text-xs text-gray-600">首週</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-bold text-yellow-300">
                  {{ row.latest_pct != null ? row.latest_pct.toFixed(2) + '%' : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold"
                    :class="row.latest_change > 0 ? 'text-red-400' : row.latest_change < 0 ? 'text-green-400' : 'text-gray-600'">
                  <span v-if="row.latest_change != null">
                    {{ row.latest_change > 0 ? '+' : '' }}{{ row.latest_change.toFixed(2) }}%
                  </span>
                  <span v-else class="text-gray-700">—</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-orange-400">
                  <span v-if="row.total_change">+{{ row.total_change.toFixed(2) }}%</span>
                  <span v-else class="text-gray-700">—</span>
                </td>
                <td class="px-4 py-2.5 text-right text-gray-400 text-xs">{{ row.large_count?.toLocaleString() ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="px-5 py-3 border-t border-gray-800 text-xs text-gray-600">
          大戶定義：集保持股 ≥ 400,000 股（400 張）。排序依連續週增數 → 累計增幅 → 持股比例。資料來源：集保結算所每週庫存統計（id=1-5）。連續週增需兩週以上資料，首週資料依持股比例高低排序。
        </div>
      </div>

    </div>

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
                <th class="px-4 py-3 text-center">評分</th>
                <th class="px-4 py-3 text-center">階段</th>
                <th class="px-4 py-3 text-right">收盤價</th>
                <th class="px-4 py-3 text-right">當日漲跌</th>
                <th class="px-4 py-3 text-right">5日漲幅</th>
                <th class="px-4 py-3 text-center">投信連買</th>
                <th class="px-4 py-3 text-right">主力5日淨</th>
                <th class="px-4 py-3 text-right">融資5日變</th>
                <th class="px-4 py-3 text-center">
                  <div>位置</div>
                  <div class="text-gray-600 font-normal" style="font-size:10px">20日低↔高　越低越好</div>
                </th>
                <th class="px-4 py-3 text-right">
                  <div>主力成本區</div>
                  <div class="text-gray-600 font-normal" style="font-size:10px">法人買入加權均價</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, idx) in screenerRows" :key="row.stock_no">
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
                  {{ fmtSignShares2(row.major_net5) }}
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

  </div>
</template>
