"""語音合成：Microsoft Edge 神經語音（免費、免金鑰），台灣口音。"""
import hashlib
from pathlib import Path

import edge_tts

CACHE = Path(__file__).resolve().parent.parent / "data" / "tts_cache"


async def synthesize(text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz") -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{voice}|{rate}|{pitch}|{text}".encode()).hexdigest()
    path = CACHE / f"{key}.mp3"
    if path.exists():
        return path.read_bytes()

    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    audio = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("TTS 沒有回傳音訊")
    path.write_bytes(bytes(audio))
    return bytes(audio)
