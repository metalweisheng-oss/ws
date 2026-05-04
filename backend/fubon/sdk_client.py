"""
富邦 SDK 登入封裝 — 供其他模組共用
"""
from fubon_neo.sdk import FubonSDK, Mode
from .config import FUBON_ID, FUBON_API_KEY

_sdk = None

def get_sdk(mode: Mode = Mode.Normal) -> FubonSDK:
    global _sdk
    if _sdk is not None:
        return _sdk

    sdk = FubonSDK()
    result = sdk.apikey_dma_login(FUBON_ID, FUBON_API_KEY)
    if not result.is_success:
        raise RuntimeError(f"Fubon 登入失敗: {result.message}")

    sdk.init_realtime(mode)
    _sdk = sdk
    print(f"[fubon] 登入成功 ({FUBON_ID})")
    return sdk
