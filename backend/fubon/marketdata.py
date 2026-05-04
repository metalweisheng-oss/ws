"""
富邦即時行情模組
用法:
  python3 -m fubon.marketdata quote 2330
  python3 -m fubon.marketdata snapshot TSE
  python3 -m fubon.marketdata history 2330 2026-01-01 2026-04-30
  python3 -m fubon.marketdata watch 2330 2317 2454
"""
import sys
import json
import time
from fubon_neo.sdk import Mode
from .sdk_client import get_sdk


def get_quote(symbol: str) -> dict:
    """個股即時報價"""
    sdk = get_sdk()
    result = sdk.marketdata.rest_client.stock.intraday.quote(symbol=symbol)
    return result.get("data", {})


def get_snapshot(market: str = "TSE") -> list:
    """
    全市場快照
    market: TSE=上市, OTC=上櫃
    """
    sdk = get_sdk()
    result = sdk.marketdata.rest_client.stock.snapshot.quotes(market=market)
    return result.get("data", [])


def get_history(symbol: str, from_date: str, to_date: str, timeframe: str = "D") -> list:
    """
    歷史K線
    timeframe: D=日K, 60=60分K, 30=30分K, 5=5分K, 1=1分K
    """
    sdk = get_sdk()
    result = sdk.marketdata.rest_client.stock.historical.candles(
        symbol=symbol,
        timeframe=timeframe,
        **{"from": from_date, "to": to_date}
    )
    return result.get("data", {}).get("candles", [])


def get_movers(market: str = "TSE", direction: str = "up", limit: int = 20) -> list:
    """漲跌幅排行榜"""
    sdk = get_sdk()
    result = sdk.marketdata.rest_client.stock.snapshot.movers(
        market=market, direction=direction, limit=limit
    )
    return result.get("data", [])


def get_actives(market: str = "TSE", trade: str = "volume", limit: int = 20) -> list:
    """成交量/金額排行"""
    sdk = get_sdk()
    result = sdk.marketdata.rest_client.stock.snapshot.actives(
        market=market, trade=trade, limit=limit
    )
    return result.get("data", [])


def watch_realtime(symbols: list):
    """
    WebSocket 訂閱即時報價（持續輸出，Ctrl+C 停止）
    symbols: 股票代號列表，["*"] 表示全市場
    """
    sdk = get_sdk(Mode.Speed)
    ws = sdk.marketdata.websocket_client

    def on_message(message):
        data = message.get("data", {})
        channel = data.get("channel", "")
        if channel == "quotes":
            print(json.dumps({
                "type":    "quote",
                "symbol":  data.get("symbol"),
                "close":   data.get("closePrice"),
                "change":  data.get("changePercent"),
                "volume":  data.get("volume"),
                "time":    data.get("lastUpdated"),
            }, ensure_ascii=False))
            sys.stdout.flush()

    def on_connect(state):
        print(json.dumps({"type": "connected"}), flush=True)
        for sym in symbols:
            ws.stock.subscribe({"channel": "quotes", "symbol": sym})

    def on_disconnect(state):
        print(json.dumps({"type": "disconnected"}), flush=True)

    def on_error(error):
        print(json.dumps({"type": "error", "message": str(error)}), flush=True)

    ws.stock.on("message",    on_message)
    ws.stock.on("connect",    on_connect)
    ws.stock.on("disconnect", on_disconnect)
    ws.stock.on("error",      on_error)
    ws.stock.connect()


# ── CLI ────────────────────────────────────────────────────
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"

    if cmd == "quote":
        symbol = sys.argv[2] if len(sys.argv) > 2 else "2330"
        q = get_quote(symbol)
        print(json.dumps(q, ensure_ascii=False, indent=2))

    elif cmd == "snapshot":
        market = sys.argv[2] if len(sys.argv) > 2 else "TSE"
        stocks = get_snapshot(market)
        print(f"取得 {len(stocks)} 筆 ({market})")
        for s in stocks[:10]:
            print(f"  {s.get('symbol')} {s.get('name')}: {s.get('closePrice')} ({s.get('changePercent')}%)")

    elif cmd == "history":
        symbol    = sys.argv[2] if len(sys.argv) > 2 else "2330"
        from_date = sys.argv[3] if len(sys.argv) > 3 else "2026-01-01"
        to_date   = sys.argv[4] if len(sys.argv) > 4 else "2026-04-30"
        candles   = get_history(symbol, from_date, to_date)
        print(f"[{symbol}] {len(candles)} 根K線")
        for c in candles[:5]:
            print(f"  {c.get('date')}: O={c.get('open')} H={c.get('high')} L={c.get('low')} C={c.get('close')} V={c.get('volume')}")

    elif cmd == "movers":
        market    = sys.argv[2] if len(sys.argv) > 2 else "TSE"
        direction = sys.argv[3] if len(sys.argv) > 3 else "up"
        movers    = get_movers(market, direction, 10)
        print(f"漲幅排行 ({market}):")
        for m in movers:
            print(f"  {m.get('symbol')} {m.get('name')}: {m.get('changePercent')}%")

    elif cmd == "watch":
        symbols = sys.argv[2:] if len(sys.argv) > 2 else ["2330"]
        print(f"訂閱即時行情: {symbols}", file=sys.stderr)
        watch_realtime(symbols)

    else:
        print(__doc__)
