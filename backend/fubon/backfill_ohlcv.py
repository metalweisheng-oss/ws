"""
使用富邦 API 修正 market_daily 的 OHLCV 歷史資料
（取代現在被 TWSE 封鎖的 backfillOHLCVFromStockDay）

用法:
  python3 -m fubon.backfill_ohlcv              # 修正近 200 天
  python3 -m fubon.backfill_ohlcv 60           # 修正近 60 天
  python3 -m fubon.backfill_ohlcv 200 2330     # 只修正特定股票
"""
import sys
import time
import psycopg2
from datetime import datetime, timedelta
from .sdk_client import get_sdk
from .config import DATABASE_URL


def get_db():
    return psycopg2.connect(DATABASE_URL)


def backfill(days: int = 200, target_stock: str = None):
    sdk = get_sdk()
    rest = sdk.marketdata.rest_client

    conn = get_db()
    cur  = conn.cursor()

    # 計算日期範圍
    today     = datetime.now()
    from_date = (today - timedelta(days=days * 1.5)).strftime("%Y-%m-%d")
    to_date   = today.strftime("%Y-%m-%d")

    # 查詢 DB 中有哪些股票需要修正（close 相同的日期 = 可能錯誤）
    if target_stock:
        cur.execute("""
            SELECT DISTINCT stock_no FROM market_daily
            WHERE stock_no = %s
        """, (target_stock,))
    else:
        cur.execute("""
            SELECT DISTINCT stock_no FROM market_daily
            WHERE trade_date >= CURRENT_DATE - %s
            ORDER BY stock_no
        """, (days * 2,))

    stocks = [r[0] for r in cur.fetchall()]
    print(f"[backfill_ohlcv] 共 {len(stocks)} 支股票，日期範圍 {from_date} ~ {to_date}")

    updated = 0
    errors  = 0

    for i, stock_no in enumerate(stocks):
        try:
            candles = rest.stock.historical.candles(
                symbol=stock_no,
                timeframe="D",
                **{"from": from_date, "to": to_date}
            ).get("data", {}).get("candles", [])

            if not candles:
                continue

            for c in candles:
                date  = c.get("date", "")[:10]
                open_ = c.get("open")
                high  = c.get("high")
                low   = c.get("low")
                close = c.get("close")
                vol   = c.get("volume")

                if not close or not date:
                    continue

                cur.execute("""
                    UPDATE market_daily
                    SET close=%(close)s, open_p=%(open)s, high=%(high)s,
                        low=%(low)s, volume=%(volume)s
                    WHERE stock_no=%(stock_no)s AND trade_date=%(date)s
                      AND (close IS NULL OR close != %(close)s)
                """, {
                    "close":    close,
                    "open":     open_,
                    "high":     high,
                    "low":      low,
                    "volume":   int(vol * 1000) if vol else None,
                    "stock_no": stock_no,
                    "date":     date,
                })
                updated += cur.rowcount

            conn.commit()

            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(stocks)}] 已更新 {updated} 筆...")

            time.sleep(0.05)  # 每支股票間隔 50ms，避免 rate limit

        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  [{stock_no}] 失敗: {e}")
            conn.rollback()

    cur.close()
    conn.close()
    print(f"[backfill_ohlcv] 完成：更新 {updated} 筆，錯誤 {errors} 次")
    return {"updated": updated, "errors": errors}


if __name__ == "__main__":
    days         = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    target_stock = sys.argv[2] if len(sys.argv) > 2 else None
    backfill(days, target_stock)
