import os
import re
import json
import time
import hashlib
import sqlite3
import urllib.parse
import httpx
from datetime import datetime, timezone
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.responses import JSONResponse, FileResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

from scripts.goseries_scraper import (
    GOSERIES_BASE,
    TORBO_BASE,
    USER_AGENT,
    GOSERIES_HEADERS,
    get_torbo_headers,
    init_goseries_db,
    request_torbo_token,
    fetch_torbo_metadata,
    scrape_goseries_post_html,
    save_movie_to_db,
    refresh_expiring_tokens,
    run_goseries_scrape,
    fetch_wp_posts,
    parse_wp_post_base,
    download_poster,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
POSTERS_DIR = os.path.join(STATIC_DIR, "posters")
DB_PATH = os.path.join(DATA_DIR, "cache.db")
SEED_PATH = os.path.join(DATA_DIR, "seed_data.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(POSTERS_DIR, exist_ok=True)

# RongYok scraping base
RONGYOK_BASE = "https://rongyok.com"
RONGYOK_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://rongyok.com/",
    "Accept": "text/html,application/json,*/*",
}

# ──────────────────────────────────────────────
# DATABASE & CACHE (RongYok + GoSeries4K + Torbo007)
# ──────────────────────────────────────────────

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS cache_store (
        cache_key TEXT PRIMARY KEY,
        category TEXT,
        data TEXT,
        created_at INTEGER,
        expires_at INTEGER
    )
    """)
    conn.commit()
    conn.close()
    # Initialize movies, episodes, watch_history, favorites tables from manual.txt Section 8
    init_goseries_db(DB_PATH)

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_cached(cache_key: str):
    conn = get_db()
    cur = conn.cursor()
    now = int(time.time())
    cur.execute("SELECT data FROM cache_store WHERE cache_key = ? AND expires_at > ?", (cache_key, now))
    row = cur.fetchone()
    conn.close()
    if row:
        return json.loads(row["data"])
    return None

def set_cached(cache_key: str, category: str, data, ttl_seconds: int):
    conn = get_db()
    cur = conn.cursor()
    now = int(time.time())
    expires_at = now + ttl_seconds
    cur.execute("""
        INSERT OR REPLACE INTO cache_store (cache_key, category, data, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
    """, (cache_key, category, json.dumps(data, ensure_ascii=False), now, expires_at))
    conn.commit()
    conn.close()

def get_seed_data():
    if os.path.exists(SEED_PATH):
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"providers": [], "genres": [], "featured": {}, "dramas": []}

# ──────────────────────────────────────────────
# GOSERIES4K & TORBO007 HELPERS
# ──────────────────────────────────────────────

def get_or_scrape_goseries_movie(slug: str) -> dict:
    """
    Looks up GoSeries4K movie/series by slug in SQLite (`movies` + `episodes`).
    If missing or has no episodes, scrapes https://goseries4k.com/<slug>/ on-demand!
    """
    clean_slug = slug[3:] if slug.startswith("gs-") else slug
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM movies WHERE slug = ?", (clean_slug,))
    movie_row = cur.fetchone()

    episodes_rows = []
    if movie_row:
        cur.execute(
            "SELECT episode, lang, md5, title, stream_id, token, token_expires, sid FROM episodes WHERE movie_id = ? ORDER BY episode ASC",
            (movie_row["id"],),
        )
        episodes_rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    now = int(time.time())
    is_ongoing = movie_row and ("ยังไม่จบ" in (movie_row["title"] or ""))
    cache_fresh = movie_row and ((now - int(movie_row["updated_at"] or 0)) < 1800)

    if movie_row and episodes_rows and (not is_ongoing or cache_fresh):
        m_dict = dict(movie_row)
        try:
            m_dict["genres"] = json.loads(m_dict.get("genres") or "[]")
        except Exception:
            m_dict["genres"] = []
        try:
            m_dict["tags"] = json.loads(m_dict.get("tags") or "[]")
        except Exception:
            m_dict["tags"] = []
        m_dict["episodes"] = episodes_rows
        audio_tracks = list(dict.fromkeys(ep.get("lang") or "พากย์ไทย" for ep in episodes_rows))
        m_dict["audio_tracks"] = audio_tracks
        return m_dict

    # Also check seed_data.json for base metadata before scraping HTML
    seed = get_seed_data()
    seed_item = None
    for d in seed.get("dramas", []):
        if d.get("slug") == clean_slug or d.get("id") == f"gs-{clean_slug}":
            seed_item = d
            break

    scraped = scrape_goseries_post_html(clean_slug)
    eps_list = scraped.get("episodes") or (seed_item.get("episodes_map") if seed_item else []) or []
    md5 = scraped.get("md5") or (seed_item.get("md5") if seed_item else "") or ""

    movie_record = {
        "slug": clean_slug,
        "post_id": (seed_item.get("post_id") if seed_item else 0) or 0,
        "md5": md5,
        "title": (seed_item.get("title") if seed_item else clean_slug.replace("-", " ").title()),
        "synopsis": scraped.get("synopsis") or (seed_item.get("synopsis") if seed_item else ""),
        "cover": (seed_item.get("cover") if seed_item else ""),
        "remote_poster": (seed_item.get("remote_cover") if seed_item else ""),
        "year": (seed_item.get("release_year") if seed_item else 2026),
        "genres": (seed_item.get("genre") if seed_item else ["ซีรีส์/หนัง 4K"]),
        "tags": [],
        "episodes_list": eps_list,
    }
    if md5 or eps_list:
        save_movie_to_db(movie_record, DB_PATH)

    audio_tracks = scraped.get("audio_tracks") or list(dict.fromkeys(ep.get("lang") or "พากย์ไทย" for ep in eps_list))
    return {
        **movie_record,
        "episodes": eps_list,
        "audio_tracks": audio_tracks,
    }

def ensure_valid_torbo_token(md5: str, slug: str = "") -> dict:
    """
    Checks if a valid torbo007 token exists for `md5` (expires > now + 300).
    If expired or missing, calls POST https://torbo007.com/api/tokenplay and updates DB + cache.
    """
    now = int(time.time())
    cache_key = f"torbo:token:{md5}"
    cached = get_cached(cache_key)
    if cached and cached.get("token") and cached.get("stream_id") and int(cached.get("expires") or 0) > now + 300:
        return cached

    # Check movies table if slug matches
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT stream_id, token, token_expires, sid FROM movies WHERE md5 = ? AND token IS NOT NULL AND token != '' AND token_expires > ?",
        (md5, now + 300),
    )
    row = cur.fetchone()
    conn.close()
    if row:
        tok_data = {
            "stream_id": row["stream_id"],
            "token": row["token"],
            "expires": row["token_expires"],
            "sid": row["sid"],
        }
        set_cached(cache_key, "torbo_token", tok_data, max(60, int(row["token_expires"]) - now - 120))
        return tok_data

    # Request new token from torbo007.com/api/tokenplay
    tok = request_torbo_token(md5)
    if tok.get("token") and tok.get("stream_id"):
        ttl = max(300, int(tok.get("expires") or (now + 7200)) - now - 120)
        set_cached(cache_key, "torbo_token", tok, ttl)
        # Update DB
        conn = get_db()
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE movies
            SET stream_id = ?, token = ?, token_expires = ?, sid = ?, token_updated_at = ?, updated_at = ?
            WHERE md5 = ? OR slug = ?
            """,
            (tok["stream_id"], tok["token"], tok["expires"], tok["sid"], now, now, md5, slug),
        )
        cur.execute(
            """
            UPDATE episodes
            SET stream_id = ?, token = ?, token_expires = ?, sid = ?
            WHERE md5 = ?
            """,
            (tok["stream_id"], tok["token"], tok["expires"], tok["sid"], md5),
        )
        conn.commit()
        conn.close()
    return tok

# ──────────────────────────────────────────────
# API ENDPOINTS (RONGYOK + GOSERIES4K + TORBO007)
# ──────────────────────────────────────────────

async def api_status(request):
    seed = get_seed_data()
    dramas = seed.get("dramas", [])
    total_dramas = len(dramas)
    gs_count = sum(1 for d in dramas if d.get("provider") == "goseries4k")
    ry_count = total_dramas - gs_count

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) as count FROM cache_store")
    cached_count = cur.fetchone()["count"]
    cur.execute("SELECT COUNT(*) as count FROM movies")
    db_movies_count = cur.fetchone()["count"]
    conn.close()

    return JSONResponse({
        "status": "online",
        "provider": "RongYok + GoSeries4K + Torbo007 HLS Engine (100% Free - Unlimited)",
        "total_dramas": total_dramas,
        "goseries4k_count": gs_count,
        "rongyok_count": ry_count,
        "db_movies": db_movies_count,
        "cached_entries": cached_count
    })

async def api_feed(request):
    """
    Returns home feed from the unified RongYok + GoSeries4K catalog.
    Supports filtering by provider (all / goseries4k / rongyok), genre, and audio (all / dubbed / subbed).
    """
    provider_filter = request.query_params.get("provider", "all")
    lang_filter = request.query_params.get("lang", "all")
    genre_filter = request.query_params.get("genre", "ทั้งหมด")
    page = int(request.query_params.get("page", 1))
    limit = int(request.query_params.get("limit", 48))

    seed = get_seed_data()
    dramas = seed.get("dramas", [])

    # Filter provider
    if provider_filter and provider_filter != "all":
        dramas = [d for d in dramas if (d.get("provider") or "rongyok") == provider_filter]

    # Filter language
    if lang_filter == "dubbed":
        dramas = [d for d in dramas if "พากย์ไทย" in d.get("language", "") or "พากย์ไทย" in d.get("genre", [])]
    elif lang_filter == "subbed":
        dramas = [d for d in dramas if "ซับไทย" in d.get("language", "") or "ซับไทย" in d.get("genre", [])]

    # Filter genre
    if genre_filter and genre_filter != "ทั้งหมด":
        dramas = [d for d in dramas if any(genre_filter.lower() in g.lower() for g in d.get("genre", []))]

    total_count = len(dramas)
    start_idx = (page - 1) * limit
    end_idx = start_idx + limit
    paginated_dramas = dramas[start_idx:end_idx]

    return JSONResponse({
        "status": True,
        "providers": seed.get("providers", []),
        "genres": seed.get("genres", []),
        "featured": seed.get("featured", {}),
        "dramas": paginated_dramas,
        "page": page,
        "limit": limit,
        "total": total_count,
        "has_more": end_idx < total_count
    })

async def api_movies_list(request):
    """
    manual.txt endpoint: GET /api/movies
    Returns GoSeries4K movies & series from SQLite `movies` table (with fallback to seed_data.json).
    """
    q = request.query_params.get("q", "").strip().lower()
    lang = request.query_params.get("lang", "all")
    page = int(request.query_params.get("page", 1))
    limit = int(request.query_params.get("limit", 48))

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM movies ORDER BY updated_at DESC, id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    items = []
    for r in rows:
        try:
            genres = json.loads(r.get("genres") or "[]")
        except Exception:
            genres = ["ซีรีส์/หนัง 4K"]
        try:
            tags = json.loads(r.get("tags") or "[]")
        except Exception:
            tags = []

        item = {
            "id": f"gs-{r['slug']}",
            "movie_id": r["id"],
            "slug": r["slug"],
            "post_id": r["post_id"],
            "md5": r["md5"],
            "provider": "goseries4k",
            "aspect_ratio": "16:9",
            "title": r["title"],
            "cover": r["poster_url"],
            "backdrop": r["backdrop_url"],
            "year": r["year"],
            "genre": genres,
            "tags": tags,
            "rating": r["rating"],
            "synopsis": r["description"],
            "player_type": r["player_type"],
            "primary_color": r["primary_color"],
        }
        if q:
            haystack = f"{item['title']} {item['slug']} {' '.join(genres)} {item['synopsis']}".lower()
            if q not in haystack:
                continue
        if lang == "dubbed" and "พากย์ไทย" not in genres and "พากย์ไทย" not in item["title"]:
            continue
        if lang == "subbed" and "ซับไทย" not in genres and "ซับไทย" not in item["title"]:
            continue
        items.append(item)

    total = len(items)
    start = (page - 1) * limit
    end = start + limit
    return JSONResponse({
        "status": True,
        "movies": items[start:end],
        "page": page,
        "limit": limit,
        "total": total,
        "has_more": end < total,
    })

async def api_movie_by_slug(request):
    """
    manual.txt endpoint: GET /api/movies/{slug}
    Returns full GoSeries4K movie details, episodes, and stream URLs.
    """
    slug = request.path_params.get("slug", "").strip()
    if not slug:
        return JSONResponse({"status": False, "error": "Missing slug"}, status_code=400)

    import asyncio
    loop = asyncio.get_running_loop()
    movie_data = await loop.run_in_executor(None, get_or_scrape_goseries_movie, slug)
    if not movie_data:
        return JSONResponse({"status": False, "error": "Movie not found"}, status_code=404)

    clean_slug = movie_data["slug"]
    return JSONResponse({
        "status": True,
        "movie": movie_data,
        "stream_m3u8": f"/stream/{clean_slug}/index.m3u8",
    })

async def stream_m3u8_proxy(request):
    """
    manual.txt endpoint: GET /stream/{slug}/index.m3u8
    1. Resolves target md5 (from ?md5=, or ?ep=&lang= in episodes table, or movie's primary md5).
    2. Checks if token is expired -> refreshes via POST https://torbo007.com/api/tokenplay.
    3. Fetches real M3U8 from https://torbo007.com/api/stream/<stream_id>/index.m3u8?...
    4. Rewrites segment URLs to point through /stream/{slug}/segment?url=<encoded>&md5=<md5>.
    5. Returns rewritten M3U8 playlist.
    """
    slug = request.path_params.get("slug", "").strip()
    clean_slug = slug[3:] if slug.startswith("gs-") else slug
    md5 = request.query_params.get("md5", "").strip()
    ep_param = request.query_params.get("ep", "").strip()
    lang_param = request.query_params.get("lang", "").strip()

    import asyncio
    loop = asyncio.get_running_loop()

    # Resolve md5 if not explicitly passed
    if not md5 or not re.fullmatch(r"[a-f0-9]{32}", md5):
        movie_data = await loop.run_in_executor(None, get_or_scrape_goseries_movie, clean_slug)
        eps = movie_data.get("episodes") or []
        target_ep = int(ep_param) if ep_param.isdigit() else 1

        # Match episode + language first
        matched_md5 = ""
        if lang_param:
            for e_item in eps:
                if int(e_item.get("episode") or 1) == target_ep and lang_param in (e_item.get("lang") or ""):
                    matched_md5 = e_item.get("md5") or ""
                    break
        if not matched_md5:
            for e_item in eps:
                if int(e_item.get("episode") or 1) == target_ep:
                    matched_md5 = e_item.get("md5") or ""
                    break
        if not matched_md5 and eps:
            matched_md5 = eps[0].get("md5") or ""
        md5 = matched_md5 or movie_data.get("md5") or ""

    if not md5 or not re.fullmatch(r"[a-f0-9]{32}", md5):
        return JSONResponse({"status": False, "error": "Could not resolve valid md5 for stream"}, status_code=404)

    # Ensure valid token from torbo007.com/api/tokenplay
    tok = await loop.run_in_executor(None, ensure_valid_torbo_token, md5, clean_slug)
    if not tok or not tok.get("token") or not tok.get("stream_id"):
        return JSONResponse(
            {"status": False, "error": f"Token generation failed: {tok.get('error', 'unknown')}"},
            status_code=502,
        )

    stream_id = tok["stream_id"]
    token = tok["token"]
    expires = tok["expires"]
    sid = tok.get("sid") or ""

    real_m3u8_url = (
        f"{TORBO_BASE}/api/stream/{stream_id}/index.m3u8"
        f"?token={token}&expires={expires}&parent=goseries4k.com&sid={sid}"
    )

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(real_m3u8_url, headers=get_torbo_headers(md5))
            if resp.status_code != 200:
                # Token might have been invalidated early; force refresh once
                set_cached(f"torbo:token:{md5}", "torbo_token", {}, 0)
                tok = await loop.run_in_executor(None, request_torbo_token, md5)
                if tok.get("token") and tok.get("stream_id"):
                    real_m3u8_url = (
                        f"{TORBO_BASE}/api/stream/{tok['stream_id']}/index.m3u8"
                        f"?token={tok['token']}&expires={tok['expires']}&parent=goseries4k.com&sid={tok.get('sid', '')}"
                    )
                    resp = await client.get(real_m3u8_url, headers=get_torbo_headers(md5))

            if resp.status_code != 200:
                return JSONResponse(
                    {"status": False, "error": f"Upstream M3U8 returned HTTP {resp.status_code}"},
                    status_code=502,
                )

            m3u8_text = resp.text
            rewritten_lines = []
            for line in m3u8_text.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    # Resolve relative URL if needed
                    if not stripped.startswith("http"):
                        stripped = urllib.parse.urljoin(real_m3u8_url, stripped)
                    encoded_url = urllib.parse.quote(stripped, safe="")
                    rewritten_lines.append(f"/stream/{clean_slug}/segment?url={encoded_url}&md5={md5}")
                else:
                    rewritten_lines.append(line)

            rewritten_m3u8 = "\n".join(rewritten_lines) + "\n"
            return Response(
                content=rewritten_m3u8,
                media_type="application/vnd.apple.mpegurl",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                },
            )
    except Exception as e:
        return JSONResponse({"status": False, "error": f"M3U8 proxy error: {e}"}, status_code=500)

async def stream_segment_proxy(request):
    """
    manual.txt endpoint: GET /stream/{slug}/segment?url=<encoded>&md5=<md5>
    Proxies HLS .ts segments from torbo007 / tiktokcdn with forged Referer, Origin, Range headers,
    and strips the fake 252-byte PNG header before the MPEG-TS 0x47 sync byte for pure video/mp2t playback!
    """
    target_url = request.query_params.get("url", "").strip()
    md5 = request.query_params.get("md5", "77c5d4d1c67567ab6abc3b9875050a4e").strip()
    if not target_url:
        return JSONResponse({"error": "Missing segment url"}, status_code=400)

    headers = get_torbo_headers(md5)
    range_hdr = request.headers.get("range")
    if range_hdr:
        headers["Range"] = range_hdr

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(target_url, headers=headers)
            if resp.status_code not in (200, 206):
                return Response(content=b"", status_code=resp.status_code)

            content = resp.content
            # Strip fake PNG header if present so browser receives pure 188-byte aligned MPEG-TS (0x47)
            if len(content) > 512 and content[0] != 0x47:
                search_limit = min(len(content) - 376, 2048)
                for off in range(search_limit):
                    if content[off] == 0x47 and content[off + 188] == 0x47 and content[off + 376] == 0x47:
                        content = content[off:]
                        break

            return Response(
                content=content,
                status_code=200,
                media_type="video/mp2t",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=86400",
                },
            )
    except Exception as e:
        return JSONResponse({"error": f"Segment proxy error: {e}"}, status_code=502)

async def api_search(request):
    """
    Searches across the unified RongYok + GoSeries4K catalog first.
    If few matches, queries BOTH RongYok live search AND GoSeries4K WP REST search!
    """
    query = request.query_params.get("q", "").strip()
    if not query:
        return JSONResponse({"status": True, "results": [], "source": "empty"})

    cache_key = f"search:unified:v2:{query.lower()}"
    cached = get_cached(cache_key)
    if cached:
        return JSONResponse({"status": True, "source": "cache", "results": cached})

    seed = get_seed_data()
    q_lower = query.lower()
    tokens = [t for t in q_lower.split() if t]
    matches = []

    for d in seed.get("dramas", []):
        title = d.get("title", "").lower()
        eng_title = d.get("english_title", "").lower()
        synopsis = d.get("synopsis", "").lower()
        genres = " ".join(g.lower() for g in d.get("genre", []))
        lang = d.get("language", "").lower()
        sid = str(d.get("series_id") or d.get("id") or d.get("slug") or "").lower()
        combined = f"{title} {eng_title} {genres} {lang} {synopsis} {sid}"

        if q_lower in combined or (tokens and all(t in combined for t in tokens)):
            matches.append(d)

    # If few matches, query GoSeries4K WP REST API + RongYok AJAX live search
    if len(matches) < 8:
        # 1. GoSeries4K Live WP REST Search
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                gs_resp = await client.get(
                    f"{GOSERIES_BASE}/wp-json/wp/v2/posts",
                    params={"search": query, "per_page": 10, "_embed": "1"},
                    headers=GOSERIES_HEADERS,
                )
                if gs_resp.status_code == 200:
                    gs_posts = gs_resp.json()
                    for p in gs_posts:
                        base = parse_wp_post_base(p)
                        did = f"gs-{base['slug']}"
                        if any(m.get("id") == did for m in matches):
                            continue
                        matches.append({
                            "id": did,
                            "slug": base["slug"],
                            "post_id": base["post_id"],
                            "series_id": base["post_id"],
                            "provider": "goseries4k",
                            "aspect_ratio": "16:9",
                            "title": base["title"],
                            "english_title": base["english_title"],
                            "cover": base["remote_poster"],
                            "remote_cover": base["remote_poster"],
                            "genre": base["genres"],
                            "rating": 9.7,
                            "episodes": 16,
                            "views": "4K HD",
                            "language": " + ".join(base["langs"]),
                            "audio_tracks": base["langs"],
                            "synopsis": base["excerpt"] or f"รับชม {base['title']} คมชัดระดับ 4K HD",
                            "status": "ครบทุกตอน",
                            "release_year": base["year"],
                        })
        except Exception as e:
            print(f"GoSeries4K live search error: {e}")

        # 2. RongYok Live AJAX Search
        try:
            headers = {
                **RONGYOK_HEADERS,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{RONGYOK_BASE}/search"
            }
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(
                    f"{RONGYOK_BASE}/search",
                    params={"ajax": "load_more", "keyword": query, "offset": 0},
                    headers=headers
                )
                if resp.status_code == 200:
                    data = resp.json()
                    html = data.get("html", "")
                    cards = re.findall(r'<a href=["\']series/(\d+)/[^"\']*["\'][^>]*>(.*?)</a>', html, re.DOTALL)
                    for sid, card_content in cards:
                        sid = int(sid)
                        if any(m.get("series_id") == sid for m in matches):
                            continue

                        title_m = re.search(r'alt=["\']([^"\']+)["\']', card_content)
                        title = title_m.group(1) if title_m else f"ซีรีส์ {sid}"

                        img_m = re.search(r'src=["\']([^"\']+)["\']', card_content)
                        poster = img_m.group(1) if img_m else ""
                        if poster and not poster.startswith("http"):
                            poster = f"{RONGYOK_BASE}/{poster.lstrip('/')}"

                        badge_m = re.search(r'>(พากย์ไทย|ซับไทย)<', card_content)
                        lang = badge_m.group(1) if badge_m else "พากย์ไทย"

                        matches.append({
                            "id": f"ry-{sid}",
                            "series_id": sid,
                            "provider": "rongyok",
                            "title": title,
                            "english_title": f"RongYok Series {sid}",
                            "cover": poster or f"{RONGYOK_BASE}/images/poster/{sid}.webp",
                            "genre": ["หนังสั้นจีน", lang],
                            "rating": 9.5,
                            "episodes": 60,
                            "views": "1.2M",
                            "language": f"{lang} (เต็มเรื่อง)",
                            "synopsis": f"ซีรีส์สั้นเรื่อง {title} {lang} รับชมฟรี",
                            "status": "จบแล้ว"
                        })
        except Exception as e:
            print(f"RongYok live search error: {e}")

    set_cached(cache_key, "search", matches, 86400)
    return JSONResponse({"status": True, "source": "search", "results": matches})

async def api_drama_detail(request):
    drama_id = request.path_params.get("id")
    seed = get_seed_data()
    for d in seed.get("dramas", []):
        if d.get("id") == drama_id or str(d.get("series_id")) == drama_id or d.get("slug") == drama_id:
            return JSONResponse({"status": True, "drama": d, "source": "catalog"})

    if drama_id.startswith("gs-"):
        import asyncio
        loop = asyncio.get_running_loop()
        mdata = await loop.run_in_executor(None, get_or_scrape_goseries_movie, drama_id[3:])
        if mdata:
            return JSONResponse({"status": True, "drama": mdata, "source": "goseries_live"})

    return JSONResponse({"status": False, "error": "Drama not found"}, status_code=404)

async def api_episodes(request):
    """
    Unified Episode Resolver for both GoSeries4K (gs-<slug>) and RongYok (ry-<series_id>).
    """
    drama_id = request.path_params.get("id", "")
    lang_pref = request.query_params.get("lang", "").strip()

    # ── GoSeries4K Series / Movie ──
    if drama_id.startswith("gs-") or request.query_params.get("provider") == "goseries4k":
        clean_slug = drama_id[3:] if drama_id.startswith("gs-") else drama_id
        import asyncio
        loop = asyncio.get_running_loop()
        mdata = await loop.run_in_executor(None, get_or_scrape_goseries_movie, clean_slug)
        raw_eps = mdata.get("episodes") or []
        audio_tracks = mdata.get("audio_tracks") or ["พากย์ไทย"]

        # Group episodes by audio track
        episodes_by_lang = {}
        for ep in raw_eps:
            l_key = ep.get("lang") or "พากย์ไทย"
            episodes_by_lang.setdefault(l_key, []).append({
                "episode": int(ep.get("episode") or 1),
                "title": ep.get("title") or f"EP {ep.get('episode', 1)}",
                "lang": l_key,
                "md5": ep.get("md5") or "",
                "duration": "45:00",
                "is_free": True,
            })

        active_lang = lang_pref if (lang_pref and lang_pref in episodes_by_lang) else (audio_tracks[0] if audio_tracks else "พากย์ไทย")
        active_episodes = episodes_by_lang.get(active_lang) or list(episodes_by_lang.values())[0] if episodes_by_lang else [
            {"episode": 1, "title": "EP 1", "lang": active_lang, "md5": mdata.get("md5", ""), "duration": "45:00", "is_free": True}
        ]

        return JSONResponse({
            "status": True,
            "provider": "goseries4k",
            "slug": clean_slug,
            "post_id": mdata.get("post_id") or 0,
            "synopsis": mdata.get("synopsis") or "",
            "audio_tracks": audio_tracks,
            "active_lang": active_lang,
            "episodes_by_lang": episodes_by_lang,
            "episodes": active_episodes,
            "source": "goseries4k",
        })

    # ── RongYok Vertical Short Drama ──
    series_id = drama_id[3:] if drama_id.startswith("ry-") else drama_id
    cache_key = f"episodes:rongyok:v2:{series_id}"
    cached = get_cached(cache_key)
    if cached:
        return JSONResponse({"status": True, "episodes": cached, "source": "cache"})

    ep_count = 0
    source = "live"
    try:
        url = f"{RONGYOK_BASE}/watch/?series_id={series_id}"
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=RONGYOK_HEADERS)
            if resp.status_code == 200:
                m = re.search(r'const\s+seriesData\s*=\s*(\{.*?\});\s*\n', resp.text, re.DOTALL)
                if m:
                    data = json.loads(m.group(1))
                    eps = data.get("episodes", [])
                    if eps:
                        ep_count = len(eps)
                    elif data.get("episodes_count"):
                        ep_count = int(data.get("episodes_count"))
    except Exception as e:
        print(f"Error resolving episode count for {series_id}: {e}")

    if not ep_count:
        seed = get_seed_data()
        for d in seed.get("dramas", []):
            if str(d.get("series_id")) == str(series_id) or d.get("id") == f"ry-{series_id}":
                if d.get("episodes"):
                    ep_count = int(d["episodes"])
                    source = "catalog"
                break

    if not ep_count:
        ep_count = 60
        source = "fallback"

    episodes = [
        {"episode": ep, "title": f"ตอนที่ {ep}", "duration": "1:30", "is_free": True}
        for ep in range(1, ep_count + 1)
    ]

    if source != "fallback":
        set_cached(cache_key, "episodes", episodes, 86400 * 30)
    return JSONResponse({"status": True, "episodes": episodes, "source": source})

async def api_play(request):
    """
    Unified Play Resolver:
    - For GoSeries4K (gs-<slug>): resolves episode md5, pre-warms torbo007 token, and returns local HLS proxy URL (/stream/<slug>/index.m3u8).
    - For RongYok (ry-<series_id>): proxies MP4 URL from https://rongyok.com/watch/playseries.php.
    """
    drama_id = request.path_params.get("id", "")
    ep = request.path_params.get("ep", "1")
    provider = request.query_params.get("provider", "")
    lang_param = request.query_params.get("lang", "").strip()
    md5_param = request.query_params.get("md5", "").strip()

    # ── GoSeries4K + Torbo007 HLS Stream ──
    if drama_id.startswith("gs-") or provider == "goseries4k":
        clean_slug = drama_id[3:] if drama_id.startswith("gs-") else drama_id
        import asyncio
        loop = asyncio.get_running_loop()
        mdata = await loop.run_in_executor(None, get_or_scrape_goseries_movie, clean_slug)
        eps = mdata.get("episodes") or []
        ep_num = int(ep) if str(ep).isdigit() else 1

        target_md5 = md5_param if re.fullmatch(r"[a-f0-9]{32}", md5_param) else ""
        if not target_md5 and lang_param:
            for e_item in eps:
                if int(e_item.get("episode") or 1) == ep_num and lang_param in (e_item.get("lang") or ""):
                    target_md5 = e_item.get("md5") or ""
                    break
        if not target_md5:
            for e_item in eps:
                if int(e_item.get("episode") or 1) == ep_num:
                    target_md5 = e_item.get("md5") or ""
                    break
        if not target_md5 and eps:
            target_md5 = eps[0].get("md5") or ""
        if not target_md5:
            target_md5 = mdata.get("md5") or ""

        if not target_md5:
            return JSONResponse({"status": False, "error": "ไม่พบ MD5 ของตอนนี้ใน GoSeries4K"}, status_code=404)

        # Pre-warm token in background/executor
        await loop.run_in_executor(None, ensure_valid_torbo_token, target_md5, clean_slug)
        hls_url = f"/stream/{clean_slug}/index.m3u8?ep={ep_num}&md5={target_md5}"
        if lang_param:
            hls_url += f"&lang={urllib.parse.quote(lang_param)}"

        return JSONResponse({
            "status": True,
            "stream": {
                "streamUrl": hls_url,
                "format": "HLS",
                "md5": target_md5,
                "embedUrl": f"https://torbo007.com/embed/{target_md5}",
            },
            "source": "torbo007_hls_proxy",
        })

    # ── RongYok MP4 Stream ──
    series_id = drama_id[3:] if drama_id.startswith("ry-") else drama_id

    cache_key = f"rongyok:play:{series_id}:ep{ep}"
    cached = get_cached(cache_key)
    if cached:
        return JSONResponse({
            "status": True,
            "stream": {"streamUrl": cached["video_url"], "format": "MP4"},
            "source": "cache"
        })

    try:
        play_url = f"{RONGYOK_BASE}/watch/playseries.php?series_id={series_id}&ep={ep}"
        headers = {
            **RONGYOK_HEADERS,
            "Accept": "application/json, text/plain, */*",
            "Referer": f"{RONGYOK_BASE}/watch/?series_id={series_id}",
            "X-Requested-With": "XMLHttpRequest",
        }
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(play_url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("ok") and data.get("video_url"):
                    video_url = data["video_url"]
                    set_cached(cache_key, "stream", {"video_url": video_url}, 1200)
                    return JSONResponse({
                        "status": True,
                        "stream": {"streamUrl": video_url, "format": "MP4"},
                        "source": "rongyok_live"
                    })
    except Exception as e:
        print(f"Play fetch error for {series_id} ep {ep}: {e}")

    return JSONResponse({"status": False, "error": "ไม่พบวิดีโอจากระบบต้นทาง"}, status_code=404)

# ──────────────────────────────────────────────
# GOSERIES4K EXTRA ENDPOINTS (manual.txt Section 2.1)
# ──────────────────────────────────────────────

async def api_goseries_categories(request):
    """GET https://goseries4k.com/wp-json/wp/v2/categories?per_page=100"""
    cached = get_cached("goseries:categories")
    if cached:
        return JSONResponse({"status": True, "categories": cached})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{GOSERIES_BASE}/wp-json/wp/v2/categories?per_page=100", headers=GOSERIES_HEADERS)
            if r.status_code == 200:
                data = r.json()
                set_cached("goseries:categories", "goseries", data, 86400)
                return JSONResponse({"status": True, "categories": data})
    except Exception as e:
        return JSONResponse({"status": False, "error": str(e)}, status_code=502)
    return JSONResponse({"status": False, "categories": []})

async def api_goseries_tags(request):
    """GET https://goseries4k.com/wp-json/wp/v2/tags?per_page=100"""
    cached = get_cached("goseries:tags")
    if cached:
        return JSONResponse({"status": True, "tags": cached})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{GOSERIES_BASE}/wp-json/wp/v2/tags?per_page=100", headers=GOSERIES_HEADERS)
            if r.status_code == 200:
                data = r.json()
                set_cached("goseries:tags", "goseries", data, 86400)
                return JSONResponse({"status": True, "tags": data})
    except Exception as e:
        return JSONResponse({"status": False, "error": str(e)}, status_code=502)
    return JSONResponse({"status": False, "tags": []})

async def api_goseries_announcements(request):
    """GET https://goseries4k.com/wp-json/mov/v1/announcements?post_id=<post_id>"""
    post_id = request.path_params.get("post_id", "0")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{GOSERIES_BASE}/wp-json/mov/v1/announcements?post_id={post_id}",
                headers=GOSERIES_HEADERS,
            )
            if r.status_code == 200:
                return JSONResponse(r.json())
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)
    return JSONResponse({"success": False, "data": []})

async def api_goseries_comments(request):
    """GET https://goseries4k.com/wp-json/mov/v1/comments/<post_id>?page=1&_locale=th&_=<timestamp>"""
    post_id = request.path_params.get("post_id", "0")
    page = request.query_params.get("page", "1")
    guest_token = request.headers.get("x-mov-guest-token", "")
    ts = int(time.time() * 1000)
    headers = {**GOSERIES_HEADERS}
    if guest_token:
        headers["x-mov-guest-token"] = guest_token
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{GOSERIES_BASE}/wp-json/mov/v1/comments/{post_id}?page={page}&_locale=th&_={ts}",
                headers=headers,
            )
            if r.status_code == 200:
                return JSONResponse(r.json())
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)
    return JSONResponse({"success": False, "data": {"comments": []}})

# ──────────────────────────────────────────────
# FAVORITES & WATCH HISTORY (manual.txt Section 6 & 8)
# ──────────────────────────────────────────────

async def api_favorites(request):
    conn = get_db()
    cur = conn.cursor()
    if request.method == "GET":
        cur.execute("SELECT movie_id, drama_id, added_at FROM favorites ORDER BY added_at DESC")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return JSONResponse({"status": True, "favorites": rows})

    body = await request.json()
    drama_id = str(body.get("drama_id") or body.get("id") or "").strip()
    action = body.get("action", "toggle")
    if not drama_id:
        conn.close()
        return JSONResponse({"status": False, "error": "Missing drama_id"}, status_code=400)

    cur.execute("SELECT drama_id FROM favorites WHERE drama_id = ?", (drama_id,))
    exists = cur.fetchone() is not None

    if action == "remove" or (action == "toggle" and exists):
        cur.execute("DELETE FROM favorites WHERE drama_id = ?", (drama_id,))
        favorited = False
    else:
        cur.execute(
            "INSERT OR REPLACE INTO favorites (drama_id, added_at) VALUES (?, ?)",
            (drama_id, int(time.time())),
        )
        favorited = True

    conn.commit()
    conn.close()
    return JSONResponse({"status": True, "drama_id": drama_id, "favorited": favorited})

async def api_watch_history(request):
    conn = get_db()
    cur = conn.cursor()
    if request.method == "GET":
        cur.execute(
            "SELECT drama_id, episode, position_seconds, duration_seconds, watched_at FROM watch_history ORDER BY watched_at DESC LIMIT 30"
        )
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return JSONResponse({"status": True, "history": rows})

    if request.method == "DELETE":
        cur.execute("DELETE FROM watch_history")
        conn.commit()
        conn.close()
        return JSONResponse({"status": True, "cleared": True})

    body = await request.json()
    drama_id = str(body.get("drama_id") or body.get("id") or "").strip()
    ep = int(body.get("episode") or 1)
    pos = int(float(body.get("position_seconds") or 0))
    dur = int(float(body.get("duration_seconds") or 0))
    if drama_id:
        cur.execute("DELETE FROM watch_history WHERE drama_id = ?", (drama_id,))
        cur.execute(
            """
            INSERT INTO watch_history (drama_id, episode, position_seconds, duration_seconds, watched_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (drama_id, ep, pos, dur, int(time.time())),
        )
        conn.commit()
    conn.close()
    return JSONResponse({"status": True})

async def api_image_proxy(request):
    """
    Smart on-demand image proxy and disk cache for any poster (RongYok or GoSeries4K).
    """
    img_url = request.query_params.get("url", "").strip()
    sid = request.query_params.get("sid", "").strip()

    if sid.startswith("gs-"):
        post_id = sid[3:]
        for ext in (".png", ".webp", ".jpg"):
            local_file = os.path.join(POSTERS_DIR, f"gs-{post_id}{ext}")
            if os.path.exists(local_file) and os.path.getsize(local_file) > 500:
                return FileResponse(local_file)

    clean_sid = sid.replace("ry-", "").replace("gs-", "")
    if clean_sid and not sid.startswith("gs-"):
        for ext in (".webp", ".jpg"):
            local_file = os.path.join(POSTERS_DIR, f"ry-{clean_sid}{ext}")
            if os.path.exists(local_file) and os.path.getsize(local_file) > 500:
                return FileResponse(local_file)

        try:
            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                w_resp = await client.get(f"{RONGYOK_BASE}/watch/?series_id={clean_sid}", headers=RONGYOK_HEADERS)
                if w_resp.status_code == 200:
                    m = re.search(r'const\s+seriesData\s*=\s*(\{.*?\});\s*\n', w_resp.text, re.DOTALL)
                    if m:
                        sdata = json.loads(m.group(1))
                        rel_poster = sdata.get("poster_url") or sdata.get("jpg_url") or ""
                        if rel_poster:
                            img_url = f"{RONGYOK_BASE}/{rel_poster.lstrip('/')}"
        except Exception:
            pass

    if not img_url:
        return JSONResponse({"error": "No url or sid provided"}, status_code=400)

    url_hash = hashlib.md5(img_url.encode()).hexdigest()
    cached_file = os.path.join(POSTERS_DIR, f"cache_{url_hash}.jpg")

    if os.path.exists(cached_file) and os.path.getsize(cached_file) > 500:
        return FileResponse(cached_file)

    headers = GOSERIES_HEADERS if "goseries4k" in img_url else RONGYOK_HEADERS
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(img_url, headers=headers)
            if resp.status_code == 200 and len(resp.content) > 500:
                with open(cached_file, "wb") as f:
                    f.write(resp.content)
                return FileResponse(cached_file)
    except Exception as e:
        print(f"Image proxy error: {e}")

    fallback_poster = os.path.join(POSTERS_DIR, "ry-100309804.jpg")
    if os.path.exists(fallback_poster):
        return FileResponse(fallback_poster)

    return JSONResponse({"error": "Image not found"}, status_code=404)

async def api_sync(request):
    """
    On-demand catalog & poster auto-update endpoint for BOTH GoSeries4K and RongYok.
    """
    import asyncio
    from scripts.auto_update import run_sync
    loop = asyncio.get_running_loop()
    gs_res = await loop.run_in_executor(None, run_goseries_scrape, 24, 5)
    ry_res = await loop.run_in_executor(None, run_sync, False, 25)
    return JSONResponse({"status": True, "goseries4k": gs_res, "rongyok": ry_res})

async def index(request):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# ──────────────────────────────────────────────
# BACKGROUND JOBS (manual.txt Section 4 Stage 3)
# 1. Token Refresher (every 30 minutes)
# 2. Scraper Auto-Updater (GoSeries4K + RongYok)
# ──────────────────────────────────────────────

def _start_background_jobs():
    import threading

    def _token_refresher_worker():
        time.sleep(30)
        while True:
            try:
                count = refresh_expiring_tokens(DB_PATH, margin_seconds=1800)
                if count > 0:
                    print(f"[Token Refresher] Auto-refreshed {count} expiring Torbo007 tokens.")
            except Exception as e:
                print(f"[Token Refresher Error]: {e}")
            time.sleep(1800)  # Every 30 minutes

    def _scraper_worker():
        time.sleep(15)
        while True:
            try:
                run_goseries_scrape(max_posts=24, fetch_initial_tokens=4)
                from scripts.auto_update import run_sync
                run_sync(sync_all_metadata=False, max_new=20)
            except Exception as e:
                print(f"[Auto-Scraper Background Error]: {e}")
            time.sleep(6 * 3600)

    threading.Thread(target=_token_refresher_worker, daemon=True).start()
    threading.Thread(target=_scraper_worker, daemon=True).start()

# ──────────────────────────────────────────────
# APP BOOT
# ──────────────────────────────────────────────

init_db()
_start_background_jobs()

routes = [
    Route("/", endpoint=index),
    Route("/api/status", endpoint=api_status, methods=["GET"]),
    Route("/api/feed", endpoint=api_feed, methods=["GET"]),
    Route("/api/movies", endpoint=api_movies_list, methods=["GET"]),
    Route("/api/movies/{slug}", endpoint=api_movie_by_slug, methods=["GET"]),
    Route("/stream/{slug}/index.m3u8", endpoint=stream_m3u8_proxy, methods=["GET"]),
    Route("/stream/{slug}/segment", endpoint=stream_segment_proxy, methods=["GET"]),
    Route("/api/stream/{slug}/index.m3u8", endpoint=stream_m3u8_proxy, methods=["GET"]),
    Route("/api/stream/{slug}/segment", endpoint=stream_segment_proxy, methods=["GET"]),
    Route("/api/search", endpoint=api_search, methods=["GET"]),
    Route("/api/detail/{id}", endpoint=api_drama_detail, methods=["GET"]),
    Route("/api/episodes/{id}", endpoint=api_episodes, methods=["GET"]),
    Route("/api/play/{id}/{ep}", endpoint=api_play, methods=["GET"]),
    Route("/api/favorites", endpoint=api_favorites, methods=["GET", "POST"]),
    Route("/api/history", endpoint=api_watch_history, methods=["GET", "POST", "DELETE"]),
    Route("/api/goseries/categories", endpoint=api_goseries_categories, methods=["GET"]),
    Route("/api/goseries/tags", endpoint=api_goseries_tags, methods=["GET"]),
    Route("/api/goseries/announcements/{post_id}", endpoint=api_goseries_announcements, methods=["GET"]),
    Route("/api/goseries/comments/{post_id}", endpoint=api_goseries_comments, methods=["GET"]),
    Route("/api/proxy-image", endpoint=api_image_proxy, methods=["GET"]),
    Route("/api/sync", endpoint=api_sync, methods=["GET", "POST"]),
    Mount("/static", app=StaticFiles(directory=STATIC_DIR), name="static"),
    Mount("/data", app=StaticFiles(directory=DATA_DIR), name="data"),
]

middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=[
            "https://webseries.sirapongsam.workers.dev",
            "http://localhost:8000",
            "http://localhost:3000",
            "http://127.0.0.1:8000",
        ],
        allow_origin_regex=r"http://192\.168\.\d+\.\d+(:\d+)?",
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
]

app = Starlette(debug=True, routes=routes, middleware=middleware)

if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*62)
    print(">> SO+ SERIES & MOVIES (RONGYOK + GOSERIES4K + TORBO007 EDITION)")
    print(">> URL (Local): http://localhost:8000")
    print(">> URL (LAN):   http://192.168.1.142:8000")
    print(">> Catalog: 850+ Short Dramas + GoSeries4K 4K Series & Movies")
    print(">> HLS Proxy, Token Auto-Refresher & Scraper: ENABLED")
    print("="*62 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
