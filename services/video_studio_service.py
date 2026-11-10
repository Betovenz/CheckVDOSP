from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import random
import re
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
STUDIO_CONFIG_PATH = DATA_DIR / "studio_config.json"

GEMINI_VOICES = {"Aoede", "Kore", "Puck", "Fenrir", "Charon"}

VOICE_CATALOG = [
    {
        "id": "th-TH-NiwatNeural",
        "name": "🎙️ คุณนิวัฒน์ (ชาย • เสียงฉะฉาน คมชัด สไตล์ครีเอเตอร์รีวิว • แนะนำ)",
        "gender": "Male",
        "engine": "edge",
    },
    {
        "id": "th-TH-PremwadeeNeural",
        "name": "🎙️ คุณเปรมวดี (หญิง • เสียงนุ่มนวล สดใส ป้ายยาสินค้า • แนะนำ)",
        "gender": "Female",
        "engine": "edge",
    },
    {
        "id": "Puck",
        "name": "✨ Puck (Google AI ชาย • กระฉับกระเฉง มีพลัง สายเทค/แกดเจ็ต)",
        "gender": "Male",
        "engine": "gemini",
    },
    {
        "id": "Aoede",
        "name": "✨ Aoede (Google AI หญิง • สดใส เล่าเรื่อง Reels / TikTok)",
        "gender": "Female",
        "engine": "gemini",
    },
    {
        "id": "Kore",
        "name": "✨ Kore (Google AI หญิง • สุภาพ ชัดเจน น่าเชื่อถือ)",
        "gender": "Female",
        "engine": "gemini",
    },
    {
        "id": "Fenrir",
        "name": "✨ Fenrir (Google AI ชาย • หนักแน่น ทรงพลัง โปรโมชันเดือด)",
        "gender": "Male",
        "engine": "gemini",
    },
    {
        "id": "Charon",
        "name": "✨ Charon (Google AI ชาย • ทุ้มลึก สุขุม พรีเมียม)",
        "gender": "Male",
        "engine": "gemini",
    },
    {
        "id": "Google-Thai",
        "name": "🔊 Google Thai Voice (มาตรฐาน • ฟรีไร้โควตา 100%)",
        "gender": "Female",
        "engine": "gtts",
    },
]

_KEY_ROTATION_INDEX = 0


def get_ffmpeg_binary() -> str:
    sys_ff = shutil.which("ffmpeg")
    if sys_ff:
        return sys_ff
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def load_studio_config() -> Dict[str, Any]:
    if STUDIO_CONFIG_PATH.exists():
        try:
            data = json.loads(STUDIO_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {"gemini_api_keys": [], "default_voice": "th-TH-NiwatNeural"}


def save_studio_config(gemini_keys_raw: str | List[str], default_voice: str = "th-TH-NiwatNeural") -> Dict[str, Any]:
    if isinstance(gemini_keys_raw, str):
        raw_list = re.split(r"[\r\n,;]+", gemini_keys_raw)
    else:
        raw_list = [str(x) for x in gemini_keys_raw]

    cleaned: List[str] = []
    for k in raw_list:
        s = k.strip()
        if s and not s.startswith("http") and s not in cleaned:
            cleaned.append(s)

    cfg = load_studio_config()
    cfg["gemini_api_keys"] = cleaned
    if default_voice:
        cfg["default_voice"] = default_voice
    STUDIO_CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def get_all_gemini_keys(extra_key: str = "") -> List[str]:
    keys: List[str] = []
    if extra_key:
        for k in re.split(r"[\r\n,;]+", extra_key):
            ks = k.strip()
            if ks and not ks.startswith("http") and ks not in keys:
                keys.append(ks)

    cfg = load_studio_config()
    for k in cfg.get("gemini_api_keys") or []:
        ks = str(k).strip()
        if ks and ks not in keys:
            keys.append(ks)

    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key and env_key not in keys:
        keys.append(env_key)

    return keys


def pick_rotated_keys(extra_key: str = "") -> List[str]:
    global _KEY_ROTATION_INDEX
    keys = get_all_gemini_keys(extra_key)
    if len(keys) <= 1:
        return keys
    start = _KEY_ROTATION_INDEX % len(keys)
    _KEY_ROTATION_INDEX += 1
    return keys[start:] + keys[:start]


async def test_gemini_api_key(api_key: str) -> Tuple[bool, str]:
    keys = get_all_gemini_keys(api_key)
    if not keys:
        return False, "กรุณากรอก Google AI (Gemini) API Key ก่อนทดสอบ"

    test_key = keys[0]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={test_key}"
    payload = {
        "contents": [{"parts": [{"text": "ตอบคำว่า OK สั้นๆ"}]}],
        "generationConfig": {"maxOutputTokens": 10},
    }
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                return True, f"เชื่อมต่อ Google AI สำเร็จ! (พร้อมใช้งาน {len(keys)} คีย์)"
            err_data = resp.json() if resp.content else {}
            msg = (err_data.get("error") or {}).get("message") or f"HTTP {resp.status_code}"
            return False, f"API Key ไม่ถูกต้องหรือติดจำกัดโควตา: {msg}"
    except Exception as exc:
        return False, f"เชื่อมต่อไม่สำเร็จ: {exc}"


# ---------------------------------------------------------------------------
# Thai Text & Verbatim Two-Line Subtitle Helpers (Ported from Make VSO)
# ---------------------------------------------------------------------------
THAI_COMBINING_MARKS = set("\u0e31\u0e34\u0e35\u0e36\u0e37\u0e38\u0e39\u0e3a\u0e47\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e4d\u0e4e")
THAI_LEADING_VOWELS = set("\u0e40\u0e41\u0e42\u0e43\u0e44")


def _adjust_thai_Cluster_split(text: str, pos: int) -> int:
    n = len(text)
    pos = max(0, min(n, pos))
    while pos < n and text[pos] in THAI_COMBINING_MARKS:
        pos += 1
    while pos > 0 and text[pos - 1] in THAI_LEADING_VOWELS:
        pos -= 1
    return pos


def clean_spoken_text(raw: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"#[^\s#]+", "", str(raw))
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"[*_~`>|•●◆▪▸►]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def split_verbatim_two_lines(phrase: str) -> Tuple[str, str]:
    p = re.sub(r"\s+", " ", (phrase or "").strip())
    if not p:
        return "", ""
    if len(p) <= 18:
        return p, ""

    words = [w for w in p.split(" ") if w]
    if len(words) >= 2:
        best_idx = 1
        best_diff = 999999
        for i in range(1, len(words)):
            top_cand = " ".join(words[:i])
            bot_cand = " ".join(words[i:])
            diff = abs(len(top_cand) - len(bot_cand))
            if diff < best_diff:
                best_diff = diff
                best_idx = i
        return " ".join(words[:best_idx]), " ".join(words[best_idx:])

    mid = _adjust_thai_Cluster_split(p, len(p) // 2)
    if mid <= 0 or mid >= len(p):
        return p, ""
    return p[:mid].strip(), p[mid:].strip()


def smart_split_scenes(text: str, target_sec: int = 20) -> List[Dict[str, str]]:
    cleaned = clean_spoken_text(text)
    if not cleaned:
        return []

    raw_chunks = [c.strip() for c in re.split(r"[\n\r.!?;•—–]+|\s{2,}", cleaned) if c.strip()]
    phrases: List[str] = []
    max_phrase_len = 36

    for chunk in raw_chunks:
        words = chunk.split(" ")
        cur = ""
        for w in words:
            if not cur:
                cur = w
            elif len(cur) + 1 + len(w) <= max_phrase_len:
                cur = f"{cur} {w}"
            else:
                phrases.append(cur)
                cur = w
        if cur:
            phrases.append(cur)

    final_phrases: List[str] = []
    for ph in phrases:
        while len(ph) > 42:
            cut = _adjust_thai_Cluster_split(ph, 28)
            if cut <= 0 or cut >= len(ph):
                break
            final_phrases.append(ph[:cut].strip())
            ph = ph[cut:].strip()
        if ph:
            final_phrases.append(ph)

    scenes: List[Dict[str, str]] = []
    for ph in final_phrases:
        top, bottom = split_verbatim_two_lines(ph)
        scenes.append(
            {
                "line_top": top,
                "line_bottom": bottom,
                "full_narration": ph,
            }
        )
    return scenes


def extract_fallback_headline(title: str, script: str) -> str:
    base = re.sub(r"\[[^\]]*\]|\([^\)]*\)", "", title or "").strip()
    base = re.sub(r"^(พร้อมส่ง|ส่งฟรี|ของแท้|โค้ดส่วนลด|ใหม่ล่าสุด)\s*", "", base, flags=re.IGNORECASE).strip()
    parts = [p.strip() for p in re.split(r"[|/•\-–—]+", base) if len(p.strip()) >= 3]
    candidate = parts[0] if parts else base
    if len(candidate) > 26:
        words = candidate.split(" ")
        acc = ""
        for w in words:
            if len(acc) + len(w) + 1 <= 26:
                acc = f"{acc} {w}".strip()
            else:
                break
        if len(acc) >= 6:
            candidate = acc
        else:
            cut_pos = _adjust_thai_Cluster_split(candidate, 24)
            candidate = candidate[:cut_pos].strip()
    return candidate or "ไอเทมเด็ดต้องมี!"


# ---------------------------------------------------------------------------
# AI Script + Header + Subtitles Generation (Google Gemini)
# ---------------------------------------------------------------------------
async def generate_product_review_script(
    product_title: str,
    product_description: str,
    target_duration: int = 20,
    sales_angle: str = "hard_sell",
    custom_header: str = "",
    api_key: str = "",
) -> Dict[str, Any]:
    target_sec = max(10, min(90, int(target_duration or 20)))
    target_scenes = max(4, min(20, int(round(target_sec / 3.2))))
    target_chars = int(target_sec * 13.5)
    min_chars = int(target_chars * 0.8)

    angle_instructions = {
        "hard_sell": "โทนป้ายยาขายของสุดเร้าใจ เปิดด้วยปัญหาหรือจุดเด่นที่หยุดนิ้วคนดู บอกฟีเจอร์เด่นและปิดท้ายด้วยพิกัดตะกร้า/ลิงก์",
        "review_real": "โทนรีวิวใช้จริงเหมือนเพื่อนป้ายยา เล่าข้อดีที่ใช้งานแล้วชอบมาก คุ้มค่าราคา พูดเป็นธรรมชาติ",
        "feature_focus": "โทนเจาะลึกสเปกและฟังก์ชันเด่น สรุปสั้นกระชับเป็นข้อๆ เข้าใจง่ายในคลิปเดียว",
        "flash_promo": "โทนโปรโมชันลดแรง ของมันต้องมี รีบตำก่อนของหมด กระตุ้นการตัดสินใจซื้อทันที",
    }
    tone_desc = angle_instructions.get(sales_angle, angle_instructions["hard_sell"])

    prompt_text = f"""คุณคือครีเอเตอร์และนักเขียนบทวิดีโอสั้นขายสินค้า (TikTok / Shopee Video / Reels) มืออาชีพ
หน้าที่ของคุณ: เขียน "บทพากย์รีวิวสินค้า (Spoken Script)" และ "พาดหัวบนสุดของคลิป (short_headline)" จากข้อมูลสินค้าด้านล่าง ให้มีความยาวพอดีกับเวลา {target_sec} วินาที

ข้อมูลสินค้า:
- ชื่อสินค้า: {product_title or 'สินค้าขายดี'}
- รายละเอียดสินค้า: {(product_description or '')[:2500]}
- สไตล์การเล่าเรื่อง: {tone_desc}

กฎเหล็กสำคัญมาก:
1. "short_headline": ข้อความพาดหัว Header ด้านบนคลิป ต้อง **สั้น กระชับ ตัวใหญ่สะดุดตา 3-5 คำ (ไม่เกิน 20 ตัวอักษร)** เช่น "ไม้กันสั่น AI ตามติดชีวิต!" หรือ "พัดลมเทอร์โบ ลมแรงสะใจ!" หรือ "ของมันต้องมี คุ้มเกินราคา!"
2. "spoken_script": บทพูดพากย์ไทยต่อเนื่องกัน ความยาวรวมประมาณ {target_chars} ตัวอักษร (ห้ามสั้นกว่า {min_chars} ตัวอักษร) ใช้ภาษาพูดที่ลื่นไหล น่าฟัง กระชับ ไม่เยิ่นเย้อ
3. แบ่งบทพูดออกเป็น {target_scenes} ท่อนซับไตเติ้ล (scenes) เรียงตามลำดับการพูด โดยคำพูดในซับไตเติ้ลต้องตรงกับคำพูดจริง 100%:
   - "full_narration": ประโยคพูดของท่อนนี้
   - "line_top": ซับไตเติ้ลบรรทัดบน (กระชับ ไม่เกิน 16 ตัวอักษร)
   - "line_bottom": ซับไตเติ้ลบรรทัดล่าง (กระชับ ไม่เกิน 16 ตัวอักษร)

ตอบกลับเป็น JSON เท่านั้น โครงสร้าง:
{{
  "short_headline": "พาดหัวสั้นๆ เด่นๆ ไม่เกิน 20 ตัวอักษร",
  "spoken_script": "บทพากย์รวมทั้งหมด...",
  "scenes": [
    {{
      "line_top": "บรรทัดบน",
      "line_bottom": "บรรทัดล่าง",
      "full_narration": "ประโยคพูดของท่อนนี้"
    }}
  ]
}}"""

    keys = pick_rotated_keys(api_key)
    models = ["gemini-2.5-flash", "gemini-2.0-flash"]
    parsed_result: Optional[Dict[str, Any]] = None
    model_used: Optional[str] = None

    for key in keys:
        for m in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key}"
            payload = {
                "contents": [{"parts": [{"text": prompt_text}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0.75,
                },
            }
            try:
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(url, json=payload)
                    if resp.status_code != 200:
                        continue
                    data = resp.json()
                    raw_json = (
                        data.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", "")
                    )
                    if raw_json:
                        cand = json.loads(raw_json)
                        if isinstance(cand, dict) and (cand.get("scenes") or cand.get("spoken_script")):
                            parsed_result = cand
                            model_used = m
                            break
            except Exception as exc:
                print(f"[Studio] Gemini script generation ({m}) warning: {exc}")
        if parsed_result:
            break

    if parsed_result:
        scenes = parsed_result.get("scenes") or []
        spoken_script = (parsed_result.get("spoken_script") or "").strip()
        short_headline = (custom_header or parsed_result.get("short_headline") or "").strip()
        if not scenes and spoken_script:
            scenes = smart_split_scenes(spoken_script, target_sec=target_sec)
    else:
        # Fallback auto-script from Shopee product info when no API key or quota reached
        clean_title = clean_spoken_text(product_title) or "ไอเทมเด็ดขายดี"
        clean_desc = clean_spoken_text(product_description)
        fallback_lines = [
            f"ใครกำลังมองหา {clean_title[:35]} บอกเลยว่าตัวนี้ตอบโจทย์สุดๆ",
            clean_desc[:140] if clean_desc else "วัสดุพรีเมียม แข็งแรงทนทาน ใช้งานง่ายพกพาสะดวกมากๆ",
            "ช่วยให้ชีวิตง่ายขึ้นเยอะ ฟังก์ชันครบจบในตัวเดียว คุ้มค่าเกินราคาแน่นอน",
            "ใครสนใจรีบกดดูที่พิกัดตะกร้าได้เลย ก่อนของจะหมดนะครับ",
        ]
        spoken_script = " ".join(fallback_lines)
        scenes = smart_split_scenes(spoken_script, target_sec=target_sec)
        short_headline = (custom_header or extract_fallback_headline(product_title, spoken_script)).strip()

    # Normalize scenes so line_top & line_bottom match full_narration 100%
    normalized_scenes: List[Dict[str, str]] = []
    for s in scenes:
        narr = clean_spoken_text(s.get("full_narration") or f"{s.get('line_top', '')} {s.get('line_bottom', '')}")
        if not narr:
            continue
        top, bot = split_verbatim_two_lines(narr)
        normalized_scenes.append(
            {
                "line_top": top,
                "line_bottom": bot,
                "full_narration": narr,
            }
        )

    combined_script = " ".join(s["full_narration"] for s in normalized_scenes)
    if not short_headline:
        short_headline = extract_fallback_headline(product_title, combined_script)

    return {
        "short_headline": short_headline,
        "spoken_script": combined_script,
        "scenes": normalized_scenes,
        "model_used": model_used or "smart-fallback",
    }


# ---------------------------------------------------------------------------
# Voiceover Synthesis (Gemini TTS + Edge Neural TTS + Google TTS Fallback)
# ---------------------------------------------------------------------------
def _pcm16_to_wav_bytes(pcm_bytes: bytes, sample_rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


async def _synthesize_gemini_tts(text: str, voice_name: str, api_key: str) -> Tuple[bytes, str, str]:
    keys = pick_rotated_keys(api_key)
    if not keys:
        raise RuntimeError("No Gemini API key configured")

    actual_voice = voice_name if voice_name in GEMINI_VOICES else "Puck"
    tts_models = ["gemini-2.5-flash-preview-tts", "gemini-2.0-flash-exp"]

    last_err = ""
    for key in keys:
        for model in tts_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            payload = {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": f"อ่านออกเสียงภาษาไทยด้วยน้ำเสียงนักรีวิวสินค้าที่กระฉับกระเฉง ชัดเจน เป็นธรรมชาติ ห้ามอ่านตกหล่น:\n{text}"
                            }
                        ]
                    }
                ],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": actual_voice,
                            }
                        }
                    },
                },
            }
            try:
                async with httpx.AsyncClient(timeout=28.0) as client:
                    resp = await client.post(url, json=payload)
                    if resp.status_code != 200:
                        last_err = f"HTTP {resp.status_code}"
                        continue
                    data = resp.json()
                    parts = (
                        data.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [])
                    )
                    for part in parts:
                        inline = part.get("inlineData") or {}
                        b64_data = inline.get("data")
                        mime = inline.get("mimeType", "")
                        if b64_data:
                            raw_bytes = base64.b64decode(b64_data)
                            if "pcm" in mime.lower() or not raw_bytes.startswith(b"RIFF"):
                                wav_bytes = _pcm16_to_wav_bytes(raw_bytes, 24000)
                            else:
                                wav_bytes = raw_bytes
                            return wav_bytes, "audio/wav", f"Google AI Voice ({actual_voice})"
            except Exception as exc:
                last_err = str(exc)

    raise RuntimeError(f"Gemini TTS unavailable: {last_err}")


async def _synthesize_edge_tts(text: str, voice_name: str, speed_rate: str = "+15%") -> Tuple[bytes, str, str]:
    import edge_tts

    edge_voice = voice_name
    if edge_voice in GEMINI_VOICES or not edge_voice.startswith("th-TH"):
        edge_voice = (
            "th-TH-PremwadeeNeural"
            if voice_name in ("Aoede", "Kore", "th-TH-PremwadeeNeural")
            else "th-TH-NiwatNeural"
        )

    communicate = edge_tts.Communicate(text=text, voice=edge_voice, rate=speed_rate)
    audio_chunks = bytearray()
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            audio_chunks.extend(chunk["data"])

    if not audio_chunks:
        raise RuntimeError("Edge TTS returned empty audio")
    return bytes(audio_chunks), "audio/mpeg", f"Thai Neural Studio ({edge_voice})"


async def _synthesize_google_gtts(text: str) -> Tuple[bytes, str, str]:
    chunks = [c.strip() for c in re.split(r"(?<=[\s.!?,])\s*", text) if c.strip()]
    merged: List[str] = []
    cur = ""
    for w in chunks:
        if len(cur) + len(w) + 1 <= 160:
            cur = f"{cur} {w}".strip()
        else:
            if cur:
                merged.append(cur)
            cur = w
    if cur:
        merged.append(cur)
    if not merged:
        merged = [text[:180]]

    out_mp3 = bytearray()
    async with httpx.AsyncClient(timeout=15.0) as client:
        for seg in merged:
            url = (
                "https://translate.google.com/translate_tts"
                f"?ie=UTF-8&client=tw-ob&tl=th&q={quote(seg)}"
            )
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200 and r.content:
                out_mp3.extend(r.content)

    if not out_mp3:
        raise RuntimeError("Google Thai TTS failed")
    return bytes(out_mp3), "audio/mpeg", "Google Thai Voice"


def get_audio_duration_seconds(audio_bytes: bytes, mime_type: str = "audio/mpeg") -> float:
    if not audio_bytes:
        return 10.0

    if audio_bytes.startswith(b"RIFF"):
        try:
            with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0:
                    return round(frames / float(rate), 2)
        except Exception:
            pass

    ffmpeg_bin = get_ffmpeg_binary()
    suffix = ".wav" if "wav" in mime_type else ".mp3"
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
            tf.write(audio_bytes)
            tmp_path = tf.name
        try:
            proc = subprocess.run(
                [ffmpeg_bin, "-i", tmp_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=8,
            )
            stderr_txt = proc.stderr.decode("utf-8", errors="replace")
            m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_txt)
            if m:
                hh, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
                dur = hh * 3600 + mm * 60 + ss
                if dur > 0.3:
                    return round(dur, 2)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    except Exception:
        pass

    return round(max(4.0, len(audio_bytes) / 4200.0), 2)


async def synthesize_voiceover_and_timings(
    scenes: List[Dict[str, Any]],
    spoken_script: str,
    voice_name: str = "th-TH-NiwatNeural",
    speed_rate: str = "+15%",
    api_key: str = "",
) -> Dict[str, Any]:
    clean_scenes = [s for s in scenes if (s.get("full_narration") or "").strip()]
    if not clean_scenes and spoken_script:
        clean_scenes = smart_split_scenes(spoken_script, target_sec=20)

    combined_text = " ".join(s["full_narration"].strip() for s in clean_scenes).strip() or spoken_script.strip()
    if not combined_text:
        raise ValueError("ไม่มีข้อความสำหรับพากย์เสียง")

    audio_bytes: Optional[bytes] = None
    mime_type = "audio/mpeg"
    engine_label = ""
    fallback_notice = ""

    # 1. Google Thai TTS if explicitly chosen
    if voice_name == "Google-Thai":
        try:
            audio_bytes, mime_type, engine_label = await _synthesize_google_gtts(combined_text)
        except Exception as e:
            print("[Studio] gTTS error:", e)

    # 2. Gemini Live / REST TTS if Gemini voice selected
    if not audio_bytes and voice_name in GEMINI_VOICES:
        try:
            audio_bytes, mime_type, engine_label = await _synthesize_gemini_tts(
                combined_text, voice_name=voice_name, api_key=api_key
            )
        except Exception as ge:
            fallback_notice = f"สลับใช้เสียงพากย์ Thai Neural อัตโนมัติ ({str(ge)[:45]})"

    # 3. Microsoft Edge Neural TTS (Primary for Niwat/Premwadee or Fallback)
    if not audio_bytes:
        try:
            audio_bytes, mime_type, engine_label = await _synthesize_edge_tts(
                combined_text, voice_name=voice_name, speed_rate=speed_rate
            )
        except Exception as ee:
            print("[Studio] Edge TTS warning, falling back to gTTS:", ee)
            audio_bytes, mime_type, engine_label = await _synthesize_google_gtts(combined_text)

    duration_sec = get_audio_duration_seconds(audio_bytes, mime_type)

    # Compute exact proportional start & duration for each subtitle scene
    char_lengths = [max(4, len(s.get("full_narration") or "")) for s in clean_scenes]
    total_chars = max(1, sum(char_lengths))

    cursor = 0.0
    timed_scenes: List[Dict[str, Any]] = []
    for idx, s in enumerate(clean_scenes):
        if idx == len(clean_scenes) - 1:
            seg_dur = max(0.6, round(duration_sec - cursor, 2))
        else:
            seg_dur = max(0.7, round((char_lengths[idx] / total_chars) * duration_sec, 2))
        timed_scenes.append(
            {
                "index": idx,
                "start": round(cursor, 2),
                "duration": seg_dur,
                "line_top": s.get("line_top", ""),
                "line_bottom": s.get("line_bottom", ""),
                "full_narration": s.get("full_narration", ""),
            }
        )
        cursor = round(cursor + seg_dur, 2)

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    return {
        "audio_base64": audio_b64,
        "mime_type": mime_type,
        "audio_duration": duration_sec,
        "engine": engine_label,
        "fallback_notice": fallback_notice,
        "scenes": timed_scenes,
        "spoken_script": combined_text,
    }


# ---------------------------------------------------------------------------
# Convert WebM/MP4 Data URL to High-Quality MP4 via FFmpeg
# ---------------------------------------------------------------------------
def convert_video_data_url_to_mp4(video_data_url: str, fps: int = 30) -> bytes:
    if not video_data_url or "," not in video_data_url:
        raise ValueError("ข้อมูลวิดีโอไม่ถูกต้อง")

    _, encoded = video_data_url.rsplit(",", 1)
    video_bytes = base64.b64decode(encoded)
    if not video_bytes:
        raise ValueError("ไฟล์วิดีโอว่างเปล่า")

    ffmpeg_bin = get_ffmpeg_binary()
    safe_fps = 60 if str(fps) == "60" else 30

    with tempfile.TemporaryDirectory(prefix="studio_mp4_") as tmpdir:
        in_file = os.path.join(tmpdir, "input.webm")
        out_file = os.path.join(tmpdir, "output.mp4")
        with open(in_file, "wb") as f:
            f.write(video_bytes)

        cmd = [
            ffmpeg_bin,
            "-y",
            "-i",
            in_file,
            "-c:v",
            "libx264",
            "-crf",
            "20",
            "-preset",
            "fast",
            "-r",
            str(safe_fps),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            out_file,
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        if proc.returncode != 0 or not os.path.exists(out_file) or os.path.getsize(out_file) == 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace")[-400:]
            raise RuntimeError(f"FFmpeg แปลงไฟล์ไม่สำเร็จ: {err_msg}")

        with open(out_file, "rb") as f:
            return f.read()
