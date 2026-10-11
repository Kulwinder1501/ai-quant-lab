"""
Time-of-Day (ToD) Regime Classifier for Indian Equity / Derivative Markets.

Classifies session timestamps into standard microstructural intraday regimes:
  - OPENING_DRIVE (09:15 - 09:45): High initial volatility, price discovery
  - MORNING_TREND (09:45 - 11:30): Primary directional trend establishment
  - MIDDAY_CONSOLIDATION (11:30 - 13:30): Low volume, mean-reverting/sideways
  - AFTERNOON_EXPANSION (13:30 - 15:00): Institutional positioning / European open impact
  - CLOSING_AUCTION (15:00 - 15:30): End-of-day rebalancing and closing roll

STRICT BOUNDARY: Strictly an offline research module under apps/ml/.
DO NOT IMPORT into apps/api or live strategy inference components.
"""

from datetime import datetime, time
from typing import Union
import pandas as pd


OPENING_DRIVE = "OPENING_DRIVE"
MORNING_TREND = "MORNING_TREND"
MIDDAY_CONSOLIDATION = "MIDDAY_CONSOLIDATION"
AFTERNOON_EXPANSION = "AFTERNOON_EXPANSION"
CLOSING_AUCTION = "CLOSING_AUCTION"
OUT_OF_SESSION = "OUT_OF_SESSION"


def classify_tod_regime(ts: Union[datetime, pd.Timestamp, str, time]) -> str:
    """
    Classifies a timestamp or time object into its ToD market regime.
    """
    if isinstance(ts, str):
        ts = pd.to_datetime(ts)

    if isinstance(ts, (datetime, pd.Timestamp)):
        t = ts.time()
    elif isinstance(ts, time):
        t = ts
    else:
        return OUT_OF_SESSION

    t_num = t.hour * 60 + t.minute

    # 09:15 is 555 mins, 09:45 is 585 mins
    if 555 <= t_num < 585:
        return OPENING_DRIVE
    # 09:45 to 11:30 (690 mins)
    elif 585 <= t_num < 690:
        return MORNING_TREND
    # 11:30 to 13:30 (810 mins)
    elif 690 <= t_num < 810:
        return MIDDAY_CONSOLIDATION
    # 13:30 to 15:00 (900 mins)
    elif 810 <= t_num < 900:
        return AFTERNOON_EXPANSION
    # 15:00 to 15:30 (930 mins)
    elif 900 <= t_num <= 930:
        return CLOSING_AUCTION
    else:
        return OUT_OF_SESSION


def add_tod_features(
    df: pd.DataFrame, timestamp_col: str = "timestamp"
) -> pd.DataFrame:
    """
    Adds 'tod_regime' categorical column and one-hot encoded flags to DataFrame.
    """
    result = df.copy()
    ts_series = pd.to_datetime(result[timestamp_col])
    result["tod_regime"] = ts_series.apply(classify_tod_regime)

    for regime in [
        OPENING_DRIVE,
        MORNING_TREND,
        MIDDAY_CONSOLIDATION,
        AFTERNOON_EXPANSION,
        CLOSING_AUCTION,
    ]:
        result[f"is_{regime.lower()}"] = (result["tod_regime"] == regime).astype(int)

    return result
