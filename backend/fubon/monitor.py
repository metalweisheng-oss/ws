"""
富邦即時監控行情串流
啟動後:
  1. 從 REST 抓今日 1 分 K 歷史（供 MACD 計算）
  2. 訂閱 WebSocket 即時報價
  3. 每次收到報價或每 60 秒（補抓新分鐘 K）就輸出一行 JSON

輸出格式:
  {"type":"candles","rows":[{"ts":...,"open":...,"high":...,"low":...,"close":...,"volume":...}],"quote":{...}}
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
    """將富邦 candle 的 date/time 欄位轉成 UTC Unix 秒"""
    # 可能格式: "2026-05-07T09:01:00+08:00"、"2026-05-07T09:01:00"、
    #           date="2026-05-07", time="09:01:00"
    raw = c.get("time") or c.get("date") or ""
    date_part = c.get("date", "")
    time_part = c.get("time", "")

    # 若 time 只是 "HH:MM:SS" 沒有日期，補上今天
    if time_part and len(time_part) <= 8 and date_part:
        raw = f"{date_part}T{time_part}+08:00"
    elif time_part and len(time_part) <= 8:
        today = datetime.now(TW).strftime("%Y-%m-%d")
        raw = f"{today}T{time_part}+08:00"

    if not raw:
        return 0

    # 補時區
    if "+" not in raw and "Z" not in raw:
        raw = raw + "+08:00"

    try:
        return int(datetime.fromisoformat(raw).timestamp())
    except Exception:
        return 0


def run_monitor(symbol: str):
    sdk = get_sdk(Mode.Speed)
    rest = sdk.marketdata.rest_client
    ws   = sdk.marketdata.websocket_client

    candles: list  = []
    last_fetch: float = 0.0
    latest_quote: dict = {}

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

    def _emit(obj: dict):
        print(json.dumps(obj, ensure_ascii=False), flush=True)

    def output():
        _emit({"type": "candles", "rows": candles, "quote": latest_quote})

    def on_message(message):
        nonlocal latest_quote
        data = message.get("data", {})
        if data.get("channel") != "quotes":
            return

        latest_quote = {
            "price":  data.get("closePrice"),
            "volume": data.get("volume"),
            "time":   data.get("lastUpdated", ""),
            "change": data.get("changePercent"),
        }

        # 每 60 秒重抓一次分鐘 K（確保新完成的分鐘 bar 被納入）
        if time.time() - last_fetch > 60:
            fetch_candles()

        output()

    def on_connect(state):
        fetch_candles()
        output()
        ws.stock.subscribe({"channel": "quotes", "symbol": symbol})

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
