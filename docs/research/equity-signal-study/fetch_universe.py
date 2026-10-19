import json, os, time, urllib.request, urllib.parse
SP = os.environ.get("SR_DATA", "sr_data")
syms = ["RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN","BHARTIARTL","KOTAKBANK","LT","AXISBANK","ASIANPAINT","MARUTI","SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","WIPRO","HCLTECH","M&M","BAJFINANCE","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIPORTS","COALINDIA","TECHM","GRASIM","HINDALCO","DRREDDY","CIPLA","EICHERMOT","BPCL","HEROMOTOCO","DIVISLAB","BRITANNIA","INDUSINDBK","APOLLOHOSP","TATACONSUM","BAJAJ-AUTO","SUZLON","TATAMOTORS","PIDILITIND","DABUR","GAIL","IOC","SIEMENS"]
now = int(time.time()); ok = 0
for s in syms:
    fn = os.path.join(SP, s.replace("&","_").replace("-","_") + ".json")
    if os.path.exists(fn): continue
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%s.NS?interval=1d&period1=0&period2=%d&events=div%%7Csplit" % (urllib.parse.quote(s, safe=""), now)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf8")
        d = json.loads(body)["chart"]["result"][0]
        if d["meta"].get("dataGranularity") != "1d": print("NON-DAILY", s, d["meta"].get("dataGranularity")); continue
        open(fn, "w", encoding="utf8").write(body); ok += 1; print("ok", s, len(d["timestamp"]), flush=True)
    except Exception as e:
        print("fail", s, str(e)[:80], flush=True)
    time.sleep(1.2)
print("done", ok, flush=True)
