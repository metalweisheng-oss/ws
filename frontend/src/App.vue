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
]

const SIGNAL_META = {
  entry:        { label: '主力進場', cls: 'bg-red-500',    text: 'text-red-400',    border: 'border-red-700'    },
  warning:      { label: '進場警戒', cls: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-700' },
  exit:         { label: '主力出貨', cls: 'bg-emerald-500',text: 'text-emerald-400',border: 'border-emerald-700'},
  exit_warning: { label: '出貨警戒', cls: 'bg-teal-500',   text: 'text-teal-400',   border: 'border-teal-700'   },
  watch:        { label: '注意量能', cls: 'bg-yellow-500', text: 'text-yellow-400', border: 'border-yellow-700' },
  normal:       { label: '正常',     cls: 'bg-gray-500',   text: 'text-gray-400',   border: 'border-gray-700'   },
  closed:       { label: '休市',     cls: 'bg-gray-700',   text: 'text-gray-500',   border: 'border-gray-800'   },
  no_data:      { label: '無資料',   cls: 'bg-gray-700',   text: 'text-gray-500',   border: 'border-gray-800'   },
  error:        { label: '錯誤',     cls: 'bg-gray-700',   text: 'text-red-500',    border: 'border-gray-800'   },
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

async function testTelegram() {
  const r = await fetch(`${API}/api/test/telegram`, { method: 'POST' })
  const d = await r.json()
  alert(d.message)
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

const signalBadge = { entry: 'bg-red-500', warning: 'bg-orange-500', exit: 'bg-emerald-500', exit_warning: 'bg-teal-500', watch: 'bg-yellow-500' }
const signalLabel = { entry: '主力進場', warning: '進場警戒', exit: '主力出貨', exit_warning: '出貨警戒', watch: '注意量能' }
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
    entry:        { position: 'belowBar', shape: 'arrowUp',   color: '#ef4444', text: '進場' },
    warning:      { position: 'belowBar', shape: 'circle',    color: '#f97316', text: '警戒' },
    exit:         { position: 'aboveBar', shape: 'arrowDown', color: '#10b981', text: '出貨' },
    exit_warning: { position: 'aboveBar', shape: 'circle',    color: '#14b8a6', text: '出貨⚠' },
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
  if (t === 'db')       loadSignals()
  if (t === 'chart')    nextTick(() => loadChartData())
}

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
      <button v-for="t in [{ id:'monitor', label:'即時監控' }, { id:'db', label:'歷史資料' }, { id:'chart', label:'K線圖' }]" :key="t.id"
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
              <span class="text-red-400 font-semibold">主力進場</span>
              <span class="text-gray-500 ml-2">量比 ≥ 3x　＋　接近日低 5% 內　＋　當下反彈收高</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-orange-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-orange-400 font-semibold">量能警戒</span>
              <span class="text-gray-500 ml-2">量比 ≥ 2x ＋ 接近日低　或　MACD底背離 ＋ 接近日低</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-yellow-500 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-yellow-400 font-semibold">注意量能</span>
              <span class="text-gray-500 ml-2">量比 ≥ 2x（未接近日低）</span>
            </div>
          </div>
          <div class="border-t border-gray-800 pt-3 flex items-start gap-3">
            <span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0"></span>
            <div>
              <span class="text-cyan-400 font-semibold">MACD 底背離</span>
              <span class="text-gray-500 ml-2">股價波段低點持續走低，但 MACD 柱狀體低點墊高 → 賣壓遞減，潛在反轉</span>
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
                  :class="row.signal_type==='entry' ? 'bg-red-950/10' : row.signal_type==='warning' ? 'bg-orange-950/10' : ''">
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
                            'text-red-400':     intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'entry',
                            'text-orange-400':  intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'warning',
                            'text-emerald-400': intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'exit',
                            'text-teal-400':    intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'exit_warning',
                            'text-yellow-400':  intradaySignalMap[barTimeKey(row.bar_time)].signal_type === 'watch',
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

    <!-- ── K線圖 Tab ── -->
    <div v-if="tab === 'chart'" class="max-w-6xl mx-auto px-4 py-6 space-y-4">

      <!-- 控制列 -->
      <div class="flex flex-wrap gap-3 items-center">
        <select v-model="chartStockNo" @change="loadChartData()"
                class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option v-for="s in STOCKS" :key="s.no" :value="s.no">{{ s.name }} {{ s.no }}</option>
        </select>
        <div class="flex gap-1">
          <button v-for="d in [3,5,7]" :key="d"
                  @click="chartDays = d; loadChartData()"
                  class="px-3 py-2 rounded-lg text-sm font-medium transition"
                  :class="chartDays === d ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'">
            近 {{ d }} 日
          </button>
        </div>
        <span v-if="chartLoading" class="text-xs text-gray-500">載入中...</span>
        <span v-if="chartError" class="text-xs text-red-400">{{ chartError }}</span>

        <!-- 圖例 -->
        <div class="ml-auto flex flex-wrap gap-3 text-xs">
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-red-500"></span>進場</span>
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-orange-500"></span>警戒</span>
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-emerald-500"></span>出貨</span>
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-teal-500"></span>出貨⚠</span>
        </div>
      </div>

      <!-- 圖表容器 -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 class="font-semibold text-white text-sm">
            {{ STOCKS.find(s => s.no === chartStockNo)?.name }} {{ chartStockNo }}
            <span class="text-gray-500 font-normal ml-2 text-xs">分時 K 棒（台股時間）</span>
          </h2>
          <span class="text-xs text-gray-600">紅漲綠跌</span>
        </div>
        <div ref="chartContainer" class="w-full"></div>
      </div>

    </div>

  </div>
</template>
