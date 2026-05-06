"""
使用富邦 API 修正 market_daily 的 OHLCV 歷史資料

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

RECONNECT_EVERY = 100  # 每 100 支股票重新連線，避免長連線 timeout


def get_db():
    from urllib.parse import urlparse, unquote
    u = urlparse(DATABASE_URL)
    return psycopg2.connect(
        host=u.hostname, port=u.port or 5432,
        dbname=u.path.lstrip('/'),
        user=unquote(u.username), password=unquote(u.password),
        sslmode='require',
        connect_timeout=30,
        keepalives=1,
        keepalives_idle=60,
        keepalives_interval=10,
        keepalives_count=5,
    )


def backfill(days: int = 200, target_stock: str = None):
    sdk = get_sdk()
    rest = sdk.marketdata.rest_client

    today     = datetime.now()
    from_date = (today - timedelta(days=days * 1.5)).strftime("%Y-%m-%d")
    to_date   = today.strftime("%Y-%m-%d")

    # 先單獨查股票清單，之後關閉此連線
    conn = get_db()
    cur  = conn.cursor()
    if target_stock:
        cur.execute("SELECT DISTINCT stock_no FROM market_daily WHERE stock_no = %s", (target_stock,))
    else:
        cur.execute("""
            SELECT DISTINCT stock_no FROM market_daily
            WHERE trade_date >= CURRENT_DATE - %s
            ORDER BY stock_no
        """, (days * 2,))
    stocks = [r[0] for r in cur.fetchall()]
    cur.close()
    conn.close()

    print(f"[backfill_ohlcv] 共 {len(stocks)} 支股票，日期範圍 {from_date} ~ {to_date}")

    updated = 0
    errors  = 0
    conn    = get_db()

    for i, stock_no in enumerate(stocks):
        # 每 RECONNECT_EVERY 支重新連線，避免 idle timeout
        if i > 0 and i % RECONNECT_EVERY == 0:
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
            print(f"  [{i}/{len(stocks)}] 已更新 {updated} 筆，重新連線 DB...")

        cur = conn.cursor()
        try:
            candles = rest.stock.historical.candles(
                symbol=stock_no,
                timeframe="D",
                **{"from": from_date, "to": to_date}
            ).get("data", [])

            if not candles:
                cur.close()
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
                    "volume":   int(vol) if vol else None,
                    "stock_no": stock_no,
                    "date":     date,
                })
                updated += cur.rowcount

            conn.commit()

            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(stocks)}] 已更新 {updated} 筆...")

            time.sleep(0.05)

        except Exception as e:
            errors += 1
            if errors <= 10:
                print(f"  [{stock_no}] 失敗: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
        finally:
            try:
                cur.close()
            except Exception:
                pass

    try:
        conn.close()
    except Exception:
        pass

    print(f"[backfill_ohlcv] 完成：更新 {updated} 筆，錯誤 {errors} 次")
    return {"updated": updated, "errors": errors}


if __name__ == "__main__":
    days         = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    target_stock = sys.argv[2] if len(sys.argv) > 2 else None
    backfill(days, target_stock)
