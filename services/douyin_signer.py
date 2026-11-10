"""
Pure-Python Douyin Signer (SM3 + A-Bogus + SecSDK WebSign) & Guest Cookie Minter.
Adapted from Evil0ctal/Douyin_TikTok_Download_API (Apache-2.0).
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import struct
import subprocess
import tempfile
import time
from dataclasses import dataclass
from operator import xor
from types import MappingProxyType
from typing import Any, Final, Iterable, Mapping, Sequence
from urllib.parse import quote, unquote

import httpx
import websockets

DEFAULT_UA: Final = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# 1. Pure-Python SM3 (GB/T 32905-2016)
# ---------------------------------------------------------------------------

_MASK = 0xFFFFFFFF
IV: tuple[int, ...] = (
    0x7380166F,
    0x4914B2B9,
    0x172442D7,
    0xDA8A0600,
    0xA96F30BC,
    0x163138AA,
    0xE38DEE4D,
    0xB0FB0E4E,
)
_T0 = 0x79CC4519
_T1 = 0x7A879D8A


def _rotl(value: int, bits: int) -> int:
    bits %= 32
    return ((value << bits) & _MASK) | (value >> (32 - bits))


def _ff(index: int, x: int, y: int, z: int) -> int:
    if index < 16:
        return x ^ y ^ z
    return (x & y) | (x & z) | (y & z)


def _gg(index: int, x: int, y: int, z: int) -> int:
    if index < 16:
        return x ^ y ^ z
    return (x & y) | ((~x & _MASK) & z)


def _expand(block: bytes) -> tuple[list[int], list[int]]:
    w = [*struct.unpack(">16I", block), *[0] * 52]
    mask = _MASK
    for j in range(16, 68):
        w3, w13 = w[j - 3], w[j - 13]
        x = w[j - 16] ^ w[j - 9] ^ (((w3 << 15) | (w3 >> 17)) & mask)
        p1 = x ^ (x << 15) ^ (x >> 17) ^ (x << 23) ^ (x >> 9)
        w[j] = (p1 ^ (w13 << 7) ^ (w13 >> 25) ^ w[j - 6]) & mask
    return w, list(map(xor, w[:64], w[4:]))


def _compress(state: tuple[int, ...], block: bytes) -> tuple[int, ...]:
    w, w1 = _expand(block)
    a, b, c, d, e, f, g, h = state
    for j in range(64):
        t = _T0 if j < 16 else _T1
        ss1 = _rotl((_rotl(a, 12) + e + _rotl(t, j)) & _MASK, 7)
        ss2 = ss1 ^ _rotl(a, 12)
        tt1 = (_ff(j, a, b, c) + d + ss2 + w1[j]) & _MASK
        tt2 = (_gg(j, e, f, g) + h + ss1 + w[j]) & _MASK
        d = c
        c = _rotl(b, 9)
        b = a
        a = tt1
        h = g
        g = _rotl(f, 19)
        f = e
        e = (tt2 ^ _rotl(tt2, 9) ^ _rotl(tt2, 17)) & _MASK
    return tuple((x ^ y) & _MASK for x, y in zip(state, (a, b, c, d, e, f, g, h), strict=True))


def _pad(message: bytes) -> bytes:
    bit_length = len(message) * 8
    padded = message + b"\x80"
    padded += b"\x00" * ((56 - len(padded) % 64) % 64)
    return padded + bit_length.to_bytes(8, "big")


def sm3_hash(message: bytes) -> bytes:
    state = IV
    padded = _pad(message)
    for offset in range(0, len(padded), 64):
        state = _compress(state, padded[offset : offset + 64])
    return b"".join(word.to_bytes(4, "big") for word in state)


def sm3_to_array(data: str | bytes | list[int]) -> list[int]:
    if isinstance(data, str):
        raw = data.encode("utf-8")
    elif isinstance(data, bytes):
        raw = data
    else:
        raw = bytes(data)
    return list(sm3_hash(raw))


# ---------------------------------------------------------------------------
# 2. Pure-Python A-Bogus (bdms v1.0.1.19-fix.01)
# ---------------------------------------------------------------------------

ALPHABETS: Final[Mapping[str, str]] = {
    "s3": "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
    "s4": "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
}
ABOGUS_SALT: Final = "dhzx"
HEADER_MAGIC: Final[tuple[int, int]] = (3, 82)
SDK_VERSION: Final[tuple[int, int, int, int]] = (1, 0, 1, 0)
PAYLOAD_KEY: Final = 0xD3
FORTNIGHT_EPOCH_MS: Final = 1_721_836_800_000
PAGE_ID: Final = 6241
AID: Final = 6383
NOISE_MASKS: Final[tuple[int, int, int]] = (0x91, 0x42, 0x2C)
DATA_MASKS: Final[tuple[int, int, int]] = (0x6E, 0xBD, 0xD3)

FIELD_ORDER: Final[tuple[str, ...]] = (
    "L34", "L44", "L56", "L61", "L73", "L29", "L70", "L45", "L35", "L49",
    "L38", "L66", "L51", "L68", "L28", "L48", "L64", "L47", "L30", "L71",
    "L26", "L55", "L31", "L69", "L59", "L40", "L62", "L63", "L27", "L72",
    "L41", "L74", "L57", "L52", "L42", "L39", "L33", "L67", "L53", "L43",
    "L65", "L46", "L36", "L24", "L60", "L32", "L79", "L80", "L84", "L85",
)
CANARIES: Final[tuple[tuple[int, int, int], ...]] = ((3, 11, 12), (4, 8, 9), (5, 12, 13))


@dataclass(frozen=True, slots=True)
class DigestChain:
    slots: tuple[str, str, str]
    indices: tuple[int, int]
    canary: tuple[int, int, int]


DIGEST_CHAINS: Final[Mapping[str, DigestChain]] = MappingProxyType(
    {
        "query": DigestChain(("L48", "L49", "L51"), (9, 18), CANARIES[0]),
        "body": DigestChain(("L52", "L53", "L55"), (10, 19), CANARIES[1]),
        "user_agent": DigestChain(("L56", "L57", "L59"), (11, 21), CANARIES[2]),
    }
)

ENV_FLAGS: Final = 1
DETECT_FLAGS: Final = 14
NR_FLAGS: Final = 0x21
NR_TAG: Final[tuple[int, int, int, int]] = (0, 0, 0, 0)
TRIPWIRE_LOCKED: Final = 3
CALL_BUCKET: Final = 6
DEFAULT_BROWSER_INFO: Final = "1920|947|1920|1032|1920|1032|1920|1080|Win32"

_HEADER_NOISE_BANDS: Final[Mapping[str, int]] = {
    "chrome": 0,
    "firefox": 40,
    "safari": 81,
    "edge": 125,
    "huawei": 170,
    "other": 210,
}
_TRIPWIRE_SET: Final = 0xB2
_TRIPWIRE_FREE: Final = 0x4D


def rc4(key: bytes, data: bytes) -> bytes:
    box = [0] * 256
    for i in range(256):
        box[255 - i] = i
    j = 0
    for i in range(256):
        j = (j * box[i] + j + key[i % len(key)]) % 256
        box[i], box[j] = box[j], box[i]

    out = bytearray(len(data))
    i = j = 0
    for index, byte in enumerate(data):
        i = (i + 1) % 256
        j = (j + box[i]) % 256
        box[i], box[j] = box[j], box[i]
        out[index] = byte ^ box[(box[i] + box[j]) % 256]
    return bytes(out)


def encode_base64(data: bytes, alphabet: str = "s4") -> str:
    table = ALPHABETS[alphabet]
    out: list[str] = []
    for offset in range(0, len(data), 3):
        chunk = data[offset : offset + 3]
        block = int.from_bytes(chunk + b"\x00" * (3 - len(chunk)), "big")
        digits = [(block >> shift) & 0x3F for shift in (18, 12, 6, 0)]
        out.extend(table[digit] for digit in digits[: len(chunk) + 1])
    out.append("=" * ((4 - len(out) % 4) % 4))
    return "".join(out)


def _family_of(user_agent: str) -> str:
    ua = user_agent.lower()
    for name in ("edg", "huawei", "firefox", "chrome", "safari"):
        if name in ua:
            return {"edg": "edge"}.get(name, name)
    return "other"


def _header_noise(user_agent: str, rng: random.Random) -> int:
    base = _HEADER_NOISE_BANDS.get(_family_of(user_agent), _HEADER_NOISE_BANDS["other"])
    return (base + int(rng.random() * 40)) & 0xFF


def _probe_noise(rng: random.Random) -> int:
    value = int(rng.random() * 240)
    return value + value % 2 + 1 if value > 109 else value


def _tripwire_noise(rng: random.Random) -> int:
    return (int(rng.random() * 255) & _TRIPWIRE_FREE) | _TRIPWIRE_SET


def _mask_pair(
    pair: tuple[int, int],
    rng: random.Random,
    *,
    low: int | None = None,
    high: int | None = None,
) -> list[int]:
    noise = int(rng.random() * 65535)
    low = noise & 0xFF if low is None else low & 0xFF
    high = (noise >> 8) & 0xFF if high is None else high & 0xFF
    return [
        (low & 0xAA) | (pair[0] & 0x55),
        (low & 0x55) | (pair[0] & 0xAA),
        (high & 0xAA) | (pair[1] & 0x55),
        (high & 0x55) | (pair[1] & 0xAA),
    ]


def _expand_noise(body: bytes, rng: random.Random) -> bytes:
    out = bytearray()
    for offset in range(0, len(body), 3):
        group = body[offset : offset + 3]
        if len(group) < 3:
            out.append(group[0])
            if len(group) > 1 and group[1]:
                out.append(group[1])
            continue
        noise = int(rng.random() * 1000) & 0xFF
        out.extend(
            (noise & mask) | (byte & data)
            for mask, data, byte in zip(NOISE_MASKS, DATA_MASKS, group, strict=True)
        )
        out.append(
            (group[0] & NOISE_MASKS[0]) | (group[1] & NOISE_MASKS[1]) | (group[2] & NOISE_MASKS[2])
        )
    return bytes(out)


def js_bytes(text: str) -> bytes:
    out = bytearray()
    units = text.encode("utf-16-le")
    for index in range(0, len(units), 2):
        code = units[index] | (units[index + 1] << 8)
        if code & 0xFF00:
            out.append(code >> 8)
        out.append(code & 0xFF)
    return bytes(out)


def _le_bytes(value: int, count: int) -> list[int]:
    return [(value >> (8 * index)) & 0xFF for index in range(count)]


def canary(digest: Sequence[int], offset: int, sentinel: int, fallback: int) -> int:
    for byte in digest[offset:]:
        if byte != sentinel:
            return byte
    return fallback


def digest_of(text: str) -> list[int]:
    return sm3_to_array(sm3_to_array(text + ABOGUS_SALT))


def user_agent_digest(user_agent: str) -> list[int]:
    key = bytes((ENV_FLAGS // 256, ENV_FLAGS % 256, DETECT_FLAGS % 256))
    sealed = rc4(key, bytes(byte & 0xFF for byte in js_bytes(user_agent.strip())))
    return sm3_to_array(encode_base64(sealed, "s3"))


def chain_bytes(chain: DigestChain, digest: Sequence[int]) -> tuple[int, int, int]:
    first, second = chain.indices
    return digest[first], digest[second], canary(digest, *chain.canary)


class ABogus:
    def __init__(
        self,
        user_agent: str = DEFAULT_UA,
        *,
        browser_info: str = DEFAULT_BROWSER_INFO,
        page_id: int = PAGE_ID,
        aid: int = AID,
        rng: random.Random | None = None,
    ) -> None:
        self.user_agent = user_agent
        self.browser_info = browser_info
        self.page_id = page_id
        self.aid = aid
        self._rng = rng or random.Random()

    def _fields(self, query: str, body: str, now_ms: int) -> dict[str, int]:
        digests = {
            "query": digest_of(query),
            "body": digest_of(body),
            "user_agent": user_agent_digest(self.user_agent),
        }
        ink = now_ms - 1
        fortnights = (now_ms - FORTNIGHT_EPOCH_MS) // (1000 * 60 * 60 * 24 * 14)
        info_bytes = js_bytes(self.browser_info)
        tail_bytes = js_bytes(f"{(now_ms + 3) & 0xFF},")

        fields: dict[str, int] = {
            "L24": 41,
            "L26": fortnights,
            "L27": CALL_BUCKET,
            "L28": 3,
            "L35": ENV_FLAGS & 0xFF,
            "L36": (ENV_FLAGS // 256) & 0xFF,
            "L38": NR_FLAGS & 0xFF,
            "L39": (NR_FLAGS >> 8) & 0xFF,
            "L66": TRIPWIRE_LOCKED,
            "L79": len(info_bytes) & 0xFF,
            "L80": (len(info_bytes) >> 8) & 0xFF,
            "L84": len(tail_bytes) & 0xFF,
            "L85": (len(tail_bytes) >> 8) & 0xFF,
        }
        for index, byte in enumerate(_le_bytes(now_ms, 6)):
            fields[f"L{29 + index}"] = byte
        for index, byte in enumerate(_le_bytes(DETECT_FLAGS, 4)):
            fields[f"L{44 + index}"] = byte
        for index, byte in enumerate(NR_TAG):
            fields[f"L{40 + index}"] = byte
        for index, byte in enumerate(_le_bytes(ink, 6)):
            fields[f"L{60 + index}"] = byte
        for index, byte in enumerate(_le_bytes(self.page_id, 4)):
            fields[f"L{67 + index}"] = byte
        for index, byte in enumerate(_le_bytes(self.aid, 4)):
            fields[f"L{71 + index}"] = byte
        for name, chain in DIGEST_CHAINS.items():
            written = chain_bytes(chain, digests[name])
            for slot, value in zip(chain.slots, written, strict=True):
                fields[slot] = value
        return fields

    def get_value(
        self,
        query: str,
        *,
        body: str = "",
        content_type: str = "",
        now_ms: int | None = None,
    ) -> str:
        if "multipart/form-data" in content_type.lower():
            body = ""
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        fields = self._fields(query, body, now)
        version = _mask_pair(SDK_VERSION[:2], self._rng) + _mask_pair(
            SDK_VERSION[2:],
            self._rng,
            low=_probe_noise(self._rng),
            high=_tripwire_noise(self._rng),
        )
        checksum = 0
        for byte in version:
            checksum ^= byte
        for name in FIELD_ORDER:
            checksum ^= fields[name]

        body_bytes = bytes(fields[name] for name in FIELD_ORDER)
        body_bytes += js_bytes(self.browser_info)
        body_bytes += js_bytes(f"{(now + 3) & 0xFF},")
        body_bytes += bytes((checksum,))

        header = bytes(
            _mask_pair(HEADER_MAGIC, self._rng, high=_header_noise(self.user_agent, self._rng))
        )
        frame = _expand_noise(body_bytes, self._rng)
        sealed = rc4(bytes((PAYLOAD_KEY,)), bytes(version) + frame)
        return encode_base64(header + sealed, "s4")


# ---------------------------------------------------------------------------
# 3. SecSDK WebSign (x-secsdk-web-signature)
# ---------------------------------------------------------------------------

WEBSIGN_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"
UIFID_COOKIE_NAMES: tuple[str, ...] = (
    "uifid",
    "uifid_temp",
    "uifidtemp",
    "UIFID",
    "UIFID_TEMP",
    "UIFIDTEMP",
)


def pick_uifid(cookies: Mapping[str, str] | None) -> str | None:
    for name in UIFID_COOKIE_NAMES:
        value = (cookies or {}).get(name)
        if value:
            return value
    return None


def encode_pairs(pairs: Iterable[tuple[str, str]]) -> str:
    return "&".join(f"{quote(k, safe='*-._')}={quote(v, safe='*-._')}" for k, v in pairs)


def sign_douyin_query(
    params: Mapping[str, str],
    cookies: Mapping[str, str],
    user_agent: str = DEFAULT_UA,
) -> tuple[str, dict[str, str]]:
    """
    Signs Douyin query parameters with both A-Bogus and x-secsdk-web-signature (if UIFID is present).
    Returns (signed_query_string, extra_headers).
    """
    query = "&".join(
        f"{quote(str(k), safe='*-._~')}={quote(str(v), safe='*-._~')}"
        for k, v in params.items()
    )
    ab = ABogus(user_agent).get_value(query)
    query_ab = f"{query}&a_bogus={quote(ab, safe='')}"

    uifid = pick_uifid(cookies)
    if not uifid:
        return query_ab, {}

    pairs = [
        (unquote(p.partition("=")[0]), unquote(p.partition("=")[2]))
        for p in query_ab.split("&")
        if p
    ]
    verify_fp = cookies.get("s_v_web_id", "")
    if verify_fp:
        pairs.append(("verifyFp", verify_fp))
        pairs.append(("fp", verify_fp))

    stamp = str(int(time.time()))
    if not any(name == "uifid" for name, _ in pairs):
        pairs.append(("uifid", uifid))
    pairs.append(("timestamp", stamp))

    serialized = encode_pairs(pairs)
    signature = hashlib.md5(f"{uifid}_{stamp}_{WEBSIGN_SALT}_{serialized}".encode()).hexdigest()
    headers = {
        "uifid": uifid,
        "x-secsdk-web-signature": signature,
        "x-secsdk-web-expire": stamp,
    }
    return f"{serialized}&x-secsdk-web-signature={signature}", headers


# ---------------------------------------------------------------------------
# 4. Automatic Guest Cookie Minter via Local Chrome / Edge Headless
# ---------------------------------------------------------------------------

def _find_browser_executable() -> str | None:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return shutil.which("chrome") or shutil.which("msedge")


async def mint_guest_douyin_cookies(user_agent: str = DEFAULT_UA) -> dict[str, str]:
    """
    Launches local headless Chrome/Edge for ~4 seconds to mint fresh guest Douyin cookies
    (UIFID_TEMP, s_v_web_id, ttwid, __ac_nonce) without requiring user login.
    """
    exe = _find_browser_executable()
    if not exe:
        return {}

    port = random.randint(19200, 19800)
    user_data = tempfile.mkdtemp(prefix="dy_mint_")
    proc = subprocess.Popen(
        [
            exe,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={user_data}",
            f"--user-agent={user_agent}",
            f"--remote-debugging-port={port}",
            "https://www.douyin.com/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        import asyncio
        for _ in range(12):
            await asyncio.sleep(0.5)
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(f"http://127.0.0.1:{port}/json")
                    pages = [t for t in r.json() if t.get("type") == "page"]
                    if pages:
                        ws_url = pages[0]["webSocketDebuggerUrl"]
                        async with websockets.connect(ws_url) as ws:
                            await ws.send(json.dumps({"id": 1, "method": "Network.getAllCookies"}))
                            resp = json.loads(await ws.recv())
                            cookies = {
                                c["name"]: c["value"]
                                for c in resp.get("result", {}).get("cookies", [])
                                if c.get("name")
                            }
                            if pick_uifid(cookies) and cookies.get("ttwid"):
                                return cookies
            except Exception:
                continue
        return {}
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        import asyncio
        await asyncio.sleep(0.4)
        shutil.rmtree(user_data, ignore_errors=True)
