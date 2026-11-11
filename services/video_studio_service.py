from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import random
import re
import shutil
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
CLIP_CACHE_DIR = DATA_DIR / "clip_cache"
CLIP_CACHE_DIR.mkdir(parents=True, exist_ok=True)

GEMINI_VOICES = {"Aoede", "Kore", "Puck", "Fenrir", "Charon"}

VOICE_CATALOG = [
    {
        "id": "Puck",
        "name": "🎙️ Puck (Google AI • ชาย • Podcast Ads จังหวะกระฉับกระเฉง • แนะนำ)",
        "gender": "Male",
        "engine": "gemini",
    },
    {
        "id": "Aoede",
        "name": "✨ Aoede (Google AI • หญิง • สดใส มีพลัง เล่าเรื่องป้ายยา)",
        "gender": "Female",
        "engine": "gemini",
    },
    {
        "id": "Kore",
        "name": "✨ Kore (Google AI • หญิง • นุ่มนวล ชัดเจน น่าเชื่อถือ)",
        "gender": "Female",
        "engine": "gemini",
    },
    {
        "id": "Fenrir",
        "name": "⚡ Fenrir (Google AI • ชาย • หนักแน่น ทรงพลัง โปรโมชันเดือด)",
        "gender": "Male",
        "engine": "gemini",
    },
    {
        "id": "Charon",
        "name": "☕ Charon (Google AI • ชาย • ทุ้มลึก สุขุม พรีเมียม)",
        "gender": "Male",
        "engine": "gemini",
    },
]

# Map raw keywords/patterns to simple, everyday spoken Thai product nouns
SIMPLE_PRODUCT_NOUN_PATTERNS: List[Tuple[List[str], str]] = [
    (["คลิปฉลาม", "กิ๊บฉลาม", "กิ๊บหนีบผม", "กิ๊บติดผม", "กิ๊บ"], "กิ๊บติดผม"),
    (["ยางรัดผม", "ยางมัดผม", "โดนัทรัดผม"], "ยางรัดผม"),
    (["ที่คาดผม"], "ที่คาดผม"),
    (["หม้อทอดไร้น้ำมัน", "หม้อทอดอากาศ", "หม้ออบลมร้อน"], "หม้อทอดไร้น้ำมัน"),
    (["หม้อต้มไฟฟ้า", "หม้อชาบู", "หม้อไฟฟ้า", "หม้ออเนกประสงค์", "หม้อหุงข้าว"], "หม้อไฟฟ้า"),
    (["กระทะไฟฟ้า", "กระทะปิ้งย่าง"], "กระทะไฟฟ้า"),
    (["กาต้มน้ำ", "กาน้ำร้อน"], "กาต้มน้ำไฟฟ้า"),
    (["เครื่องปั่น"], "เครื่องปั่น"),
    (["เครื่องชงกาแฟ"], "เครื่องชงกาแฟ"),
    (["กระเป๋าสะพาย", "กระเป๋าถือ", "กระเป๋าเป้", "กระเป๋าเดินทาง", "กระเป๋าตังค์", "กระเป๋า"], "กระเป๋า"),
    (["ไม้กันสั่น", "กิมบอล", "stabilizer", "osmo mobile"], "ไม้กันสั่นมือถือ"),
    (["ขาตั้งกล้อง", "ขาตั้งมือถือ", "ไม้เซลฟี่", "tripod"], "ขาตั้งมือถือ"),
    (["พัดลมพกพา", "พัดลมคล้องคอ", "พัดลมตั้งโต๊ะ", "พัดลมไร้สาย", "พัดลม"], "พัดลมพกพา"),
    (["สายชาร์จ"], "สายชาร์จ"),
    (["พาวเวอร์แบงค์", "แบตสำรอง"], "แบตสำรอง"),
    (["หัวชาร์จ", "อะแดปเตอร์"], "หัวชาร์จ"),
    (["หูฟังบลูทูธ", "หูฟังไร้สาย", "หูฟัง"], "หูฟังไร้สาย"),
    (["ลำโพงบลูทูธ", "ลำโพง"], "ลำโพงบลูทูธ"),
    (["ไมโครโฟนไร้สาย", "ไมค์ไร้สาย", "ไมค์ติดปกเสื้อ", "ไมค์"], "ไมค์ไร้สาย"),
    (["ไฟไลฟ์สด", "โคมไฟตั้งโต๊ะ", "ไฟแต่งห้อง", "โคมไฟ"], "โคมไฟ"),
    (["เครื่องดูดฝุ่น", "หุ่นยนต์ดูดฝุ่น"], "เครื่องดูดฝุ่น"),
    (["เครื่องฟอกอากาศ"], "เครื่องฟอกอากาศ"),
    (["เตารีดไอน้ำ", "เตารีด"], "เตารีดไอน้ำ"),
    (["ไดร์เป่าผม"], "ไดร์เป่าผม"),
    (["เครื่องหนีบผม", "เครื่องม้วนผม"], "ที่จัดแต่งทรงผม"),
    (["เครื่องนวด", "ปืนนวด"], "เครื่องนวด"),
    (["แก้วเก็บความเย็น", "กระบอกน้ำ"], "แก้วเก็บความเย็น"),
    (["กล่องเก็บของ", "กล่องจัดระเบียบ"], "กล่องเก็บของ"),
    (["ชั้นวางของ"], "ชั้นวางของ"),
    (["รองเท้าผ้าใบ", "รองเท้าแตะ", "รองเท้า"], "รองเท้า"),
    (["แว่นกันแดด", "แว่นกรองแสง", "แว่นตา"], "แว่นตา"),
    (["เคสโทรศัพท์", "เคสไอโฟน", "เคส"], "เคสมือถือ"),
    (["เก้าอี้เกมมิ่ง", "เก้าอี้ทำงาน", "เก้าอี้"], "เก้าอี้"),
    (["โต๊ะปรับระดับ", "โต๊ะทำงาน", "โต๊ะพับ", "โต๊ะ"], "โต๊ะ"),
    (["ลิปสติก", "ลิป"], "ลิป"),
    (["คุชชั่น"], "คุชชั่น"),
    (["ครีมกันแดด"], "ครีมกันแดด"),
    (["เซรั่ม"], "เซรั่ม"),
    (["นาฬิกาอัจฉริยะ", "สมาร์ทวอทช์", "นาฬิกา"], "นาฬิกา"),
    (["คีย์บอร์ด"], "คีย์บอร์ด"),
    (["เมาส์"], "เมาส์ไร้สาย"),
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
    return {"gemini_api_keys": [], "default_voice": "Puck"}


def save_studio_config(gemini_keys_raw: str | List[str], default_voice: str = "Puck") -> Dict[str, Any]:
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
        "generationConfig": {"maxOutputTokens": 10, "thinkingConfig": {"thinkingBudget": 0}},
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
# Simple Product Category Extractor & Boilerplate Filter
# ---------------------------------------------------------------------------
def extract_simple_product_category(title: str, description: str = "") -> str:
    """
    Extract a simple everyday Thai noun for the product (e.g. 'กิ๊บติดผม', 'หม้อไฟฟ้า', 'กระเป๋า')
    instead of reading out a noisy or machine-translated Shopee product title.
    """
    combined_title = (title or "").lower()
    for patterns, noun in SIMPLE_PRODUCT_NOUN_PATTERNS:
        for pat in patterns:
            if pat.lower() in combined_title:
                return noun

    combined_desc = (description or "").lower()
    for patterns, noun in SIMPLE_PRODUCT_NOUN_PATTERNS:
        for pat in patterns:
            if pat.lower() in combined_desc:
                return noun

    return "ไอเทมชิ้นนี้"


STORE_BOILERPLATE_KEYWORDS = [
    "เสียหาย",
    "แตกหัก",
    "สูญหาย",
    "ค่าชดเชย",
    "ความคิดเห็นเชิงลบ",
    "ผู้ขายที่ซื่อสัตย์",
    "ติดต่อฉัน",
    "ฝากข้อความ",
    "ทางออกที่น่าพอใจ",
    "ถ่ายวิดีโอตอนแกะ",
    "ไม่รับเปลี่ยนคืน",
    "ขนส่งล่าช้า",
    "ให้คะแนน",
    "5 ดาว",
    "ขอบคุณสำหรับการสนับสนุน",
]


def filter_real_product_features(raw_desc: str) -> str:
    if not raw_desc:
        return ""
    lines = re.split(r"[\r\n☆•●◆▪▸►]+", raw_desc)
    kept: List[str] = []
    for line in lines:
        s = line.strip()
        if len(s) < 4:
            continue
        if any(bad in s for bad in STORE_BOILERPLATE_KEYWORDS):
            continue
        kept.append(s)
    return "\n".join(kept[:12])


# ---------------------------------------------------------------------------
# Word-Safe Thai Subtitle & Text Helpers (NEVER split a Thai word in half!)
# ---------------------------------------------------------------------------
THAI_COMBINING_MARKS = set("\u0e31\u0e34\u0e35\u0e36\u0e37\u0e38\u0e39\u0e3a\u0e47\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e4d\u0e4e")
THAI_LEADING_VOWELS = set("\u0e40\u0e41\u0e42\u0e43\u0e44")

# Natural Thai connector words where a line break is safe if there are no spaces
SAFE_THAI_BREAK_PREFIXES = (
    "เพราะ",
    "ช่วยให้",
    "ทำให้",
    "เหมาะกับ",
    "ใช้งาน",
    "พกพา",
    "วัสดุ",
    "ดีไซน์",
    "สามารถ",
    "ไม่ว่าจะ",
    "แถมยัง",
    "เวลา",
    "สำหรับ",
    "ตัวนี้",
    "ใบนี้",
    "ชิ้นนี้",
    "แบบ",
    "พร้อม",
    "หรือ",
    "และ",
)


def strip_polite_particles(text: str) -> str:
    """
    Strips Thai polite particles (ครับ, ค่ะ, นะคะ, นะครับ, คะ) from script so sentences are natural and direct.
    """
    if not text:
        return ""
    # Strip polite particles with optional leading 'นะ'
    s = re.sub(r'(?:นะ)?(?:ครับ|ค่ะ|คะ)', '', text)
    s = re.sub(r'\s{2,}', ' ', s).strip()
    return s


def clean_spoken_text(raw: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"#[^\s#]+", "", str(raw))
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"[*_~`>|•●◆▪▸►☆★]+", " ", s)
    s = strip_polite_particles(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def split_verbatim_two_lines(phrase: str) -> Tuple[str, str]:
    """
    Split a spoken phrase into at most 2 subtitle lines ONLY at spaces or natural word boundaries.
    NEVER cuts a Thai word in the middle!
    """
    p = re.sub(r"\s+", " ", (phrase or "").strip())
    if not p:
        return "", ""
    if len(p) <= 22:
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

    # No spaces in phrase: look for a safe connector word near the middle
    mid = len(p) // 2
    best_pos = -1
    best_dist = 999
    for prefix in SAFE_THAI_BREAK_PREFIXES:
        idx = p.find(prefix, 6)
        if 6 <= idx <= len(p) - 6:
            dist = abs(idx - mid)
            if dist < best_dist:
                best_dist = dist
                best_pos = idx

    if best_pos > 0:
        return p[:best_pos].strip(), p[best_pos:].strip()

    # Keep intact on 1 line rather than cutting a Thai word in half!
    return p, ""


def smart_split_scenes(text: str, target_sec: int = 20) -> List[Dict[str, str]]:
    cleaned = clean_spoken_text(text)
    if not cleaned:
        return []

    raw_chunks = [c.strip() for c in re.split(r"[\n\r.!?;—–]+|\s{2,}", cleaned) if c.strip()]
    phrases: List[str] = []
    max_phrase_len = 34

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

    scenes: List[Dict[str, str]] = []
    for ph in phrases:
        top, bottom = split_verbatim_two_lines(ph)
        scenes.append(
            {
                "line_top": top,
                "line_bottom": bottom,
                "full_narration": ph,
            }
        )
    return scenes


# ---------------------------------------------------------------------------
# AI Script + Header + Subtitles Generation (Google Gemini)
# ---------------------------------------------------------------------------
async def generate_product_review_script(
    product_title: str,
    product_description: str,
    target_duration: int = 20,
    sales_angle: str = "podcast_ad",
    custom_header: str = "",
    voice_gender: str = "Male",
    api_key: str = "",
) -> Dict[str, Any]:
    target_sec = max(10, min(90, int(target_duration or 20)))
    target_scenes = max(4, min(18, int(round(target_sec / 3.2))))
    target_chars = int(target_sec * 12.5)
    min_chars = int(target_chars * 0.78)

    simple_noun = extract_simple_product_category(product_title, product_description)
    clean_features = filter_real_product_features(product_description)

    angle_instructions = {
        "podcast_ad": (
            "สไตล์รายการ Podcast ชวนคุยอย่างเป็นกันเอง เล่าจุดเด่นแบบน่าสนใจ มีจังหวะทอดเสียงน่าฟัง "
            "เปิดเรื่องชวนคุยแบบเพื่อนเล่าให้เพื่อนฟัง ไม่แข็งทื่อ ไม่โฆษณาเกินจริง"
        ),
        "hard_sell": "เล่าจุดเด่นและการใช้งานจริงแบบเข้าใจง่าย ชวนให้น่าลองใช้แบบเป็นธรรมชาติ ไม่โฆษณาเกินจริง",
        "review_real": "เล่าเหมือนเพื่อนมารีวิวของใช้จริงให้ฟัง บอกว่าใช้ทำอะไร สะดวกยังไง พูดธรรมดาเป็นธรรมชาติ",
        "feature_focus": "อธิบายจุดเด่น การใช้งาน และความคุ้มค่าแบบตรงไปตรงมา สไตล์สาระน่ารู้ผสมความน่าสนใจ",
        "flash_promo": "แนะนำของน่าใช้ สั้น กระชับ มีพลังสไตล์สปอตโฆษณาด่วน ชวนติดตาม",
    }
    tone_desc = angle_instructions.get(sales_angle, angle_instructions["podcast_ad"])

    prompt_text = f"""คุณคือนักจัดรายการ Podcast ที่กำลังพูดคุยรีวิวของใช้ดีๆ ในชีวิตประจำวันสำหรับคลิปสั้น
หน้าที่ของคุณ: เขียน "บทพากย์ภาษาไทย" และ "พาดหัวด้านบนคลิป (short_headline)" ความยาวประมาณ {target_sec} วินาที

ข้อมูลอ้างอิง:
- ประเภทสินค้าที่ต้องใช้เรียกในคลิป: "{simple_noun}"
- ข้อมูลเสริมจากร้านค้า (ใช้ดูเฉพาะลักษณะสินค้า ห้ามลอกคำแปลกๆ มาพูด): {product_title[:120]} | {clean_features[:800]}
- สไตล์และโทนการพูด: {tone_desc}

กฎเหล็กสำคัญที่สุด (ต้องทำตาม 100%):
1. **ห้ามมีคำลงท้าย 'ครับ', 'นะครับ', 'ค่ะ', 'นะคะ', 'คะ' ในบทพูดแม้แต่คำเดียว (มีโทษปรับตกทันที)!**
   - ให้ประโยคจบอย่างกระชับ เล่าแบบสนทนาเปิดใจ เช่น 'ทุกคน วันนี้มีไอเทมเด็ดมาบอกต่อ' 'ตัวนี้ตอบโจทย์มาก' 'ใครชอบความคุ้มค่าลองดูตัวนี้ได้เลย'
2. **ห้ามพูดชื่อสินค้าเต็มๆ ห้ามพูดชื่อรุ่นยาวๆ และห้ามเอาคำแปลภาษาจีนแปลกๆ ในชื่อสินค้ามาพูดเด็ดขาด!**
   - ให้เรียกสินค้าสั้นๆ แค่ว่าเป็นอะไร เช่น "{simple_noun}ตัวนี้", "{simple_noun}ชิ้นนี้", หรือ "{simple_noun}รุ่นนี้" เท่านั้น!
3. **ห้ามขายของเกินจริงเด็ดขาด!**
   - ห้ามใช้คำเว่อร์ๆ เช่น ดีที่สุดในโลก, วิเศษ, เทพสุดๆ, เปลี่ยนชีวิต
   - ห้ามเอาข้อความเงื่อนไขการรับประกัน การจัดส่ง หรือการเคลมสินค้าของร้านค้ามาพูดเด็ดขาด
   - ให้พูดรีวิวแบบคนทั่วไปใช้งานจริง เช่น ใช้ทำอะไรได้บ้าง หยิบใช้ง่ายยังไง พกพาสะดวกไหม
4. **"short_headline" (Header ด้านบนคลิป)**:
   - ต้องเป็นคำไทยสั้นๆ ที่อ่านเข้าใจทันที บอกแค่ว่าคืออะไร เช่น "{simple_noun} หยิบใช้ง่ายพกพาสะดวก" หรือ "{simple_noun} เก็บทรงสวยใช้งานง่าย"
   - ความยาวไม่เกิน 18 ตัวอักษร และเว้นวรรคระหว่างวลีให้ชัดเจน **ห้ามตัดคำกลางคันเด็ดขาด**
5. **การแบ่งท่อนซับไตเติ้ล ("scenes") จำนวนประมาณ {target_scenes} ท่อน**:
   - แต่ละท่อนมี "line_top" (บรรทัดบน) และ "line_bottom" (บรรทัดล่าง)
   - "line_top" และ "line_bottom" ต้องเป็นคำเต็มๆ ที่อ่านรู้เรื่องทันที **ห้ามฉีกคำเดียวกันแยกคนละบรรทัดเด็ดขาด!** (บรรทัดละไม่เกิน 15 ตัวอักษร)
   - "full_narration" คือคำพูดของท่อนนั้น (มีเว้นวรรคระหว่างคำพูดอย่างเป็นธรรมชาติ)
   - ความยาวบทพูดรวมทั้งหมดประมาณ {target_chars} ตัวอักษร (ไม่ต่ำกว่า {min_chars} ตัวอักษร)
   - ความยาวบทพูดรวมทั้งหมดประมาณ {target_chars} ตัวอักษร (ไม่ต่ำกว่า {min_chars} ตัวอักษร)
   - ความยาวบทพูดรวมทั้งหมดประมาณ {target_chars} ตัวอักษร (ไม่ต่ำกว่า {min_chars} ตัวอักษร)

ตอบกลับเป็น JSON เท่านั้น โครงสร้าง:
{{
  "short_headline": "{simple_noun} ใช้งานง่ายสะดวก",
  "spoken_script": "บทพูดรวมทั้งหมด...",
  "scenes": [
    {{
      "line_top": "บรรทัดบนคำเต็ม",
      "line_bottom": "บรรทัดล่างคำเต็ม",
      "full_narration": "บรรทัดบนคำเต็ม บรรทัดล่างคำเต็ม"
    }}
  ]
}}"""

    keys = pick_rotated_keys(api_key)
    models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"]
    parsed_result: Optional[Dict[str, Any]] = None
    model_used: Optional[str] = None

    for key in keys:
        for m in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key}"
            gen_cfg: Dict[str, Any] = {
                "responseMimeType": "application/json",
                "temperature": 0.65,
            }
            if "2.5" in m:
                gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}

            payload = {
                "contents": [{"parts": [{"text": prompt_text}]}],
                "generationConfig": gen_cfg,
            }
            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
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
                print(f"[Studio] Gemini script generation ({m}) notice: {repr(exc)}")
        if parsed_result:
            break

    if parsed_result:
        raw_scenes = parsed_result.get("scenes") or []
        spoken_script = (parsed_result.get("spoken_script") or "").strip()
        short_headline = (custom_header or parsed_result.get("short_headline") or "").strip()

        normalized_scenes: List[Dict[str, str]] = []
        for s in raw_scenes:
            top = clean_spoken_text(s.get("line_top") or "")
            bot = clean_spoken_text(s.get("line_bottom") or "")
            narr = clean_spoken_text(s.get("full_narration") or f"{top} {bot}")
            if not narr:
                continue
            if not top and not bot:
                top, bot = split_verbatim_two_lines(narr)
            normalized_scenes.append(
                {
                    "line_top": top,
                    "line_bottom": bot,
                    "full_narration": narr,
                }
            )
        if not normalized_scenes and spoken_script:
            normalized_scenes = smart_split_scenes(spoken_script, target_sec=target_sec)
    else:
        # Clean, realistic, non-exaggerated fallback using only simple_noun!
        short_headline = (custom_header or f"{simple_noun} ใช้งานง่ายพกพาสะดวก").strip()
        normalized_scenes = [
            {
                "line_top": f"ใครกำลังมองหา{simple_noun}",
                "line_bottom": "ไว้ใช้งานในชีวิตประจำวัน",
                "full_narration": f"ใครกำลังมองหา{simple_noun} ไว้ใช้งานในชีวิตประจำวัน",
            },
            {
                "line_top": f"{simple_noun}ตัวนี้ออกแบบมา",
                "line_bottom": "ให้หยิบใช้งานได้สะดวกมาก",
                "full_narration": f"{simple_noun}ตัวนี้ออกแบบมา ให้หยิบใช้งานได้สะดวกมาก",
            },
            {
                "line_top": "งานประกอบเรียบร้อยแข็งแรง",
                "line_bottom": "ขนาดกำลังดีพกพาง่าย",
                "full_narration": "งานประกอบเรียบร้อยแข็งแรง ขนาดกำลังดีพกพาง่าย",
            },
            {
                "line_top": "ตอบโจทย์การใช้งานจริง",
                "line_bottom": "ในราคาที่คุ้มค่าสบายกระเป๋า",
                "full_narration": "ตอบโจทย์การใช้งานจริง ในราคาที่คุ้มค่าสบายกระเป๋า",
            },
            {
                "line_top": "ใครสนใจกดดูรายละเอียด",
                "line_bottom": "ที่พิกัดตะกร้าได้เลย",
                "full_narration": "ใครสนใจกดดูรายละเอียด ที่พิกัดตะกร้าได้เลย",
            },
        ]

    combined_script = " ".join(s["full_narration"] for s in normalized_scenes)
    if not short_headline:
        short_headline = f"{simple_noun} ใช้งานง่ายสะดวก"

    return {
        "short_headline": short_headline,
        "spoken_script": combined_script,
        "scenes": normalized_scenes,
        "simple_product_noun": simple_noun,
        "model_used": model_used or "clean-fallback",
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
    tts_models = [
        "gemini-3.8-flash-tts",
        "gemini-3.8-flash-lite-tts",
        "gemini-3.1-flash-tts-preview",
        "gemini-2.5-flash-preview-tts",
    ]

    speaking_prompt = (
        "Role: Energetic Thai Podcast & Commercial Announcer.\n"
        "Style: Dynamic, punchy, persuasive Podcast Ads style. Speak with confidence and excitement at an upbeat, snappy tempo like a top TikTok/Shopee creator. "
        "Do NOT speak slowly, do NOT pause awkwardly, and do NOT sound sleepy.\n"
        "Text to read in Thai:\n"
        f"{strip_polite_particles(text)}"
    )

    last_err = ""
    for key in keys:
        for model in tts_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            payload = {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": speaking_prompt
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


async def _synthesize_edge_tts(text: str, voice_name: str, speed_rate: str = "+10%") -> Tuple[bytes, str, str]:
    import edge_tts

    edge_voice = voice_name
    if edge_voice in GEMINI_VOICES or not edge_voice.startswith("th-TH"):
        edge_voice = (
            "th-TH-PremwadeeNeural"
            if voice_name in ("Aoede", "Kore", "th-TH-PremwadeeNeural")
            else "th-TH-NiwatNeural"
        )

    # Podcast warmth & calm delivery: pitch -2Hz for Niwat, gentle +10% rate for natural conversational storytelling
    pitch = "-2Hz" if edge_voice == "th-TH-NiwatNeural" else "+0Hz"
    clean_text = strip_polite_particles(text)

    communicate = edge_tts.Communicate(text=clean_text, voice=edge_voice, rate=speed_rate, pitch=pitch)
    audio_chunks = bytearray()
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            audio_chunks.extend(chunk["data"])

    if not audio_chunks:
        raise RuntimeError("Edge TTS returned empty audio")
    label_prefix = "Podcast Host ชาย (คุณนิวัฒน์)" if edge_voice == "th-TH-NiwatNeural" else "Podcast Host หญิง (คุณเปรมวดี)"
    return bytes(audio_chunks), "audio/mpeg", label_prefix


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
# Convert WebM/MP4 to High-Quality MP4 via FFmpeg (H.264 + AAC + FastStart)
# ---------------------------------------------------------------------------
def convert_video_file_to_mp4(in_file: str, out_file: str, fps: int = 30) -> None:
    """
    Converts an input video file (e.g. WebM from MediaRecorder) to a universally compatible MP4
    (H.264 High Profile, AAC audio, yuv420p, +faststart) using FFmpeg.
    Includes PTS regeneration and negative timestamp normalization to prevent drift.
    """
    ffmpeg_bin = get_ffmpeg_binary()
    safe_fps = 60 if str(fps) == "60" else 30

    # 1. Primary command: H.264 + AAC with audio resample sync
    cmd = [
        ffmpeg_bin,
        "-y",
        "-fflags", "+genpts",
        "-avoid_negative_ts", "make_zero",
        "-i", in_file,
        "-c:v", "libx264",
        "-crf", "20",
        "-preset", "fast",
        "-r", str(safe_fps),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-af", "aresample=async=1000",
        "-movflags", "+faststart",
        out_file,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    if proc.returncode == 0 and os.path.exists(out_file) and os.path.getsize(out_file) > 0:
        return

    # 2. Fallback command: without audio filter in case input WebM has no audio track
    cmd_fallback = [
        ffmpeg_bin,
        "-y",
        "-fflags", "+genpts",
        "-avoid_negative_ts", "make_zero",
        "-i", in_file,
        "-c:v", "libx264",
        "-crf", "20",
        "-preset", "fast",
        "-r", str(safe_fps),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_file,
    ]
    proc2 = subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    if proc2.returncode != 0 or not os.path.exists(out_file) or os.path.getsize(out_file) == 0:
        err_msg = (proc.stderr or proc2.stderr).decode("utf-8", errors="replace")[-400:]
        raise RuntimeError(f"FFmpeg แปลงไฟล์ไม่สำเร็จ: {err_msg}")


def convert_video_data_url_to_mp4(video_data_url: str, fps: int = 30) -> bytes:
    if not video_data_url or "," not in video_data_url:
        raise ValueError("ข้อมูลวิดีโอไม่ถูกต้อง")

    _, encoded = video_data_url.rsplit(",", 1)
    video_bytes = base64.b64decode(encoded)
    if not video_bytes:
        raise ValueError("ไฟล์วิดีโอว่างเปล่า")

    with tempfile.TemporaryDirectory(prefix="studio_mp4_") as tmpdir:
        in_file = os.path.join(tmpdir, "input.webm")
        out_file = os.path.join(tmpdir, "output.mp4")
        with open(in_file, "wb") as f:
            f.write(video_bytes)

        convert_video_file_to_mp4(in_file, out_file, fps)

        with open(out_file, "rb") as f:
            return f.read()
