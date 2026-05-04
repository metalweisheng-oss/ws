"""
富邦新一代 API — 即時行情測試腳本
執行前請填入帳號資訊
"""
from fubon_neo.sdk import FubonSDK, Mode

# ── 帳號設定（請填入） ─────────────────────────────────────
ID       = "A123456789"        # 身分證號
PASSWORD = "your_password"     # 密碼
CERT     = "/path/to/cert.pfx" # 憑證路徑（.pfx 檔）
CERT_PWD = "cert_password"     # 憑證密碼

# ── 初始化 ─────────────────────────────────────────────────
sdk = FubonSDK()
accounts = sdk.login(ID, PASSWORD, CERT, CERT_PWD)
print("登入成功，帳號數:", len(accounts.data))

# 初始化行情（Speed=低延遲，Normal=支援K線/聚合資料）
sdk.init_realtime(Mode.Normal)
rest   = sdk.marketdata.rest_client
ws     = sdk.marketdata.websocket_client


# ══════════════════════════════════════════════════════════
# 1. 個股即時報價（REST）
# ══════════════════════════════════════════════════════════
def get_quote(symbol: str):
    """取得個股即時報價：成交價、五檔、漲跌"""
    result = rest.stock.intraday.quote(symbol=symbol)
    q = result.get("data", {})
    print(f"\n[{symbol}] {q.get('name')}")
    print(f"  成交價: {q.get('closePrice')}  漲跌: {q.get('change')} ({q.get('changePercent')}%)")
    print(f"  成交量: {q.get('volume')}  昨收: {q.get('referencePrice')}")
    print(f"  最高: {q.get('highPrice')}  最低: {q.get('lowPrice')}")
    return q

# get_quote("2330")


# ══════════════════════════════════════════════════════════
# 2. 全市場快照（所有股票一次取得）
# ══════════════════════════════════════════════════════════
def get_all_quotes():
    """取得上市全市場快照（可用於建立選股資料庫）"""
    result = rest.stock.snapshot.quotes(market="TSE")  # TSE=上市, OTC=上櫃
    stocks = result.get("data", [])
    print(f"\n全市場快照: {len(stocks)} 檔")
    for s in stocks[:5]:  # 顯示前5筆
        print(f"  {s.get('symbol')} {s.get('name')}: {s.get('closePrice')} ({s.get('changePercent')}%)")
    return stocks

# get_all_quotes()


# ══════════════════════════════════════════════════════════
# 3. 歷史日K線（可取代爬 TWSE）
# ══════════════════════════════════════════════════════════
def get_history(symbol: str, from_date: str, to_date: str):
    """
    取得歷史日K線
    from_date, to_date 格式: YYYY-MM-DD
    """
    result = rest.stock.historical.candles(
        symbol=symbol,
        timeframe="D",       # D=日K, W=週K, M=月K
        **{"from": from_date, "to": to_date}
    )
    candles = result.get("data", {}).get("candles", [])
    print(f"\n[{symbol}] 歷史K線: {len(candles)} 根")
    for c in candles[:5]:
        print(f"  {c.get('date')}: O={c.get('open')} H={c.get('high')} L={c.get('low')} C={c.get('close')} V={c.get('volume')}")
    return candles

# get_history("2330", "2025-11-01", "2026-04-30")


# ══════════════════════════════════════════════════════════
# 4. 成交 Tick（WebSocket 即時）
# ══════════════════════════════════════════════════════════
def subscribe_trades(symbols: list):
    """WebSocket 訂閱即時成交 Tick"""

    def on_message(message):
        data = message.get("data", {})
        print(f"[Tick] {data.get('symbol')} 成交={data.get('price')} 量={data.get('size')}")

    def on_connect(state):
        print("WebSocket 連線成功")
        ws.stock.subscribe({
            "channel": "trades",
            "symbol": symbols[0] if len(symbols) == 1 else "*",  # * = 全市場
        })

    ws.stock.on("message", on_message)
    ws.stock.on("connect", on_connect)
    ws.stock.connect()  # 阻塞執行

# subscribe_trades(["2330", "2317"])


# ══════════════════════════════════════════════════════════
# 5. 即時報價訂閱（最佳五檔 + 成交價）
# ══════════════════════════════════════════════════════════
def subscribe_quotes(symbol: str):
    """WebSocket 訂閱個股即時報價"""

    def on_message(message):
        data = message.get("data", {})
        if data.get("channel") == "quotes":
            print(f"[Quote] {data.get('symbol')} 成交={data.get('closePrice')} 量={data.get('volume')}")

    def on_connect(state):
        ws.stock.subscribe({"channel": "quotes", "symbol": symbol})

    ws.stock.on("message", on_message)
    ws.stock.on("connect", on_connect)
    ws.stock.connect()

# subscribe_quotes("2330")


# ══════════════════════════════════════════════════════════
# 快速測試（不需要 WebSocket）
# ══════════════════════════════════════════════════════════
if __name__ == "__main__":
    print("=== 即時報價 ===")
    get_quote("2330")

    print("\n=== 全市場快照（前5筆）===")
    get_all_quotes()

    print("\n=== 歷史K線（近30天）===")
    get_history("2330", "2026-04-01", "2026-04-30")

    sdk.logout()
