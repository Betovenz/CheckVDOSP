import asyncio
import datetime
import html
import json
import re
import urllib.parse
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
import httpx

BASE_DIR = Path(__file__).resolve().parent.parent
CHANNELS_FILE = BASE_DIR / "shopee_channels.json"
AFFILIATE_BASE = "https://affiliate.shopee.co.th"

# Curated Thai -> Simplified Chinese E-Commerce Product Dictionary
# Maps common Thai Shopee product categories/nouns to authentic Chinese Douyin/Bilibili search terms
THAI_TO_ZH_PRODUCT_DICT: List[Tuple[str, str]] = [
    ("หม้อทอดไร้น้ำมัน", "空气炸锅"),
    ("หม้อทอดอากาศ", "空气炸锅"),
    ("หม้ออบลมร้อน", "空气炸锅"),
    ("หม้อหุงข้าว", "电饭煲"),
    ("หม้อชาบู", "电火锅"),
    ("หม้อต้มไฟฟ้า", "电煮锅"),
    ("กระทะไฟฟ้า", "电炒锅"),
    ("เตาแม่เหล็กไฟฟ้า", "电磁炉"),
    ("เครื่องปั่นน้ำผลไม้", "榨汁机"),
    ("เครื่องปั่น", "搅拌机"),
    ("เครื่องชงกาแฟ", "咖啡机"),
    ("กาต้มน้ำร้อน", "电热水壶"),
    ("กาต้มน้ำไฟฟ้า", "电热水壶"),
    ("เครื่องดูดฝุ่นไร้สาย", "无线吸尘器"),
    ("เครื่องดูดฝุ่น", "吸尘器"),
    ("หุ่นยนต์ดูดฝุ่น", "扫地机器人"),
    ("เครื่องฟอกอากาศ", "空气净化器"),
    ("เครื่องทำความชื้น", "加湿器"),
    ("เครื่องลดความชื้น", "除湿机"),
    ("พัดลมพกพา", "手持风扇"),
    ("พัดลมคล้องคอ", "挂脖风扇"),
    ("พัดลมไร้สาย", "无线风扇"),
    ("พัดลมไอเย็น", "冷风机"),
    ("พัดลมตั้งโต๊ะ", "桌面风扇"),
    ("พัดลม", "电风扇"),
    ("เตารีดไอน้ำ", "挂烫机"),
    ("เตารีด", "电熨斗"),
    ("ไดร์เป่าผม", "吹风机"),
    ("เครื่องหนีบผม", "直发器"),
    ("เครื่องม้วนผม", "卷发棒"),
    ("แปรงสีฟันไฟฟ้า", "电动牙刷"),
    ("ไหมขัดฟันพลังน้ำ", "冲牙器"),
    ("เครื่องโกนหนวดไฟฟ้า", "电动剃须刀"),
    ("เครื่องโกนหนวด", "剃须刀"),
    ("เครื่องนวดคอ", "颈椎按摩器"),
    ("ปืนนวดกล้ามเนื้อ", "筋膜枪"),
    ("เครื่องนวด", "按摩器"),
    ("หูฟังบลูทูธ", "蓝牙耳机"),
    ("หูฟังไร้สาย", "无线蓝牙耳机"),
    ("หูฟังเกมมิ่ง", "游戏耳机"),
    ("หูฟัง", "耳机"),
    ("ลำโพงบลูทูธ", "蓝牙音箱"),
    ("ลำโพง", "音箱"),
    ("พาวเวอร์แบงค์", "充电宝"),
    ("แบตสำรอง", "充电宝"),
    ("สายชาร์จ", "数据线"),
    ("หัวชาร์จ", "充电器"),
    ("แท่นชาร์จไร้สาย", "无线充电器"),
    ("สมาร์ทวอทช์", "智能手表"),
    ("นาฬิกาอัจฉริยะ", "智能手表"),
    ("คีย์บอร์ดไร้สาย", "无线键盘"),
    ("คีย์บอร์ดเกมมิ่ง", "机械键盘"),
    ("คีย์บอร์ด", "键盘"),
    ("เมาส์ไร้สาย", "无线鼠标"),
    ("เมาส์เกมมิ่ง", "游戏鼠标"),
    ("เมาส์", "鼠标"),
    ("ไม้กันสั่นมือถือ", "手机稳定器 云台"),
    ("ไม้กันสั่น", "手机稳定器 云台"),
    ("กิมบอล", "手机云台 稳定器"),
    ("ขาตั้งไม้เซลฟี่", "自拍杆 手机支架"),
    ("ขาตั้งมือถือ", "手机支架 桌面支架"),
    ("ขาตั้งกล้อง", "三脚架 拍摄支架 手机支架"),
    ("ไม้เซลฟี่", "自拍杆"),
    ("ไฟไลฟ์สด", "补光灯"),
    ("ไมโครโฟนไร้สาย", "无线麦克风"),
    ("ไมค์ไร้สาย", "无线领夹麦克风"),
    ("ไมค์ติดปกเสื้อ", "领夹麦克风"),
    ("กล้องแอคชั่น", "运动相机"),
    ("กล้องวงจรปิด", "监控摄像头"),
    ("กล้องติดรถยนต์", "行车记录仪"),
    ("โปรเจคเตอร์", "投影仪"),
    ("เครื่องพิมพ์ฉลาก", "标签打印机"),
    ("เครื่องพิมพ์ใบเสร็จ", "热敏小票打印机"),
    ("เครื่องพิมพ์", "打印机"),
    ("เครื่องปริ้น", "打印机"),
    ("เครื่องปริ๊น", "打印机"),
    ("ปริ้นเตอร์", "打印机"),
    ("ปรินเตอร์", "打印机"),
    ("แก้วเก็บความเย็น", "保温杯"),
    ("กระบอกน้ำเก็บอุณหภูมิ", "保温杯"),
    ("กระบอกน้ำ", "水杯"),
    ("กล่องเก็บของ", "收纳盒"),
    ("ชั้นวางของ", "置物架"),
    ("กระเป๋าเดินทาง", "行李箱"),
    ("กระเป๋าสะพายข้าง", "斜挎包"),
    ("กระเป๋าเป้", "双肩包"),
    ("รองเท้าผ้าใบ", "运动鞋"),
    ("รองเท้าแตะ", "拖鞋"),
    ("เก้าอี้เกมมิ่ง", "电竞椅"),
    ("เก้าอี้ทำงาน", "人体工学椅"),
    ("โต๊ะปรับระดับ", "升降桌"),
    ("โคมไฟตั้งโต๊ะ", "台灯"),
    ("ไฟแต่งห้อง", "氛围灯"),
    ("เครื่องชั่งน้ำหนัก", "体脂秤"),
    ("เสื่อโยคะ", "瑜伽垫"),
    ("ดัมเบล", "哑铃"),
    ("ลู่วิ่งไฟฟ้า", "跑步机"),
    ("กระบะทรายแมวอัตโนมัติ", "自动猫砂盆"),
    ("เครื่องให้อาหารแมว", "自动喂食器"),
    ("น้ำพุแมว", "宠物饮水机"),
    ("กิ๊บหนีบผมฉลาม", "鲨鱼夹"),
    ("คลิปฉลาม", "鲨鱼夹"),
    ("กิ๊บฉลาม", "鲨鱼夹"),
    ("กิ๊บหนีบผม", "抓夹 发夹"),
    ("กิ๊บติดผม", "发夹"),
    ("ยางรัดผม", "发圈"),
    ("ที่คาดผม", "发箍"),
    ("แว่นกันแดด", "太阳镜"),
    ("แว่นกรองแสง", "防蓝光眼镜"),
    ("เคสโทรศัพท์", "手机壳"),
    ("เคสไอโฟน", "iPhone手机壳"),
    ("ฟิล์มกระจก", "钢化膜"),
    ("ลิปสติก", "口红"),
    ("คุชชั่น", "气垫"),
    ("ครีมกันแดด", "防晒霜"),
    ("เซรั่ม", "精华液"),
    ("มาส์กหน้า", "面膜"),
]


def extract_shopee_url_from_text(raw_input: str) -> Tuple[str, str]:
    """
    Extract Shopee URL and any accompanying share text from user input.
    Supports:
    - Full web URL: https://shopee.co.th/{slug}-i.{shop_id}.{item_id}
    - Bare product URL: https://shopee.co.th/product/{shop_id}/{item_id}
    - Short URL: https://s.shopee.co.th/4qH6Up4cLG , https://shp.ee/... , https://th.shp.ee/...
    - Affiliate landing URL: https://shopee.co.th/opaanlp/{shop_id}/{item_id}
    """
    text = (raw_input or "").strip()
    m = re.search(r'(https?://[^\s"\'<>]+)', text)
    if not m:
        return "", text
    url = m.group(1).strip()
    share_prefix = text[:m.start()].strip()
    return url, share_prefix


def parse_shop_and_item_id(url: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Parse (shop_id, item_id, slug_title) from any Shopee URL format:
    1. https://shopee.co.th/{slug}-i.{shop_id}.{item_id}
    2. https://shopee.co.th/product/{shop_id}/{item_id}
    3. https://shopee.co.th/opaanlp/{shop_id}/{item_id}
    4. https://shopee.co.th/{seller}/{item_id}
    """
    if not url:
        return None, None, None
    parsed = urllib.parse.urlparse(url)
    path = urllib.parse.unquote(parsed.path or "")

    # Pattern 1: /{slug}-i.{shop_id}.{item_id}
    m1 = re.search(r'/([^/]+)-i\.(\d+)\.(\d+)', path)
    if m1:
        slug_raw = m1.group(1).replace("-", " ").strip()
        return m1.group(2), m1.group(3), slug_raw

    # Pattern 2: /product/{shop_id}/{item_id} or /opaanlp/{shop_id}/{item_id}
    m2 = re.search(r'/(?:product|opaanlp)/(\d+)/(\d+)', path)
    if m2:
        return m2.group(1), m2.group(2), None

    # Pattern 3: generic /{shop_id}/{item_id}
    m3 = re.search(r'/(\d{5,})/(\d{6,})', path)
    if m3:
        return m3.group(1), m3.group(2), None

    return None, None, None


def _extract_meta(html_text: str, prop: str) -> str:
    """Extract content attribute from <meta property="..." content="..."> or <meta name="..." content="...">."""
    patterns = [
        rf'<meta[^>]+(?:property|name)=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{re.escape(prop)}["\']',
    ]
    for pat in patterns:
        m = re.search(pat, html_text, re.I | re.S)
        if m:
            return html.unescape(m.group(1)).strip()
    return ""


def _clean_shopee_title(raw_title: str) -> str:
    """Remove '| Shopee Thailand' or '| Shopee...' suffix from OpenGraph title, and reject generic titles."""
    t = (raw_title or "").strip()
    if t.lower().startswith("shopee thailand") or "ซื้อขายผ่านมือถือ" in t:
        return ""
    t = re.sub(r'\s*\|\s*Shopee.*$', '', t, flags=re.I)
    if t.lower() in ("shopee thailand", "shopee"):
        return ""
    return t.strip()


# Thai product modifiers -> Chinese prefix (e.g. เครื่องพิมพ์ + พกพา -> 便携打印机)
THAI_MODIFIERS_ZH: List[Tuple[str, str]] = [
    ("พกพา", "便携"),
    ("ไร้สาย", "无线"),
    ("บลูทูธ", "蓝牙"),
    ("มินิ", "迷你"),
    ("อัตโนมัติ", "自动"),
]

# Tokens that look like a "model" but are just specs (paper size, resolution, network...)
_SPEC_TOKEN_RE = re.compile(r"^(?:[A-Ba-b]\d{1,2}|\d+[Kk]|[345]G|USB(?:-?C)?|Type-?C|PC|HD|FHD|UHD|LED)$", re.I)


def _is_spec_token(text: str) -> bool:
    toks = (text or "").split()
    return bool(toks) and all(_SPEC_TOKEN_RE.match(t) for t in toks)


def _first_thai_chunk(title: str) -> str:
    """First Thai word-group of a title — on Shopee this is almost always the product noun."""
    cleaned = re.sub(r'\[[^\]]*\]|\([^\)]*\)|【[^】]*】', ' ', title or "")
    cleaned = re.sub(r'พร้อมส่ง(?:ในไทย)?|ส่งฟรี|ส่งไว|ของแท้|แท้|ราคาถูก|ลดราคา|โปรโมชั่น|ใหม่ล่าสุด|ใหม่', ' ', cleaned)
    m = re.search(r'[฀-๿]{3,}', cleaned)
    return m.group(0) if m else ""


def _extract_brand_model_from_title(title: str) -> str:
    """
    Extracts prominent Brand + Model name from a Shopee title.
    Supports complex e-commerce title patterns:
    1. Brand + Thai Category + Model Series + SKU codes:
       'Adidas รองเท้าแตะ Adilette 22 IG8263 HQ4670 ...' -> 'Adidas Adilette 22'
    2. Segmented Brand + Model:
       '[พร้อมส่ง] DJI Osmo Mobile 8P · Smartphone Stabilizer | ไม้กันสั่น' -> 'DJI Osmo Mobile 8P'
    3. Thai Category + Brand + Model:
       'พัดลมพกพา Jisulife Pro1S 5000mAh' -> 'Jisulife Pro1S'
       'หูฟังบลูทูธ Lenovo LP40 Pro ไร้สาย' -> 'Lenovo LP40 Pro'
    4. Explicit 'รุ่น ...' / 'Model ...':
       'ไม้กันสั่นมือถือ รุ่น 8P มีรีโมท' -> '8P'
    """
    if not title:
        return ""

    cleaned = re.sub(r'\[[^\]]*\]|\([^\)]*\)|【[^】]*】', ' ', title)
    promo_tags = [
        r'พร้อมส่ง(?:ในไทย)?', r'ส่งฟรี', r'ส่งไว', r'ของแท้\s*100%?', r'แท้/ป้ายไทย',
        r'แท้\s*100%?', r'รับประกัน\s*\d*\s*(?:ปี|เดือน|วัน)?', r'ประกันศูนย์(?:\s*\d+\s*ปี)?',
        r'เก็บเงินปลายทาง', r'ราคาถูก', r'โปรโมชั่น', r'ลดราคา',
    ]
    for p in promo_tags:
        cleaned = re.sub(p, ' ', cleaned, flags=re.I)

    # Check explicit 'รุ่น ...' or 'Model ...' first
    m_model_explicit = re.search(
        r'(?:รุ่น|model|type)\s*[:：]?\s*([A-Za-z0-9\-\.+]+(?:\s+[A-Za-z0-9\-\.+]+){0,2})',
        cleaned,
        re.I,
    )
    explicit_model = m_model_explicit.group(1).strip() if m_model_explicit else ""

    # Split by major segment separators (dash, pipe, slash, bullet)
    segments = [s.strip() for s in re.split(r'[|｜/·•●\t]+|\s+-\s+', cleaned) if s.strip()]
    first_seg = segments[0] if segments else cleaned

    generic_en = {
        "smartphone", "stabilizer", "official", "store", "original", "authentic",
        "warranty", "free", "shipping", "ready", "stock", "new", "version", "mini",
        "pro", "max", "plus", "ultra", "lite", "usb", "type", "cable", "fast", "charge",
        "thailand", "shopee", "wireless", "bluetooth", "portable", "smart", "genuine",
    }
    unit_pattern = (
        r'^\d+(?:\.\d+)?\s*(?:ชม|ชั่วโมง|cm|mm|m|g|kg|w|วัตต์|mah|l|ml|ลิตร|นิ้ว|ชิ้น|อัน|แพ็ค|กล่อง|ระดับ|เกียร์|fps|hz|k|v|a)$'
    )

    # Find all contiguous English/alphanumeric chunks (separated by Thai words or punctuation)
    raw_chunks = re.findall(r'[A-Za-z0-9\-\.+]+(?:\s+[A-Za-z0-9\-\.+]+)*', first_seg)
    cleaned_chunks: List[str] = []
    for chunk in raw_chunks:
        tokens = [t.strip(' -,.') for t in chunk.split() if t.strip(' -,.')]
        valid_tokens: List[str] = []
        for t in tokens:
            if re.match(unit_pattern, t, re.I):
                continue
            # Filter out year numbers or arbitrary large SKU codes (> 2050)
            if re.match(r'^\d+$', t) and int(t) > 2050:
                continue
            valid_tokens.append(t)
        # Must contain at least one non-generic word or valid model code
        if valid_tokens and any(t.lower() not in generic_en and not re.match(r'^\d+$', t) for t in valid_tokens):
            cleaned_chunks.append(" ".join(valid_tokens))

    if not cleaned_chunks:
        return explicit_model

    if len(cleaned_chunks) == 1:
        words = cleaned_chunks[0].split()
        cand = " ".join(words[:4])
        if explicit_model and explicit_model.lower() not in cand.lower():
            return f"{cand} {explicit_model}"
        return cand

    # Pattern: Multiple chunks separated by Thai text, e.g. 'Adidas' + (รองเท้าแตะ) + 'Adilette 22 IG8263 ...'
    # Chunk 0 is Brand, Chunk 1 is Model Series
    brand = cleaned_chunks[0].split()[0]
    model_words = cleaned_chunks[1].split()
    model = " ".join(model_words[:2])
    return f"{brand} {model}"


def extract_core_thai_keyword(title: str, description: str = "") -> str:
    """
    Extract the core product keyword(s) from the Shopee product title (and explicit product name in description).
    Supports extracting multiple keywords (e.g. Brand/Model + Thai Category: "DJI Osmo Mobile 8P, ไม้กันสั่น").
    Never scans raw description body for random accessory words like 'สายชาร์จ' or 'ขาตั้งกล้อง'.
    """
    # 1. Check dictionary matches strictly in TITLE first
    matched_thai_terms: List[str] = []
    for th_term, _ in THAI_TO_ZH_PRODUCT_DICT:
        if th_term in title:
            # Avoid adding a shorter substring if a more specific term already matched (e.g. 'พัดลมพกพา' vs 'พัดลม')
            if not any(th_term in existing or existing in th_term for existing in matched_thai_terms):
                matched_thai_terms.append(th_term)

    # 2. Extract Brand/Model from title if present (e.g. "DJI Osmo Mobile 8P")
    brand_model = _extract_brand_model_from_title(title)

    # 3. Check if description explicitly states "ชื่อสินค้า: ..." or "ประเภทสินค้า: ..."
    desc_product_name = ""
    if description and not matched_thai_terms:
        m_desc = re.search(r'(?:ชื่อสินค้า|ประเภทสินค้า|ชนิดสินค้า)\s*[:：]\s*([^\r\n✨☆•,，|/]{2,35})', description)
        if m_desc:
            desc_product_name = m_desc.group(1).strip()

    # Main product noun: dictionary match, else the first Thai word-group of the title
    main_noun = matched_thai_terms[0] if matched_thai_terms else ""
    if not main_noun and brand_model:
        main_noun = _first_thai_chunk(title)

    keywords_out: List[str] = []
    if brand_model and _is_spec_token(brand_model) and main_noun:
        # "A4" alone finds paper / cars — use the product noun, and pair the spec with it
        keywords_out.append(main_noun)
        keywords_out.append(f"{brand_model} {main_noun}")
    elif brand_model:
        keywords_out.append(brand_model)
    for t in matched_thai_terms[:2]:
        if t not in keywords_out:
            keywords_out.append(t)
    if not keywords_out and desc_product_name:
        keywords_out.append(desc_product_name)

    # Fill up to 3 keywords with modifier variants found in the title (e.g. เครื่องพิมพ์ + พกพา)
    if main_noun and len(keywords_out) < 3:
        if main_noun not in keywords_out:
            keywords_out.append(main_noun)
        for th_mod, _ in THAI_MODIFIERS_ZH:
            if len(keywords_out) >= 3:
                break
            if th_mod in title and th_mod not in main_noun:
                variant = f"{main_noun}{th_mod}"
                if not any(th_mod in k for k in keywords_out):
                    keywords_out.append(variant)

    if keywords_out:
        return ", ".join(keywords_out[:3])

    # 4. Clean noisy promotional words, brackets, capacities, and model codes from title
    cleaned = title
    cleaned = re.sub(r'\[[^\]]*\]|\([^\)]*\)|【[^】]*】|🔥|⚡|✨|❤️|⭐|✅|🚚', ' ', cleaned)
    promo_patterns = [
        r'พร้อมส่ง(?:ในไทย)?', r'ส่งฟรี', r'ส่งไว', r'ของแท้\s*100%?', r'แท้\s*100%?',
        r'รับประกัน\s*\d*\s*(?:ปี|เดือน|วัน)?', r'ประกันศูนย์(?:\s*\d+\s*ปี)?',
        r'เก็บเงินปลายทาง', r'ราคาถูก', r'โปรโมชั่น', r'ลดราคา', r'เกรดสูง',
        r'\b\d+(?:\.\d+)?\s*(?:ลิตร|L|ml|มล\.|วัตต์|W|mAh|นิ้ว|ซม\.|cm|mm|ชิ้น|อัน|แพ็ค|กล่อง|ชม\.|ชั่วโมง)\b',
    ]
    for pat in promo_patterns:
        cleaned = re.sub(pat, ' ', cleaned, flags=re.I)

    # Split by pipe '|' and take the first 1-2 meaningful segments
    segs = [re.sub(r'\s+', ' ', s).strip(" -|/") for s in re.split(r'[|｜]+', cleaned) if s.strip(" -|/")]
    if segs:
        return ", ".join(segs[:2])[:45].strip()

    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if len(cleaned) > 38:
        cleaned = cleaned[:38].strip()
    return cleaned or title[:35].strip()


def split_multi_keywords(raw_query: str) -> List[str]:
    """
    Splits a multi-keyword input string into individual keyword phrases so each one can be
    translated and searched equally.
    Examples:
    - "สายชาร์จ ขาตั้งกล้อง" -> ["สายชาร์จ", "ขาตั้งกล้อง"]
    - "สายชาร์จ, ขาตั้งกล้อง" -> ["สายชาร์จ", "ขาตั้งกล้อง"]
    - "DJI Osmo Mobile 8P, ไม้กันสั่น" -> ["DJI Osmo Mobile 8P", "ไม้กันสั่น"]
    - "DJI Osmo Mobile 8P ไม้กันสั่น" -> ["DJI Osmo Mobile 8P", "ไม้กันสั่น"]
    - "air fryer" -> ["air fryer"]
    """
    q = (raw_query or "").strip()
    if not q:
        return []

    # 1. Explicit delimiters (comma, pipe, slash, plus)
    if re.search(r'[,，|｜/+]', q):
        parts = [p.strip() for p in re.split(r'[,，|｜/+]+', q) if p.strip()]
        if len(parts) > 1:
            return parts

    # 2. Space-separated tokens: group contiguous ASCII/English words together (e.g. "DJI Osmo Mobile 8P" or "air fryer"),
    #    while splitting distinct Thai or Chinese words (e.g. "สายชาร์จ ขาตั้งกล้อง" -> ["สายชาร์จ", "ขาตั้งกล้อง"])
    raw_tokens = [t.strip() for t in q.split() if t.strip()]
    if len(raw_tokens) <= 1:
        return [q]

    grouped: List[str] = []
    current_ascii: List[str] = []
    for tok in raw_tokens:
        is_ascii_phrase = bool(re.match(r'^[A-Za-z0-9\-\.+]+$', tok))
        if is_ascii_phrase:
            current_ascii.append(tok)
        else:
            if current_ascii:
                grouped.append(" ".join(current_ascii))
                current_ascii = []
            grouped.append(tok)
    if current_ascii:
        grouped.append(" ".join(current_ascii))

    return grouped if grouped else [q]


BRAND_EN_TO_ZH: List[Tuple[str, str]] = [
    ("dji osmo mobile", "大疆 Osmo Mobile"),
    ("osmo mobile", "大疆 Osmo Mobile"),
    ("osmo pocket", "大疆 Osmo Pocket"),
    ("osmo action", "大疆 Osmo Action"),
    ("dji", "大疆 DJI"),
    ("insta360", "影石 Insta360"),
    ("gopro", "GoPro"),
    ("ulanzi", "优篮子"),
    ("jisulife", "几素"),
    ("baseus", "倍思"),
    ("ugreen", "绿联"),
    ("anker", "安克"),
    ("adidas", "阿迪达斯"),
    ("nike", "耐克"),
    ("lenovo", "联想"),
    ("xiaomi", "小米"),
    ("huawei", "华为"),
    ("apple", "Apple 苹果"),
    ("iphone", "iPhone"),
    ("samsung", "三星"),
    ("sony", "索尼"),
    ("simplus", "Simplus"),
    ("gaabor", "Gaabor"),
]


async def _translate_single_phrase_to_chinese(phrase: str) -> str:
    q = (phrase or "").strip()
    if not q:
        return ""

    # If already contains Chinese characters, return as-is
    if re.search(r'[\u4e00-\u9fff]', q):
        return q

    # Check known brand/model mappings (keep model numbers like "8P" intact!)
    q_lower = q.lower()
    for brand_en, brand_zh in BRAND_EN_TO_ZH:
        if brand_en in q_lower:
            # Replace brand prefix case-insensitively while keeping model suffix (e.g. "8P")
            translated_brand = re.sub(re.escape(brand_en), brand_zh, q, flags=re.I).strip()
            # If the whole phrase is ASCII/model name, return it directly without mangling model numbers
            if not re.search(r'[\u0e00-\u0e7f]', translated_brand):
                return translated_brand

    # If pure English Brand + Alphanumeric model (e.g. "iPhone 16 Pro", "Sony ZV-E10"), keep it intact if it has model digits
    if re.match(r'^[A-Za-z0-9\s\-\.+]+$', q) and re.search(r'\d', q):
        return q

    # Exact match in curated Thai dictionary
    for th_term, zh_term in THAI_TO_ZH_PRODUCT_DICT:
        if q == th_term:
            return zh_term
    # Partial match if phrase starts with a curated Thai term (e.g. "ไม้กันสั่นมีรีโมท" -> "手机稳定器 云台")
    # Keep extra spec tokens (e.g. "A4") and modifiers (e.g. "พกพา" -> 便携) around the matched term
    for th_term, zh_term in THAI_TO_ZH_PRODUCT_DICT:
        if th_term in q and len(th_term) >= 4:
            rest = q.replace(th_term, " ")
            ascii_part = " ".join(re.findall(r'[A-Za-z0-9\-\.+]+', rest))
            mods = "".join(zh for th, zh in THAI_MODIFIERS_ZH if th in rest and zh not in zh_term)
            return f"{ascii_part} {mods}{zh_term}".strip()

    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
        # Provider 1: MyMemory API (autodetect)
        try:
            r1 = await client.get(
                "https://api.mymemory.translated.net/get",
                params={"q": q, "langpair": "autodetect|zh-CN"},
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            if r1.status_code == 200:
                t1 = (r1.json().get("responseData") or {}).get("translatedText") or ""
                t1 = t1.strip(" 。，、,.!")
                if t1 and re.search(r'[\u4e00-\u9fff]', t1) and "MYMEMORY WARNING" not in t1.upper():
                    return t1
        except Exception:
            pass

        # Provider 2: clients5.google.com/translate_a/t (auto)
        try:
            r2 = await client.get(
                "https://clients5.google.com/translate_a/t",
                params={"client": "dict-chrome-ex", "sl": "auto", "tl": "zh-CN", "q": q},
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            if r2.status_code == 200:
                data2 = r2.json()
                if isinstance(data2, list) and data2:
                    first = data2[0]
                    t2 = (first[0] if isinstance(first, list) else str(first)).strip(" 。，、,.!")
                    if t2 and re.search(r'[\u4e00-\u9fff]', t2):
                        return t2
        except Exception:
            pass

        # Provider 3: translate.googleapis.com/translate_a/single (auto)
        try:
            r3 = await client.get(
                "https://translate.googleapis.com/translate_a/single",
                params={"client": "gtx", "sl": "auto", "tl": "zh-CN", "dt": "t", "q": q},
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            if r3.status_code == 200:
                data3 = r3.json()
                t3 = "".join(part[0] for part in data3[0] if part and part[0]).strip(" 。，、,.!")
                if t3 and re.search(r'[\u4e00-\u9fff]', t3):
                    return t3
        except Exception:
            pass

    return q


async def translate_to_chinese(text: str) -> str:
    """
    Translates single or multiple Thai/English keywords into Simplified Chinese (zh-CN).
    When multiple keywords are provided (e.g. "สายชาร์จ ขาตั้งกล้อง" or "DJI Osmo Mobile 8P, ไม้กันสั่น"),
    translates each keyword individually and joins them with ' | ' so downstream search engines
    fetch videos for ALL keywords equally!
    """
    phrases = split_multi_keywords(text)
    if not phrases:
        return ""
    if len(phrases) == 1:
        return await _translate_single_phrase_to_chinese(phrases[0])

    translated_list = await asyncio.gather(
        *[_translate_single_phrase_to_chinese(p) for p in phrases]
    )
    cleaned_list: List[str] = []
    for t in translated_list:
        t_clean = (t or "").strip()
        if t_clean and t_clean not in cleaned_list:
            cleaned_list.append(t_clean)
    return " | ".join(cleaned_list)


translate_thai_to_chinese = translate_to_chinese


async def build_chinese_search_keywords(title: str, description: str = "", custom_keyword: str = "") -> Dict[str, Any]:
    """
    Build the primary Chinese keyword(s) and suggested search angles for Douyin & Bilibili.
    Supports multi-keyword extraction and individual keyword chips.
    """
    if custom_keyword and custom_keyword.strip():
        core_th = custom_keyword.strip()
    else:
        core_th = extract_core_thai_keyword(title, description)

    phrases_th = split_multi_keywords(core_th)
    translated_phrases = await asyncio.gather(
        *[_translate_single_phrase_to_chinese(p) for p in phrases_th]
    )
    zh_list = [t.strip() for t in translated_phrases if t and t.strip()]
    primary_zh = " | ".join(dict.fromkeys(zh_list)) if zh_list else core_th

    # Build suggested search angle pills so user can switch between combined multi-keyword or individual keywords
    suggestions: List[Dict[str, str]] = [
        {"keyword": primary_zh, "label": "วิดีโอสินค้า (รวมทุกคำค้นหา)" if len(zh_list) > 1 else "วิดีโอสินค้า"},
    ]
    if len(zh_list) >= 2:
        direct_combined = f"{zh_list[0]} {zh_list[1]}".strip()
        suggestions.append({"keyword": direct_combined, "label": "ตรงรุ่น + หมวดหมู่"})

    if len(phrases_th) > 1 and len(zh_list) == len(phrases_th):
        for th_p, zh_p in zip(phrases_th, zh_list):
            suggestions.append({"keyword": zh_p, "label": f"เฉพาะ: {th_p}"})

    first_zh = zh_list[0] if zh_list else primary_zh
    suggestions.append({"keyword": f"{first_zh} 测评", "label": "รีวิวการใช้งาน"})
    suggestions.append({"keyword": f"{first_zh} 开箱", "label": "แกะกล่องสินค้าจริง"})

    return {
        "thai_keyword": core_th,
        "zh_keyword": primary_zh,
        "translated_title_zh": primary_zh,
        "suggested_keywords": suggestions,
    }


_PRODUCT_MEM_CACHE: Dict[str, Dict[str, Any]] = {}
SHOPEE_CONFIG_FILE = BASE_DIR / "config.json"


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _load_raw_channels() -> List[Dict[str, Any]]:
    if CHANNELS_FILE.exists():
        try:
            data = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def _save_raw_channels(channels: List[Dict[str, Any]]) -> None:
    CHANNELS_FILE.write_text(
        json.dumps(channels, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _to_public_channel(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": doc.get("id", ""),
        "label": doc.get("label", ""),
        "name": doc.get("name", ""),
        "affiliate_id": doc.get("affiliate_id", ""),
        "added_at": doc.get("added_at", ""),
        "last_checked_at": doc.get("last_checked_at", ""),
        "status": doc.get("status", "ok"),
        "error_msg": doc.get("error_msg", ""),
    }


def list_channels() -> List[Dict[str, Any]]:
    return [_to_public_channel(c) for c in _load_raw_channels()]


def list_channels_with_cookies() -> List[Dict[str, Any]]:
    return _load_raw_channels()


async def get_shopee_profile(cookie_str: str) -> Dict[str, Any]:
    """
    Verifies a Shopee Cookie against:
    1. `https://affiliate.shopee.co.th/api/v3/user/profile` (exact SPDashItem method)
    2. Fallback: `https://shopee.co.th/api/v4/account/basic/get_account_info`
    Raises ValueError if the cookie is invalid or expired.
    """
    clean_cookie = (cookie_str or "").strip()
    if not clean_cookie:
        raise ValueError("กรุณาวางค่า Cookie")

    aff_headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "th,en;q=0.9",
        "affiliate-program-type": "1",
        "cookie": clean_cookie,
        "referer": f"{AFFILIATE_BASE}/report/conversion_report",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        # 1. Try Affiliate Profile API (/api/v3/user/profile)
        try:
            r1 = await client.get(f"{AFFILIATE_BASE}/api/v3/user/profile", headers=aff_headers)
            if r1.status_code == 200:
                j1 = r1.json()
                if j1.get("code") == 0 and j1.get("data"):
                    d = j1["data"]
                    return {
                        "name": d.get("name") or d.get("shopee_user_name") or "Shopee User",
                        "affiliate_id": str(d.get("affiliate_id") or ""),
                        "raw": d,
                    }
                err_msg = j1.get("msg") or f"code {j1.get('code')}"
            else:
                err_msg = f"HTTP {r1.status_code}"
        except Exception as e:
            err_msg = str(e)

        # 2. Try Shopee Main Account Info API (/api/v4/account/basic/get_account_info)
        try:
            main_headers = {
                "accept": "application/json",
                "cookie": clean_cookie,
                "referer": "https://shopee.co.th/",
                "user-agent": aff_headers["user-agent"],
            }
            r2 = await client.get(
                "https://shopee.co.th/api/v4/account/basic/get_account_info",
                headers=main_headers,
            )
            if r2.status_code == 200:
                j2 = r2.json()
                if j2.get("error") in (0, None) and j2.get("data") and j2["data"].get("userid"):
                    d2 = j2["data"]
                    return {
                        "name": d2.get("username") or d2.get("nickname") or f"User_{d2.get('userid')}",
                        "affiliate_id": str(d2.get("userid") or ""),
                        "raw": d2,
                    }
        except Exception:
            pass

    raise ValueError(f"Cookie หมดอายุหรือไม่ถูกต้อง ({err_msg})")


async def add_channel(cookie: str, label: str = "") -> Dict[str, Any]:
    profile = await get_shopee_profile(cookie)
    channels = _load_raw_channels()
    now = _now_iso()
    entry = {
        "id": str(uuid.uuid4()),
        "label": (label or "").strip() or profile.get("name") or "ช่องใหม่",
        "cookie": cookie.strip(),
        "name": profile.get("name", ""),
        "affiliate_id": profile.get("affiliate_id", ""),
        "added_at": now,
        "last_checked_at": now,
        "status": "ok",
        "error_msg": "",
    }
    channels.append(entry)
    _save_raw_channels(channels)
    return _to_public_channel(entry)


async def refresh_channel(channel_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    channels = _load_raw_channels()
    target = next((c for c in channels if c.get("id") == channel_id), None)
    if not target:
        return None, "ไม่พบช่องทางนี้"

    now = _now_iso()
    try:
        profile = await get_shopee_profile(target.get("cookie", ""))
        target["name"] = profile.get("name") or target.get("name", "")
        target["affiliate_id"] = profile.get("affiliate_id") or target.get("affiliate_id", "")
        target["status"] = "ok"
        target["error_msg"] = ""
        target["last_checked_at"] = now
        _save_raw_channels(channels)
        return _to_public_channel(target), None
    except Exception as exc:
        target["status"] = "error"
        target["error_msg"] = str(exc)
        target["last_checked_at"] = now
        _save_raw_channels(channels)
        return _to_public_channel(target), f"รีเฟรชสถานะไม่สำเร็จ — Cookie หมดอายุแล้ว ({exc})"


async def refresh_all_channels() -> List[Dict[str, Any]]:
    channels = _load_raw_channels()
    if not channels:
        return []
    for c in channels:
        now = _now_iso()
        try:
            profile = await get_shopee_profile(c.get("cookie", ""))
            c["name"] = profile.get("name") or c.get("name", "")
            c["affiliate_id"] = profile.get("affiliate_id") or c.get("affiliate_id", "")
            c["status"] = "ok"
            c["error_msg"] = ""
            c["last_checked_at"] = now
        except Exception as exc:
            c["status"] = "error"
            c["error_msg"] = str(exc)
            c["last_checked_at"] = now
    _save_raw_channels(channels)
    return [_to_public_channel(c) for c in channels]


def update_channel_label(channel_id: str, new_label: str) -> Optional[Dict[str, Any]]:
    channels = _load_raw_channels()
    target = next((c for c in channels if c.get("id") == channel_id), None)
    if not target:
        return None
    target["label"] = new_label.strip()
    _save_raw_channels(channels)
    return _to_public_channel(target)


def remove_channel(channel_id: str) -> bool:
    channels = _load_raw_channels()
    new_list = [c for c in channels if c.get("id") != channel_id]
    if len(new_list) == len(channels):
        return False
    _save_raw_channels(new_list)
    return True


def mark_channel_expired(channel_id: str, reason: str = "Cookie หมดอายุ") -> None:
    channels = _load_raw_channels()
    for c in channels:
        if c.get("id") == channel_id:
            c["status"] = "error"
            c["error_msg"] = reason
            c["last_checked_at"] = _now_iso()
            _save_raw_channels(channels)
            break


def get_shopee_cookie() -> str:
    # First check active channels in shopee_channels.json
    for c in _load_raw_channels():
        if c.get("status") == "ok" and c.get("cookie"):
            return c["cookie"].strip()
    if SHOPEE_CONFIG_FILE.exists():
        try:
            data = json.loads(SHOPEE_CONFIG_FILE.read_text(encoding="utf-8"))
            return (data.get("shopee_cookie") or "").strip()
        except Exception:
            pass
    return ""


def set_shopee_cookie(cookie_str: str) -> None:
    data: Dict[str, Any] = {}
    if SHOPEE_CONFIG_FILE.exists():
        try:
            data = json.loads(SHOPEE_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data["shopee_cookie"] = (cookie_str or "").strip()
    SHOPEE_CONFIG_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


async def fetch_via_shopee_get_pc(shop_id: str, item_id: str, cookie_str: str = "") -> Optional[Dict[str, Any]]:
    """
    Calls Shopee's internal PDP API `/api/v4/pdp/get_pc` (and `/api/v4/item/get`)
    as used in GitHub Shopee scrapers (e.g. bintangtimurlangit/shopee-mcp, toptankcpe/shopee-scraper).
    Parses title, price (scaled by 100,000), stock, categories, attributes, images, and shop info.
    Note: Shopee Thailand returns error 90309999 (login wall) on get_pc unless a valid Shopee cookie is present.
    """
    if not shop_id or not item_id:
        return None

    active_cookie = (cookie_str or get_shopee_cookie()).strip()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
        "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
        "Referer": f"https://shopee.co.th/product/{shop_id}/{item_id}",
        "X-API-Source": "pc",
        "X-Shopee-Language": "th",
        "X-Requested-With": "XMLHttpRequest",
    }
    if active_cookie:
        headers["Cookie"] = active_cookie
        m_csrf = re.search(r"csrftoken=([^;\s]+)", active_cookie)
        if m_csrf:
            headers["X-CSRFToken"] = m_csrf.group(1)

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        for endpoint in ["https://shopee.co.th/api/v4/pdp/get_pc", "https://shopee.co.th/api/v4/pdp/get_rw"]:
            try:
                resp = await client.get(
                    endpoint,
                    params={"shop_id": shop_id, "item_id": item_id},
                    headers=headers,
                )
                if resp.status_code != 200:
                    continue
                payload = resp.json()
                if payload.get("error") or not payload.get("data"):
                    continue

                data = payload["data"]
                item = data.get("item") or data
                title = (item.get("title") or item.get("name") or "").strip()
                if not title:
                    continue

                description = (item.get("description") or "").strip()
                raw_price = item.get("price") or item.get("price_min") or 0
                price_thb = round(raw_price / 100000, 2) if raw_price > 1000 else raw_price

                # Images
                img_key = (
                    item.get("image")
                    or ((data.get("product_images") or {}).get("images") or [None])[0]
                    or ""
                )
                image_url = (
                    img_key
                    if img_key.startswith("http")
                    else (f"https://down-th.img.susercontent.com/file/{img_key}" if img_key else "")
                )

                # Categories & Attributes from get_pc
                categories = [
                    c.get("display_name")
                    for c in (item.get("categories") or data.get("categories") or [])
                    if isinstance(c, dict) and c.get("display_name")
                ]
                attrs = []
                for a in (data.get("product_attributes") or {}).get("attrs") or item.get("attributes") or []:
                    if isinstance(a, dict) and a.get("name") and a.get("value"):
                        attrs.append(f"{a['name']}: {a['value']}")

                shop_name = ((data.get("shop_detailed") or {}).get("name") or "").strip()

                return {
                    "source_api": "api/v4/pdp/get_pc",
                    "title": title,
                    "description": description,
                    "image": image_url,
                    "price": price_thb,
                    "categories": categories,
                    "attributes": attrs,
                    "shop_name": shop_name,
                }
            except Exception:
                continue
    return None


async def fetch_shopee_product_info(raw_input: str, custom_keyword: str = "") -> Dict[str, Any]:
    """
    Universal Shopee Product Link Resolver & Analyzer.
    Supports ALL Shopee link formats without requiring login:
    1. Full Web URL: https://shopee.co.th/{Product-Slug}-i.{shop_id}.{item_id}
    2. Bare Product URL: https://shopee.co.th/product/{shop_id}/{item_id}
    3. Short / Affiliate URL: https://s.shopee.co.th/4qH6Up4cLG , https://shp.ee/...
    4. Share text from Shopee App with embedded URL.
    """
    url, share_prefix = extract_shopee_url_from_text(raw_input)
    if not url:
        raise ValueError("ไม่พบลิงก์ Shopee กรุณาวางลิงก์สินค้า เช่น https://shopee.co.th/product/... หรือ https://s.shopee.co.th/...")

    shop_id, item_id, slug_title = parse_shop_and_item_id(url)
    title = ""
    description = ""
    image = ""
    price = 0
    shop_name = ""
    categories: List[str] = []
    attributes: List[str] = []
    extraction_method = "opengraph_ssr"
    canonical_url = url
    link_type = "standard"

    if "s.shopee." in url or "shp.ee" in url:
        link_type = "short_link"
    elif "/product/" in url:
        link_type = "bare_product_link"
    elif "-i." in url:
        link_type = "full_slug_link"

    async with httpx.AsyncClient(timeout=12.0) as client:
        # Step 1: If short link (s.shopee.co.th / shp.ee), resolve redirect to get shop_id & item_id
        if not shop_id or not item_id:
            try:
                client.cookies.clear()
                r_redir = await client.get(
                    url,
                    headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15"},
                    follow_redirects=False,
                )
                loc = r_redir.headers.get("location") or ""
                if loc:
                    s_id, i_id, s_slug = parse_shop_and_item_id(loc)
                    shop_id = shop_id or s_id
                    item_id = item_id or i_id
                    slug_title = slug_title or s_slug
            except Exception:
                pass

        # Step 1.5: Try Shopee's `/api/v4/pdp/get_pc` endpoint first (GitHub standard PDP API)
        if shop_id and item_id:
            pdp_data = await fetch_via_shopee_get_pc(shop_id, item_id)
            if pdp_data and pdp_data.get("title"):
                title = pdp_data["title"]
                description = pdp_data.get("description", "")
                image = pdp_data.get("image", "")
                price = pdp_data.get("price", 0)
                shop_name = pdp_data.get("shop_name", "")
                categories = pdp_data.get("categories") or []
                attributes = pdp_data.get("attributes") or []
                extraction_method = "api/v4/pdp/get_pc"
            else:
                # If we had saved channels marked "ok" but get_pc failed, verify their live cookie status
                active_channels = [c for c in _load_raw_channels() if c.get("status") == "ok"]
                if active_channels:
                    await refresh_all_channels()

        cache_key = f"{shop_id}:{item_id}" if (shop_id and item_id) else url
        if not title and cache_key in _PRODUCT_MEM_CACHE:
            cached = _PRODUCT_MEM_CACHE[cache_key]
            title = cached.get("title", "")
            description = cached.get("description", "")
            image = cached.get("image", "")
            canonical_url = cached.get("canonical_url", canonical_url)

        # Step 2: Fetch OpenGraph SSR metadata using Social Preview Crawler User-Agent (WhatsApp/2.23.20.0)
        if not title:
            target_urls_to_probe = [url]
            if shop_id and item_id:
                bare_url = f"https://shopee.co.th/product/{shop_id}/{item_id}"
                if bare_url not in target_urls_to_probe:
                    target_urls_to_probe.append(bare_url)

            for probe_url in target_urls_to_probe:
                for crawler_ua in ["WhatsApp/2.23.20.0", "Twitterbot/1.0", "TelegramBot (like TwitterBot)"]:
                    try:
                        client.cookies.clear()
                        r_og = await client.get(
                            probe_url,
                            headers={"User-Agent": crawler_ua},
                            follow_redirects=True,
                        )
                        if r_og.status_code == 200 and ("og:title" in r_og.text or "<title>" in r_og.text):
                            og_title = _extract_meta(r_og.text, "og:title") or _extract_meta(r_og.text, "twitter:title")
                            if not og_title:
                                m_t = re.search(r'<title>(.*?)</title>', r_og.text, re.I | re.S)
                                if m_t:
                                    og_title = html.unescape(m_t.group(1)).strip()
                            og_title = _clean_shopee_title(og_title)

                            og_desc = _extract_meta(r_og.text, "og:description") or _extract_meta(r_og.text, "description")
                            og_img = _extract_meta(r_og.text, "og:image") or _extract_meta(r_og.text, "og:square_image")
                            og_url = _extract_meta(r_og.text, "og:url")

                            if og_url and "-i." in og_url:
                                canonical_url = og_url
                                s_id, i_id, s_slug = parse_shop_and_item_id(og_url)
                                shop_id = shop_id or s_id
                                item_id = item_id or i_id
                                slug_title = slug_title or s_slug

                            if og_title:
                                title = og_title
                                description = og_desc
                                image = og_img
                                _PRODUCT_MEM_CACHE[cache_key] = {
                                    "title": title,
                                    "description": description,
                                    "image": image,
                                    "canonical_url": canonical_url,
                                }
                                break
                    except Exception:
                        continue
                if title:
                    break

    # Step 3: Fallbacks if title wasn't in OG tags (e.g. from URL slug or share text)
    if not title:
        if slug_title:
            title = slug_title
        elif share_prefix:
            title = re.sub(r'^ลองดู\s*|\s*ในราคา.*$', '', share_prefix).strip()

    if not title and custom_keyword:
        title = custom_keyword.strip()

    # Build Chinese search keywords & suggestions
    kw_info = await build_chinese_search_keywords(title=title, description=description, custom_keyword=custom_keyword)

    # Extract short bullet highlights from attributes + description
    desc_highlights: List[str] = list(attributes[:3])
    if categories:
        desc_highlights.insert(0, f"หมวดหมู่: {' > '.join(categories[-2:])}")
    if description and len(desc_highlights) < 4:
        for line in description.splitlines():
            clean_line = line.strip(" \t\r\n☆✨🌼💕📣👉•-")
            if 4 <= len(clean_line) <= 90 and any(
                k in clean_line for k in ("ชื่อสินค้า", "วัสดุ", "สไตล์", "สี", "ขนาด", "รุ่น", "ความจุ", "กำลังไฟ", "บรรจุภัณฑ์", "เพศ")
            ):
                desc_highlights.append(clean_line)
                if len(desc_highlights) >= 4:
                    break

    expired_channels = [c for c in list_channels() if c.get("status") != "ok"]

    return {
        "input_url": url,
        "canonical_url": canonical_url,
        "link_type": link_type,
        "extraction_method": extraction_method,
        "shop_id": shop_id or "",
        "item_id": item_id or "",
        "shop_name": shop_name,
        "price": price,
        "title": title or "ไม่พบชื่อสินค้า (กรุณาระบุคำค้นหาสินค้าด้านล่าง)",
        "description": description or "",
        "description_highlights": desc_highlights,
        "image": image or "",
        "thai_keyword": kw_info["thai_keyword"],
        "zh_keyword": kw_info["zh_keyword"],
        "translated_title_zh": kw_info["translated_title_zh"],
        "suggested_keywords": kw_info["suggested_keywords"],
        "expired_channels": expired_channels,
    }
