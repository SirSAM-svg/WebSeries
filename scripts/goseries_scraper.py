#!/usr/bin/env python3
"""
GoSeries4K + Torbo007 Full-Catalog Harvester, Database & Token Manager
Implements all specifications from manual.txt:
- Harvests ALL 3,423+ series/movies across all 35 pages of WordPress REST API
  (https://goseries4k.com/wp-json/wp/v2/posts?per_page=100&page=1..35)
- Extracts episode md5 hashes & audio tracks (พากย์ไทย / ซับไทย) from post HTML (window.miru_ep_cache & iframe data-src)
- Fetches stream metadata (/api/v2/stream/<md5>) and tokens (/api/tokenplay) from torbo007.com
- Populates SQLite tables (movies, episodes, watch_history, favorites) in data/cache.db
- Merges all 3,423+ GoSeries4K catalog items with 856+ RongYok dramas into data/seed_data.json (4,270+ total!)
"""

import concurrent.futures
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(ROOT_DIR, "data")
POSTERS_DIR = os.path.join(ROOT_DIR, "static", "posters")
DB_PATH = os.path.join(DATA_DIR, "cache.db")
SEED_PATH = os.path.join(DATA_DIR, "seed_data.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(POSTERS_DIR, exist_ok=True)

GOSERIES_BASE = "https://goseries4k.com"
TORBO_BASE = "https://torbo007.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

GOSERIES_HEADERS = {
    "Accept": "*/*",
    "Referer": "https://goseries4k.com/",
    "User-Agent": USER_AGENT,
}

# Category ID map from https://goseries4k.com/wp-json/wp/v2/categories?per_page=100
GOSERIES_CATEGORY_MAP = {
    249: "ซีรี่ย์จีน",
    273: "ซีรี่ย์จีน",
    253: "ซีรี่ย์เกาหลี",
    260: "ซีรี่ย์ญี่ปุ่น",
    278: "ซีรี่ย์ฝรั่ง",
    303: "ซีรี่ย์ฝรั่ง",
    289: "ซีรี่ย์วาย",
    295: "อนิเมะ",
    287: "อนิเมะ",
    296: "อนิเมะ",
    286: "อนิเมะ",
    318: "มินิซีรี่ย์",
    300: "ซีรี่ย์ใหม่",
    315: "ซีรี่ย์ 2026",
    276: "ซีรี่ย์ 2025",
}


def get_torbo_headers(md5: str, is_json_post: bool = False) -> dict:
    headers = {
        "Referer": f"https://torbo007.com/embed/{md5}",
        "Origin": "https://torbo007.com",
        "User-Agent": USER_AGENT,
    }
    if is_json_post:
        headers["Content-Type"] = "application/json"
        headers["X-Requested-With"] = "XMLHttpRequest"
    return headers


def init_goseries_db(db_path: str = DB_PATH):
    """Creates the 4 tables defined in manual.txt Section 8."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS movies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            md5 TEXT UNIQUE NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            post_id INTEGER,
            title TEXT NOT NULL,
            description TEXT,
            poster_url TEXT,
            backdrop_url TEXT,
            year INTEGER,
            genres TEXT,
            tags TEXT,
            rating REAL,
            player_type TEXT,
            logo_url TEXT,
            vast_url TEXT,
            primary_color TEXT DEFAULT '#ff0000',
            stream_id TEXT,
            token TEXT,
            token_expires INTEGER,
            sid TEXT,
            token_updated_at INTEGER,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            movie_id INTEGER NOT NULL,
            season INTEGER DEFAULT 1,
            episode INTEGER NOT NULL,
            lang TEXT DEFAULT 'พากย์ไทย',
            md5 TEXT UNIQUE NOT NULL,
            title TEXT,
            stream_id TEXT,
            token TEXT,
            token_expires INTEGER,
            sid TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            movie_id INTEGER,
            drama_id TEXT,
            episode INTEGER DEFAULT 1,
            position_seconds INTEGER DEFAULT 0,
            duration_seconds INTEGER DEFAULT 0,
            watched_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS favorites (
            movie_id INTEGER PRIMARY KEY,
            drama_id TEXT UNIQUE,
            added_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
        )
        """
    )
    conn.commit()
    conn.close()


def make_safe_url(url: str) -> str:
    if not url:
        return ""
    parsed = urllib.parse.urlsplit(url)
    raw_path = urllib.parse.unquote(parsed.path)
    clean_path = urllib.parse.quote(raw_path, safe="/")
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, clean_path, parsed.query, parsed.fragment)
    )


def download_poster(url: str, slug_or_id: str) -> str:
    """Downloads GoSeries4K poster to static/posters/gs-<id>.<ext> and returns relative URL."""
    if not url:
        return ""
    ext = ".png" if url.lower().endswith(".png") else (".webp" if url.lower().endswith(".webp") else ".jpg")
    rel_path = f"static/posters/gs-{slug_or_id}{ext}"
    abs_path = os.path.join(ROOT_DIR, rel_path.replace("/", os.sep))
    if os.path.exists(abs_path) and os.path.getsize(abs_path) > 500:
        return f"/{rel_path}"
    try:
        safe_url = make_safe_url(url)
        req = urllib.request.Request(safe_url, headers=GOSERIES_HEADERS)
        with urllib.request.urlopen(req, timeout=12) as resp:
            content = resp.read()
            if len(content) > 500 and not content.startswith(b"<!DOCTYPE"):
                with open(abs_path, "wb") as f:
                    f.write(content)
                return f"/{rel_path}"
    except Exception:
        pass
    return url


def fetch_torbo_metadata(md5: str) -> dict:
    """GET https://torbo007.com/api/v2/stream/<md5>?parent=goseries4k.com&_=<timestamp>"""
    if not md5:
        return {}
    ts = int(time.time() * 1000)
    url = f"{TORBO_BASE}/api/v2/stream/{md5}?parent=goseries4k.com&_={ts}"
    try:
        req = urllib.request.Request(url, headers=get_torbo_headers(md5))
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return {}


def request_torbo_token(md5: str) -> dict:
    """
    POST https://torbo007.com/api/tokenplay
    Body: {"md5": md5, "parent": "goseries4k.com"}
    Returns: {"stream_id": ..., "token": ..., "expires": ..., "sid": ...}
    """
    if not md5:
        return {}
    url = f"{TORBO_BASE}/api/tokenplay"
    payload = json.dumps({"md5": md5, "parent": "goseries4k.com"}).encode("utf-8")
    try:
        req = urllib.request.Request(
            url,
            data=payload,
            headers=get_torbo_headers(md5, is_json_post=True),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            sid = data.get("sid") or data.get("session_id") or ""
            return {
                "stream_id": data.get("stream_id") or "",
                "token": data.get("token") or "",
                "expires": int(data.get("expires") or 0),
                "sid": sid,
                "error": data.get("error"),
            }
    except Exception as e:
        return {"error": str(e)}


def scrape_goseries_post_html(slug: str) -> dict:
    """
    Fetches https://goseries4k.com/<slug>/ and extracts:
    - primary md5
    - all episode md5s grouped by language ('พากย์ไทย', 'ซับไทย')
    - full synopsis from .-boxdetail or meta description
    """
    clean_s = urllib.parse.unquote(slug.strip("/"))
    url = f"{GOSERIES_BASE}/{urllib.parse.quote(clean_s)}/"
    result = {
        "md5": "",
        "synopsis": "",
        "episodes": [],
        "audio_tracks": [],
    }
    try:
        req = urllib.request.Request(url, headers=GOSERIES_HEADERS)
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # 1. Extract synopsis
        box_m = re.search(r'<div class="-boxdetail">\s*<p>(.*?)</p>', html, re.DOTALL)
        if box_m:
            syn = re.sub(r"<[^>]+>", " ", html_lib.unescape(box_m.group(1)))
            result["synopsis"] = re.sub(r"\s+", " ", syn).strip()
        if not result["synopsis"]:
            meta_m = re.search(
                r'<meta\s+name="description"\s+content="([^"]+)"', html, re.IGNORECASE
            )
            if meta_m:
                syn = html_lib.unescape(meta_m.group(1))
                result["synopsis"] = re.sub(r"\s+", " ", syn).strip()

        # 2. Extract window.miru_ep_cache mapping: ep_btn_id -> md5
        ep_id_to_md5 = {}
        cache_m = re.search(r"window\.miru_ep_cache\s*=\s*(\{.*?\});", html, re.DOTALL)
        if cache_m:
            try:
                raw_map = json.loads(cache_m.group(1))
                for btn_id, iframe_html in raw_map.items():
                    md5_m = re.search(r"torbo007\.com/embed/([a-f0-9]{32})", iframe_html)
                    if md5_m:
                        ep_id_to_md5[str(btn_id)] = md5_m.group(1)
            except Exception:
                pass

        # 3. Extract episode groups (<div class="mp-epg-title">พากย์ไทย</div>...)
        groups = re.findall(
            r'<div class="mp-epg-title">([^<]+)</div><div class="mp-epg-list">(.*?)</div></div>',
            html,
            re.DOTALL,
        )
        episodes_list = []
        audio_tracks = []
        for g_title, g_html in groups:
            lang_label = g_title.strip()
            if "พากย์" in lang_label:
                lang_norm = "พากย์ไทย"
            elif "ซับ" in lang_label or "บรรยาย" in lang_label:
                lang_norm = "ซับไทย"
            else:
                lang_norm = lang_label or "พากย์ไทย"

            if lang_norm not in audio_tracks:
                audio_tracks.append(lang_norm)

            btns = re.findall(r'data-id="(\d+)"[^>]*>(.*?)</button>', g_html, re.DOTALL)
            for idx, (btn_id, btn_text) in enumerate(btns, start=1):
                clean_label = re.sub(r"<[^>]+>", "", btn_text).strip()
                num_m = re.search(r"(\d+)", clean_label)
                ep_num = int(num_m.group(1)) if num_m else idx
                ep_md5 = ep_id_to_md5.get(str(btn_id), "")
                if ep_md5:
                    episodes_list.append(
                        {
                            "episode": ep_num,
                            "lang": lang_norm,
                            "title": clean_label or f"EP {ep_num}",
                            "md5": ep_md5,
                        }
                    )

        # 4. Fallback: if no groups matched, extract all torbo007 embed md5s directly
        if not episodes_list:
            all_md5s = list(
                dict.fromkeys(re.findall(r"torbo007\.com\\?/embed\\?/([a-f0-9]{32})", html))
            )
            for idx, m_hash in enumerate(all_md5s, start=1):
                episodes_list.append(
                    {
                        "episode": idx,
                        "lang": "พากย์ไทย",
                        "title": f"EP {idx}",
                        "md5": m_hash,
                    }
                )
            if all_md5s:
                audio_tracks = ["พากย์ไทย"]

        result["episodes"] = episodes_list
        result["audio_tracks"] = audio_tracks
        if episodes_list:
            result["md5"] = episodes_list[0]["md5"]
    except Exception as e:
        print(f"[WARN] scrape_goseries_post_html({slug}) error: {e}")
    return result


def clean_goseries_title(raw_title: str) -> tuple[str, str, int, int]:
    """
    Cleans WordPress title like:
    'ดูซีรี่ย์ A Love Other Than Yours เมื่อหัวใจมีใครอีกคน (2026) พากย์ไทย EP.1-14 จบ G4'
    Returns (clean_title, english_title, year, inferred_episodes).
    """
    t = html_lib.unescape(raw_title or "").strip()
    year_m = re.search(r"\((20\d{2}|19\d{2})\)", t)
    year = int(year_m.group(1)) if year_m else 2026

    # Extract episode count from title if present (e.g. EP.1-24 or EP.16)
    ep_range_m = re.search(r"EP\.?\s*\d+\s*[-–]\s*(\d+)", t, re.IGNORECASE)
    if ep_range_m:
        inferred_eps = int(ep_range_m.group(1))
    else:
        ep_single_m = re.search(r"EP\.?\s*(\d+)", t, re.IGNORECASE)
        inferred_eps = int(ep_single_m.group(1)) if ep_single_m else 16

    # Remove prefix 'ดูซีรี่ย์', 'ดูหนัง', and trailing 'G4'
    t = re.sub(r"^(?:ดูซีรี่ย์ออนไลน์|ดูซีรี่ย์|ดูซีรีส์|ดูหนังออนไลน์|ดูหนัง)\s*", "", t)
    t = re.sub(r"\s*G4\s*$", "", t, flags=re.IGNORECASE).strip()

    # Extract English prefix if present
    eng_m = re.match(r"^([A-Za-z0-9\s:\-\'\",\.\!\?\&]+?)\s+(?=[\u0e00-\u0e7f\(])", t)
    eng_title = eng_m.group(1).strip() if eng_m else ""
    return t, eng_title, year, max(1, inferred_eps)


def fetch_wp_posts(page: int = 1, per_page: int = 100, search: str = "", embed: bool = False) -> list:
    """GET https://goseries4k.com/wp-json/wp/v2/posts?per_page=<N>&page=<page>"""
    params = {"per_page": per_page, "page": page}
    if embed:
        params["_embed"] = "1"
    if search:
        params["search"] = search
    url = f"{GOSERIES_BASE}/wp-json/wp/v2/posts?{urllib.parse.urlencode(params)}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=GOSERIES_HEADERS)
            with urllib.request.urlopen(req, timeout=25) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except Exception as e:
            if attempt == 2:
                print(f"[WARN] fetch_wp_posts(page={page}) failed: {e}")
            else:
                time.sleep(1.0)
    return []


def fetch_wp_total_pages(per_page: int = 100) -> tuple[int, int]:
    """Returns (total_posts, total_pages) from GoSeries4K WP REST API headers."""
    url = f"{GOSERIES_BASE}/wp-json/wp/v2/posts?per_page={per_page}&page=1"
    try:
        req = urllib.request.Request(url, headers=GOSERIES_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            total_posts = int(resp.headers.get("X-WP-Total") or 0)
            total_pages = int(resp.headers.get("X-WP-TotalPages") or 1)
            return total_posts, total_pages
    except Exception as e:
        print(f"[WARN] fetch_wp_total_pages failed: {e}")
        return 0, 1


def parse_wp_post_base(p: dict) -> dict:
    """
    Extracts full metadata from a WP REST post object (works both WITH and WITHOUT _embed
    by leveraging yoast_head_json, categories ID map, and class_list!).
    """
    post_id = int(p.get("id") or 0)
    slug = p.get("slug") or f"post-{post_id}"
    raw_title = (p.get("title") or {}).get("rendered") or slug
    clean_title, eng_title, year, inferred_eps = clean_goseries_title(raw_title)

    # Extract poster and description from yoast_head_json (fastest) or _embedded
    yoast = p.get("yoast_head_json") or {}
    remote_poster = ""
    og_images = yoast.get("og_image") or []
    if og_images and isinstance(og_images[0], dict):
        remote_poster = og_images[0].get("url") or ""

    if not remote_poster:
        embedded = p.get("_embedded") or {}
        media_list = embedded.get("wp:featuredmedia") or []
        if media_list and isinstance(media_list[0], dict):
            remote_poster = media_list[0].get("source_url") or ""

    excerpt_text = yoast.get("og_description") or yoast.get("description") or ""
    if not excerpt_text:
        raw_excerpt = (p.get("excerpt") or {}).get("rendered") or ""
        excerpt_text = re.sub(r"<[^>]+>", " ", html_lib.unescape(raw_excerpt))
    excerpt_text = re.sub(r"\s+", " ", html_lib.unescape(excerpt_text)).replace("[…]", "").strip()

    genres = ["ซีรีส์/หนัง 4K"]
    tags = []
    langs = []

    # Map from category IDs
    for cid in p.get("categories") or []:
        cname = GOSERIES_CATEGORY_MAP.get(cid)
        if cname and cname not in genres:
            genres.append(cname)

    # Also check class_list & _embedded terms if available
    class_str = " ".join(str(c) for c in (p.get("class_list") or []))
    if "พากย์ไทย" in clean_title or "พากย์ไทย" in class_str:
        langs.append("พากย์ไทย")
    if "ซับไทย" in clean_title or "ซับไทย" in class_str:
        langs.append("ซับไทย")

    embedded = p.get("_embedded") or {}
    for term_group in embedded.get("wp:term") or []:
        if not isinstance(term_group, list):
            continue
        for term in term_group:
            tax = term.get("taxonomy") or ""
            name = html_lib.unescape(term.get("name") or "").strip()
            if not name:
                continue
            if "พากย์ไทย" in name and "พากย์ไทย" not in langs:
                langs.append("พากย์ไทย")
            if "ซับไทย" in name and "ซับไทย" not in langs:
                langs.append("ซับไทย")
            if tax in ("category", "cat_category"):
                if any(k in name for k in ["เกาหลี", "จีน", "ญี่ปุ่น", "ฝรั่ง", "ไทย", "อนิเมะ", "หนัง"]):
                    if name not in genres:
                        genres.append(name)
            elif tax == "post_tag":
                tags.append(name)

    if not langs:
        langs.append("ซับไทย")

    for l_item in langs:
        if l_item not in genres:
            genres.append(l_item)

    return {
        "post_id": post_id,
        "slug": slug,
        "title": clean_title,
        "english_title": eng_title or f"GoSeries4K #{post_id}",
        "year": year,
        "inferred_episodes": inferred_eps,
        "remote_poster": remote_poster,
        "excerpt": excerpt_text,
        "genres": genres,
        "tags": tags,
        "langs": langs,
    }


def save_movie_to_db(movie_data: dict, db_path: str = DB_PATH) -> int:
    """Saves or updates a single movie and its episodes into SQLite movies & episodes tables."""
    init_goseries_db(db_path)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    now = int(time.time())

    md5 = movie_data.get("md5") or hashlib.md5(movie_data["slug"].encode()).hexdigest()
    slug = movie_data["slug"]
    post_id = movie_data.get("post_id") or 0
    title = movie_data["title"]
    description = movie_data.get("synopsis") or movie_data.get("excerpt") or ""
    poster_url = movie_data.get("cover") or movie_data.get("remote_poster") or ""
    backdrop_url = movie_data.get("remote_poster") or poster_url
    year = movie_data.get("year") or 2026
    genres_json = json.dumps(movie_data.get("genres") or [], ensure_ascii=False)
    tags_json = json.dumps(movie_data.get("tags") or [], ensure_ascii=False)
    rating = float(movie_data.get("rating") or 9.6)
    player_type = movie_data.get("player_type") or "hls"
    logo_url = movie_data.get("logo_url") or ""
    vast_url = movie_data.get("vast_url") or ""
    primary_color = movie_data.get("primary_color") or "#ff6600"
    stream_id = movie_data.get("stream_id") or ""
    token = movie_data.get("token") or ""
    token_expires = int(movie_data.get("token_expires") or 0)
    sid = movie_data.get("sid") or ""
    token_updated_at = now if token else 0

    cur.execute(
        """
        INSERT INTO movies (
            md5, slug, post_id, title, description, poster_url, backdrop_url,
            year, genres, tags, rating, player_type, logo_url, vast_url,
            primary_color, stream_id, token, token_expires, sid, token_updated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            md5=CASE WHEN excluded.md5 != '' THEN excluded.md5 ELSE movies.md5 END,
            post_id=excluded.post_id,
            title=excluded.title,
            description=CASE WHEN excluded.description != '' THEN excluded.description ELSE movies.description END,
            poster_url=CASE WHEN excluded.poster_url != '' THEN excluded.poster_url ELSE movies.poster_url END,
            backdrop_url=CASE WHEN excluded.backdrop_url != '' THEN excluded.backdrop_url ELSE movies.backdrop_url END,
            year=excluded.year,
            genres=excluded.genres,
            tags=excluded.tags,
            player_type=excluded.player_type,
            primary_color=excluded.primary_color,
            stream_id=CASE WHEN excluded.stream_id != '' THEN excluded.stream_id ELSE movies.stream_id END,
            token=CASE WHEN excluded.token != '' THEN excluded.token ELSE movies.token END,
            token_expires=CASE WHEN excluded.token_expires > 0 THEN excluded.token_expires ELSE movies.token_expires END,
            sid=CASE WHEN excluded.sid != '' THEN excluded.sid ELSE movies.sid END,
            updated_at=excluded.updated_at
        """,
        (
            md5,
            slug,
            post_id,
            title,
            description,
            poster_url,
            backdrop_url,
            year,
            genres_json,
            tags_json,
            rating,
            player_type,
            logo_url,
            vast_url,
            primary_color,
            stream_id,
            token,
            token_expires,
            sid,
            token_updated_at,
            now,
        ),
    )

    cur.execute("SELECT id FROM movies WHERE slug = ?", (slug,))
    row = cur.fetchone()
    movie_id = row[0] if row else 0

    episodes = movie_data.get("episodes_list") or []
    if movie_id and episodes:
        for ep in episodes:
            ep_md5 = ep.get("md5")
            if not ep_md5:
                continue
            cur.execute(
                """
                INSERT INTO episodes (movie_id, season, episode, lang, md5, title)
                VALUES (?, 1, ?, ?, ?, ?)
                ON CONFLICT(md5) DO UPDATE SET
                    movie_id=excluded.movie_id,
                    episode=excluded.episode,
                    lang=excluded.lang,
                    title=excluded.title
                """,
                (
                    movie_id,
                    int(ep.get("episode") or 1),
                    ep.get("lang") or "พากย์ไทย",
                    ep_md5,
                    ep.get("title") or f"EP {ep.get('episode', 1)}",
                ),
            )

    conn.commit()
    conn.close()
    return movie_id


def refresh_expiring_tokens(db_path: str = DB_PATH, margin_seconds: int = 1800) -> int:
    """
    Token Refresher Background Job (manual.txt Section 4 & 9):
    SELECT * FROM movies WHERE token_expires < NOW + 1800
    Requests new token from torbo007.com/api/tokenplay and updates DB.
    """
    init_goseries_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    now = int(time.time())
    threshold = now + margin_seconds

    cur.execute(
        "SELECT id, slug, md5 FROM movies WHERE md5 != '' AND token IS NOT NULL AND token != '' AND token_expires < ? LIMIT 25",
        (threshold,),
    )
    rows = cur.fetchall()
    refreshed = 0
    for r in rows:
        md5 = r["md5"]
        if not re.fullmatch(r"[a-f0-9]{32}", md5):
            continue
        tok = request_torbo_token(md5)
        if tok.get("token") and tok.get("stream_id"):
            cur.execute(
                """
                UPDATE movies
                SET stream_id = ?, token = ?, token_expires = ?, sid = ?, token_updated_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    tok["stream_id"],
                    tok["token"],
                    tok["expires"],
                    tok["sid"],
                    now,
                    now,
                    r["id"],
                ),
            )
            refreshed += 1
            time.sleep(0.3)

    conn.commit()
    conn.close()
    return refreshed


def harvest_all_goseries_catalog(max_pages: int = 0, deep_html_scrape_count: int = 60) -> dict:
    """
    Harvests ALL pages (35 pages = 3,423+ series/movies) from GoSeries4K WP REST API
    into SQLite (`movies` table in data/cache.db) AND `data/seed_data.json`!
    Also preserves any already-scraped episode maps and pre-scrapes HTML for the newest `deep_html_scrape_count` titles.
    Any remaining title resolves its episode md5s on-demand in <0.4s when clicked!
    """
    t0 = time.time()
    print("=" * 70)
    print("GoSeries4K FULL CATALOG HARVESTER (ALL 3,423+ SERIES & MOVIES)")
    print("=" * 70)

    init_goseries_db(DB_PATH)

    # Load existing seed_data.json FIRST to preserve already-scraped episodes_map, md5, local covers, and RongYok catalog
    existing_gs_map = {}
    existing_rongyok = []
    if os.path.exists(SEED_PATH):
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as f:
                old_seed = json.load(f)
                for d in old_seed.get("dramas") or []:
                    if not isinstance(d, dict):
                        continue
                    if d.get("provider") == "goseries4k" or str(d.get("id", "")).startswith("gs-"):
                        slug_key = d.get("slug") or str(d.get("id", ""))[3:]
                        if slug_key:
                            existing_gs_map[slug_key] = d
                    else:
                        existing_rongyok.append(d)
        except Exception as e:
            print(f"[WARN] Failed reading existing seed_data.json: {e}")

    total_posts, total_pages = fetch_wp_total_pages(per_page=100)
    # Self-healing full catalog check: if we have fewer than 3,000 GoSeries4K titles in seed_data.json,
    # always fetch all 35 pages so the full 3,423+ catalog is guaranteed!
    if max_pages and max_pages > 0 and len(existing_gs_map) >= 3000:
        pages_to_fetch = min(total_pages, max_pages)
    else:
        pages_to_fetch = total_pages

    print(f"Detected {total_posts} total posts across {total_pages} pages on GoSeries4K (existing cached: {len(existing_gs_map)}).")
    print(f"Harvesting {pages_to_fetch} pages (100 posts/page) concurrently...")

    all_raw_posts = []
    page_numbers = list(range(1, pages_to_fetch + 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        page_results = list(pool.map(lambda p: fetch_wp_posts(page=p, per_page=100, embed=False), page_numbers))

    for p_idx, plist in enumerate(page_results, start=1):
        if plist:
            all_raw_posts.extend(plist)
            print(f"  [Page {p_idx:02d}/{pages_to_fetch:02d}] Fetched {len(plist)} series/movies (Total so far: {len(all_raw_posts)})")

    base_items = [parse_wp_post_base(p) for p in all_raw_posts]
    print(f"Parsed {len(base_items)} GoSeries4K series/movies in {time.time() - t0:.1f}s.")

    # Check EVERY movie/series in base_items across all 35 pages for:
    # 1. Brand new releases (`not ex`)
    # 2. Ongoing series that got new episodes (`item["inferred_episodes"] > (ex.get("episodes") or 0)`)
    # 3. Uncached newest series up to `deep_html_scrape_count`
    to_scrape_slugs = []
    new_gs_added = 0
    updated_gs_episodes = 0
    for idx, item in enumerate(base_items):
        s = item["slug"]
        ex = existing_gs_map.get(s)
        if not ex:
            new_gs_added += 1
            if len(to_scrape_slugs) < deep_html_scrape_count:
                to_scrape_slugs.append(s)
        elif item["inferred_episodes"] > (ex.get("episodes") or 0):
            updated_gs_episodes += 1
            if len(to_scrape_slugs) < deep_html_scrape_count * 2:
                to_scrape_slugs.append(s)
        elif not ex.get("episodes_map") and idx < deep_html_scrape_count and len(to_scrape_slugs) < deep_html_scrape_count:
            to_scrape_slugs.append(s)

    html_results = {}
    if to_scrape_slugs:
        print(f"Pre-scraping episode md5s for {len(to_scrape_slugs)} new/updated titles...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            html_results = dict(zip(to_scrape_slugs, pool.map(scrape_goseries_post_html, to_scrape_slugs)))

    # Batch-save all 3,423+ series into SQLite `movies` table & build catalog entries
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    now = int(time.time())

    catalog_entries = []
    seen_slugs = set()

    for idx, item in enumerate(base_items):
        slug = item["slug"]
        if slug in seen_slugs:
            continue
        seen_slugs.add(slug)

        post_id = item["post_id"]
        ex = existing_gs_map.get(slug) or {}
        hdata = html_results.get(slug) or {}

        episodes_list = hdata.get("episodes") or ex.get("episodes_map") or []
        md5 = hdata.get("md5") or ex.get("md5") or hashlib.md5(slug.encode()).hexdigest()
        synopsis = hdata.get("synopsis") or ex.get("synopsis") or item["excerpt"] or f"รับชม {item['title']} คมชัดระดับ 4K HD"

        # Check if local poster already exists on disk, otherwise use remote_poster URL directly
        local_cover = ex.get("cover") or ""
        if idx < 60 and item["remote_poster"]:
            local_cover = download_poster(item["remote_poster"], str(post_id))
        elif not local_cover:
            local_cover = item["remote_poster"]

        audio_tracks = hdata.get("audio_tracks") or ex.get("audio_tracks") or item["langs"] or ["ซับไทย"]
        if episodes_list:
            ep_numbers = [ep["episode"] for ep in episodes_list]
            max_ep = max(ep_numbers) if ep_numbers else item["inferred_episodes"]
        else:
            max_ep = ex.get("episodes") or item["inferred_episodes"] or 16

        lang_str = " + ".join(audio_tracks)
        for tr in audio_tracks:
            if tr not in item["genres"]:
                item["genres"].append(tr)

        genres_json = json.dumps(item["genres"], ensure_ascii=False)
        tags_json = json.dumps(item["tags"], ensure_ascii=False)

        cur.execute(
            """
            INSERT INTO movies (
                md5, slug, post_id, title, description, poster_url, backdrop_url,
                year, genres, tags, rating, player_type, primary_color, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9.7, 'hls', '#ff6600', ?)
            ON CONFLICT(slug) DO UPDATE SET
                post_id=excluded.post_id,
                title=excluded.title,
                description=CASE WHEN excluded.description != '' THEN excluded.description ELSE movies.description END,
                poster_url=CASE WHEN excluded.poster_url != '' THEN excluded.poster_url ELSE movies.poster_url END,
                backdrop_url=CASE WHEN excluded.backdrop_url != '' THEN excluded.backdrop_url ELSE movies.backdrop_url END,
                year=excluded.year,
                genres=excluded.genres,
                updated_at=excluded.updated_at
            """,
            (
                md5,
                slug,
                post_id,
                item["title"],
                synopsis,
                local_cover,
                item["remote_poster"] or local_cover,
                item["year"],
                genres_json,
                tags_json,
                now,
            ),
        )

        if episodes_list:
            cur.execute("SELECT id FROM movies WHERE slug = ?", (slug,))
            m_row = cur.fetchone()
            if m_row:
                m_id = m_row[0]
                for ep in episodes_list:
                    ep_md5 = ep.get("md5")
                    if ep_md5:
                        cur.execute(
                            """
                            INSERT INTO episodes (movie_id, season, episode, lang, md5, title)
                            VALUES (?, 1, ?, ?, ?, ?)
                            ON CONFLICT(md5) DO UPDATE SET
                                movie_id=excluded.movie_id,
                                episode=excluded.episode,
                                lang=excluded.lang,
                                title=excluded.title
                            """,
                            (
                                m_id,
                                int(ep.get("episode") or 1),
                                ep.get("lang") or "พากย์ไทย",
                                ep_md5,
                                ep.get("title") or f"EP {ep.get('episode', 1)}",
                            ),
                        )

        catalog_entry = {
            "id": f"gs-{slug}",
            "slug": slug,
            "post_id": post_id,
            "series_id": post_id,
            "md5": md5 if episodes_list else "",
            "provider": "goseries4k",
            "aspect_ratio": "16:9",
            "title": item["title"],
            "english_title": item["english_title"],
            "cover": local_cover,
            "remote_cover": item["remote_poster"],
            "genre": item["genres"],
            "rating": 9.7,
            "episodes": max_ep,
            "views": "4K HD",
            "language": lang_str,
            "audio_tracks": audio_tracks,
            "synopsis": synopsis,
            "status": "ครบทุกตอน",
            "release_year": item["year"],
        }
        if episodes_list:
            catalog_entry["episodes_map"] = episodes_list
        catalog_entries.append(catalog_entry)

    conn.commit()
    conn.close()

    # Preserve any previously harvested GoSeries4K titles not in the current batch
    for old_slug, old_entry in existing_gs_map.items():
        if old_slug not in seen_slugs:
            catalog_entries.append(old_entry)
            seen_slugs.add(old_slug)

    merged_dramas = catalog_entries + existing_rongyok
    gs_count = len(catalog_entries)
    ry_count = len(existing_rongyok)

    seed = {
        "providers": [
            {"id": "all", "name": f"ทั้งหมด ({len(merged_dramas)} เรื่อง)"},
            {"id": "goseries4k", "name": f"ซีรีส์/หนัง 4K ({gs_count} เรื่อง)"},
            {"id": "rongyok", "name": f"หนังสั้นจีน ({ry_count} เรื่อง)"},
        ],
        "genres": [
            "ทั้งหมด",
            "ซีรี่ย์เกาหลี",
            "ซีรี่ย์จีน",
            "ซีรี่ย์ญี่ปุ่น",
            "ซีรี่ย์ฝรั่ง",
            "อนิเมะ",
            "ประธานบริษัท (CEO)",
            "แก้แค้น (Revenge)",
            "รักโรแมนติก (Romance)",
            "แฟนตาซี (Fantasy)",
            "ย้อนเวลา / กำเนิดใหม่ (Rebirth)",
            "ตระกูลไฮโซ (Billionaire)",
        ],
        "featured": merged_dramas[0] if merged_dramas else {},
        "dramas": merged_dramas,
    }

    tmp_seed_path = SEED_PATH + ".gs.tmp"
    with open(tmp_seed_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_seed_path, SEED_PATH)

    elapsed = time.time() - t0
    print(
        f"\n[SUCCESS] Harvested {gs_count} GoSeries4K titles (+{new_gs_added} new, {updated_gs_episodes} ep-updates) "
        f"+ {ry_count} RongYok titles = {len(merged_dramas)} TOTAL series/movies into SQLite & seed_data.json in {elapsed:.1f}s!"
    )
    return {
        "scraped": gs_count,
        "added_new": new_gs_added,
        "updated_episodes": updated_gs_episodes,
        "goseries_total": gs_count,
        "rongyok_total": ry_count,
        "catalog_total": len(merged_dramas),
    }


def run_goseries_scrape(max_posts: int = 36, fetch_initial_tokens: int = 4) -> dict:
    """Auto-updater job: scans ALL 35 pages (3,423+ series/movies) for new titles & new episode updates."""
    return harvest_all_goseries_catalog(max_pages=0, deep_html_scrape_count=min(max_posts, 30))


if __name__ == "__main__":
    if "--all" in sys.argv or len(sys.argv) == 1:
        harvest_all_goseries_catalog(max_pages=0, deep_html_scrape_count=60)
    else:
        for arg in sys.argv[1:]:
            if arg.isdigit():
                pages = max(1, (int(arg) + 99) // 100)
                harvest_all_goseries_catalog(max_pages=pages, deep_html_scrape_count=min(int(arg), 60))
                break
