"""
富邦即時監控行情串流
啟動後:
  1. 從 REST 抓今日 1 分 K 歷史（供 MACD 計算）
  2. 從 REST 抓今日已成交明細（初始分時明細）
  3. 訂閱 WebSocket quotes + trades 頻道
  4. 每次收到報價時輸出 candles；每筆成交輸出 tick

輸出格式 (每行一個 JSON):
  {"type":"candles","rows":[...],"quote":{...}}
  {"type":"tick","time":"HH:MM:SS","price":..,"volume":..,"side":"buy"|"sell"|""}
  {"type":"error","message":"..."}

用法:
  python3 -m fubon.monitor 2330
"""
import sys
import json
import time
from datetime import datetime, timezone, timedelta
from fubon_neo.sdk import Mode
from .sdk_client import get_sdk

TW = timezone(timedelta(hours=8))


def _parse_ts(c: dict) -> int:
    raw = c.get("time") or c.get("date") or ""
    date_part = c.get("date", "")
    time_part = c.get("time", "")

    if time_part and len(time_part) <= 8 and date_part:
        raw = f"{date_part}T{time_part}+08:00"
    elif time_part and len(time_part) <= 8:
        today = datetime.now(TW).strftime("%Y-%m-%d")
        raw = f"{today}T{time_part}+08:00"

    if not raw:
        return 0
    if "+" not in raw and "Z" not in raw:
        raw += "+08:00"
    try:
        return int(datetime.fromisoformat(raw).timestamp())
    except Exception:
        return 0


def _fmt_time(t_str: str) -> str:
    """把 ISO 時間串轉成 HH:MM:SS（台灣時間）"""
    if not t_str:
        return datetime.now(TW).strftime("%H:%M:%S")
    try:
        if "+" not in t_str and "Z" not in t_str:
            t_str += "+08:00"
        dt = datetime.fromisoformat(t_str).astimezone(TW)
        return dt.strftime("%H:%M:%S")
    except Exception:
        return t_str[:8]


def run_monitor(symbol: str):
    sdk = get_sdk(Mode.Speed)
    rest = sdk.marketdata.rest_client
    ws   = sdk.marketdata.websocket_client

    candles: list       = []
    last_fetch: float   = 0.0
    latest_quote: dict  = {}
    last_tick_price     = None

    def _emit(obj: dict):
        print(json.dumps(obj, ensure_ascii=False), flush=True)

    def fetch_candles():
        nonlocal candles, last_fetch
        try:
            result = rest.stock.intraday.candles(symbol=symbol, timeframe="1")
            raw = result.get("data", [])
            rows = []
            for c in raw:
                ts  = _parse_ts(c)
                vol = c.get("volume", 0) or 0
                cl  = c.get("close")
                if not cl or vol == 0:
                    continue
                rows.append({
                    "ts":     ts,
                    "open":   c.get("open"),
                    "high":   c.get("high"),
                    "low":    c.get("low"),
                    "close":  cl,
                    "volume": int(vol),
                })
            rows.sort(key=lambda r: r["ts"])
            candles = rows
            last_fetch = time.time()
        except Exception as e:
            _emit({"type": "error", "message": f"fetch_candles: {e}"})

    def fetch_initial_trades():
        """抓今日已成交明細當初始資料，批次輸出"""
        try:
            result = rest.stock.intraday.trades(symbol=symbol)
            raw = result.get("data", [])
            # 只取最近 100 筆，倒序（最新在前）
            recent = raw[-100:] if len(raw) > 100 else raw
            for t in reversed(recent):
                price  = t.get("price") or t.get("close")
                volume = t.get("volume") or t.get("size") or 0
                t_str  = t.get("time") or t.get("lastUpdated") or ""
                if not price:
                    continue
                _emit({
                    "type":   "tick",
                    "time":   _fmt_time(t_str),
                    "price":  price,
                    "volume": int(volume) if volume else 0,
                    "side":   t.get("side", ""),
                    "init":   True,  # 標記為初始歷史資料
                })
        except Exception:
            pass  # 初始明細失敗不影響主流程

    def output_candles():
        _emit({"type": "candles", "rows": candles, "quote": latest_quote})

    def on_message(message):
        nonlocal latest_quote, last_tick_price, last_fetch
        data = message.get("data", {})
        channel = data.get("channel", "")

        if channel == "quotes":
            latest_quote = {
                "price":  data.get("closePrice"),
                "volume": data.get("volume"),
                "time":   data.get("lastUpdated", ""),
                "change": data.get("changePercent"),
            }
            if time.time() - last_fetch > 60:
                fetch_candles()
            output_candles()

        elif channel == "trades":
            price  = data.get("price") or data.get("closePrice")
            volume = data.get("size") or data.get("volume") or 0
            t_str  = data.get("time") or data.get("lastUpdated") or ""

            # 推斷外/內盤（若 API 無 side 欄位）
            side = data.get("side", "")
            if not side and price and last_tick_price:
                if price > last_tick_price:
                    side = "buy"
                elif price < last_tick_price:
                    side = "sell"
            if price:
                last_tick_price = price

            if price:
                _emit({
                    "type":   "tick",
                    "time":   _fmt_time(t_str),
                    "price":  price,
                    "volume": int(volume) if volume else 0,
                    "side":   side,
                })

    def on_connect(state):
        fetch_candles()
        fetch_initial_trades()
        output_candles()
        ws.stock.subscribe({"channel": "quotes", "symbol": symbol})
        ws.stock.subscribe({"channel": "trades", "symbol": symbol})

    def on_disconnect(state):
        _emit({"type": "error", "message": "WebSocket 斷線，嘗試重連..."})

    def on_error(error):
        _emit({"type": "error", "message": str(error)})

    ws.stock.on("message",    on_message)
    ws.stock.on("connect",    on_connect)
    ws.stock.on("disconnect", on_disconnect)
    ws.stock.on("error",      on_error)
    ws.stock.connect()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    symbol = sys.argv[1] if len(sys.argv) > 1 else "2330"
    run_monitor(symbol)
