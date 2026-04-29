#!/usr/bin/env python3
"""
台股強勢族群分析
- TWSE API：取得今日所有上市股票成交資料 → 前50大
- yfinance：補充產業分類
- 計算各族群平均漲跌幅，列出前三強勢族群
"""

import requests
import pandas as pd
import yfinance as yf
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

HEADERS = {'User-Agent': 'Mozilla/5.0'}


def get_twse_daily():
    """從 TWSE 取得今日所有上市股票行情（一次抓全部）
    欄位：證券代號, 證券名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數
    """
    url = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json"
    r = requests.get(url, headers=HEADERS, timeout=15)
    data = r.json()

    if data.get('stat') != 'OK':
        raise Exception(f"TWSE API 回傳錯誤：{data.get('stat')}")

    rows = []
    for row in data.get('data', []):
        try:
            stock_no    = row[0].strip()
            stock_name  = row[1].strip()
            volume      = int(row[2].replace(',', ''))       # 成交股數（股）
            close       = float(row[7].replace(',', ''))     # 收盤價
            change_val  = row[8].replace(',', '').strip()    # 漲跌價差（含正負號）

            change_price = float(change_val) if change_val not in ['--', ''] else 0.0
            prev_close   = close - change_price
            change_pct   = round(change_price / prev_close * 100, 2) if prev_close != 0 else 0.0

            rows.append({
                'stock_no':   stock_no,
                'stock_name': stock_name,
                'volume':     volume,
                'close':      close,
                'change_pct': change_pct,
            })
        except Exception:
            continue

    df = pd.DataFrame(rows)
    # 只保留4位數字代號的一般股票（排除 ETF、特別股等）
    df = df[df['stock_no'].str.match(r'^\d{4}$')]
    return df


def get_twse_sector_map():
    """從 TWSE 取得上市股票的產業分類對照表"""
    url = "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.encoding = 'big5'

    sector_map = {}
    current_sector = '其他'
    for line in r.text.split('\n'):
        # 判斷是否為產業分類標題行（無股票代號）
        if '<td bgcolor=#' in line:
            import re
            cells = re.findall(r'<td[^>]*>(.*?)</td>', line)
            cells = [c.strip() for c in cells if c.strip()]
            if len(cells) == 1:
                current_sector = cells[0]
            elif len(cells) >= 2:
                code = cells[0][:4]
                if code.isdigit() and len(code) == 4:
                    sector_map[code] = current_sector
    return sector_map


def get_yfinance_sector(stock_nos, batch_size=10):
    """用 yfinance 批次取得產業分類（備用，當 TWSE 解析失敗時）"""
    sector_map = {}
    tickers = [f"{no}.TW" for no in stock_nos]

    print(f"  用 yfinance 補充 {len(tickers)} 檔產業分類...")
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i+batch_size]
        for ticker in batch:
            try:
                info = yf.Ticker(ticker).info
                sector = info.get('industry') or info.get('sector') or '其他'
                sector_map[ticker.replace('.TW', '')] = sector
            except Exception:
                pass
    return sector_map


def analyze():
    today = datetime.now().strftime('%Y-%m-%d')
    print(f"\n{'='*50}")
    print(f"  台股強勢族群分析 — {today}")
    print(f"{'='*50}\n")

    # 1. 取得今日行情
    print("📡 抓取 TWSE 今日行情...")
    df = get_twse_daily()
    if df.empty:
        print("❌ 無法取得今日資料（可能尚未收盤或休市）")
        return
    print(f"   取得 {len(df)} 檔上市股票\n")

    # 2. 取前 50 大成交量
    top50 = df.nlargest(50, 'volume').copy()
    print("📊 成交量前 50 大個股：")
    for _, r in top50.head(10).iterrows():
        vol_b = r['volume'] / 1000  # 轉為張
        sign  = '▲' if r['change_pct'] > 0 else '▼' if r['change_pct'] < 0 else ' '
        print(f"   {r['stock_no']} {r['stock_name']:<8} "
              f"收盤:{r['close']:>7.1f}  "
              f"{sign}{abs(r['change_pct']):>5.2f}%  "
              f"量:{vol_b:>8,.0f}張")
    print(f"   ... 共 50 檔")

    # 3. 取得產業分類
    print("\n🏭 取得產業分類...")
    sector_map = {}
    try:
        sector_map = get_twse_sector_map()
        print(f"   TWSE 產業對照：{len(sector_map)} 筆")
    except Exception as e:
        print(f"   TWSE 解析失敗（{e}），改用 yfinance...")

    # 對應產業
    top50['sector'] = top50['stock_no'].map(sector_map)

    # 缺少產業的，用 yfinance 補充
    missing = top50[top50['sector'].isna()]['stock_no'].tolist()
    if missing:
        yf_sectors = get_yfinance_sector(missing)
        top50.loc[top50['stock_no'].isin(missing), 'sector'] = \
            top50.loc[top50['stock_no'].isin(missing), 'stock_no'].map(yf_sectors)
    top50['sector'] = top50['sector'].fillna('其他')

    # 4. 計算各族群平均漲跌幅
    sector_stats = (
        top50.groupby('sector')
        .agg(
            股票數=('stock_no', 'count'),
            平均漲跌幅=('change_pct', 'mean'),
            最大漲幅=('change_pct', 'max'),
            成交量合計=('volume', 'sum'),
        )
        .reset_index()
        .sort_values('平均漲跌幅', ascending=False)
    )

    # 5. 輸出前三強勢族群
    print(f"\n{'='*50}")
    print("  🚀 前三強勢族群（成交量前50大個股中）")
    print(f"{'='*50}")

    medals = ['🥇', '🥈', '🥉']
    for i, (_, row) in enumerate(sector_stats.head(3).iterrows()):
        print(f"\n{medals[i]} 第{i+1}名：{row['sector']}")
        print(f"   平均漲跌幅：{row['平均漲跌幅']:+.2f}%")
        print(f"   族群股票數：{int(row['股票數'])} 檔")
        print(f"   最大漲幅：{row['最大漲幅']:+.2f}%")

        # 顯示該族群的個股
        stocks_in_sector = top50[top50['sector'] == row['sector']].sort_values('change_pct', ascending=False)
        for _, s in stocks_in_sector.iterrows():
            sign = '▲' if s['change_pct'] > 0 else '▼'
            print(f"     • {s['stock_no']} {s['stock_name']:<8} {sign}{abs(s['change_pct']):.2f}%")

    # 6. 完整族群排行
    print(f"\n{'='*50}")
    print("  📋 所有族群排行（前50大成交量）")
    print(f"{'='*50}")
    print(f"{'族群':<12} {'平均漲跌幅':>10} {'股數':>5} {'最大漲幅':>10}")
    print('-' * 45)
    for _, row in sector_stats.iterrows():
        sign = '▲' if row['平均漲跌幅'] > 0 else '▼'
        print(f"{row['sector']:<12} {sign}{abs(row['平均漲跌幅']):>8.2f}%  "
              f"{int(row['股票數']):>4}檔  "
              f"{row['最大漲幅']:>+8.2f}%")

    print(f"\n✅ 分析完成 ({today})")


if __name__ == '__main__':
    analyze()
