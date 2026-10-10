import os
import re
import json
import time
import hashlib
import sqlite3
import httpx
from datetime import datetime, timezone
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.responses import JSONResponse, FileResponse
from starlette.staticfiles import StaticFiles

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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124",
    "Referer": "https://rongyok.com/",
    "Accept": "text/html,application/json,*/*",
}

# ──────────────────────────────────────────────
# DATABASE & CACHE
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
# API ENDPOINTS (100% RONGYOK)
# ──────────────────────────────────────────────

async def api_status(request):
    seed = get_seed_data()
    total_dramas = len(seed.get("dramas", []))
    
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) as count FROM cache_store")
    cached_count = cur.fetchone()["count"]
    conn.close()

    return JSONResponse({
        "status": "online",
        "provider": "RongYok API (100% Free - Unlimited)",
        "total_dramas": total_dramas,
        "cached_entries": cached_count
    })

async def api_feed(request):
    """
    Returns home feed from the harvested 800+ RongYok catalog.
    Supports filtering by genre and audio (all / dubbed / subbed).
    """
    lang_filter = request.query_params.get("lang", "all")
    genre_filter = request.query_params.get("genre", "ทั้งหมด")
    page = int(request.query_params.get("page", 1))
    limit = int(request.query_params.get("limit", 48))

    seed = get_seed_data()
    dramas = seed.get("dramas", [])

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

async def api_search(request):
    """
    Search across the 800+ RongYok local catalog first.
    If less than 4 matches, query RongYok live search endpoint!
    """
    query = request.query_params.get("q", "").strip()
    if not query:
        return JSONResponse({"status": True, "results": [], "source": "empty"})

    cache_key = f"search:rongyok:{query.lower()}"
    cached = get_cached(cache_key)
    if cached:
        return JSONResponse({"status": True, "source": "cache", "results": cached})

    seed = get_seed_data()
    q_lower = query.lower()
    tokens = [t for t in q_lower.split() if t]
    matches = []

    for d in seed.get("dramas", []):
        title = d.get("title", "").lower()
        synopsis = d.get("synopsis", "").lower()
        genres = " ".join(g.lower() for g in d.get("genre", []))
        lang = d.get("language", "").lower()
        sid = str(d.get("series_id") or d.get("id") or "").lower()
        combined = f"{title} {genres} {lang} {synopsis} {sid}"

        if q_lower in combined or (tokens and all(t in combined for t in tokens)):
            matches.append(d)

    # If few matches, query RongYok AJAX live search
    if len(matches) < 6:
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
            print(f"Live search error: {e}")

    # Cache search for 24h
    set_cached(cache_key, "search", matches, 86400)
    return JSONResponse({"status": True, "source": "search", "results": matches})

async def api_drama_detail(request):
    drama_id = request.path_params.get("id")
    seed = get_seed_data()
    for d in seed.get("dramas", []):
        if d.get("id") == drama_id or str(d.get("series_id")) == drama_id:
            return JSONResponse({"status": True, "drama": d, "source": "catalog"})
    
    return JSONResponse({"status": False, "error": "Drama not found"}, status_code=404)

async def api_episodes(request):
    """
    Get full episode list for RongYok drama.
    Fetches real episode count directly from RongYok watch page.
    """
    drama_id = request.path_params.get("id")
    series_id = drama_id[3:] if drama_id.startswith("ry-") else drama_id

    cache_key = f"episodes:rongyok:{series_id}"
    cached = get_cached(cache_key)
    if cached:
        return JSONResponse({"status": True, "episodes": cached, "source": "cache"})

    ep_count = 60
    # Fetch real episode count from watch page
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

    episodes = [
        {"episode": ep, "title": f"ตอนที่ {ep}", "duration": "1:30", "is_free": True}
        for ep in range(1, ep_count + 1)
    ]

    set_cached(cache_key, "episodes", episodes, 86400 * 30)
    return JSONResponse({"status": True, "episodes": episodes, "source": "live"})

async def api_play(request):
    """
    Proxies video URL from https://rongyok.com/watch/playseries.php
    Caches 20 minutes to prevent token expiration while remaining fast.
    """
    drama_id = request.path_params.get("id")
    ep = request.path_params.get("ep")
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

    return JSONResponse({"status": False, "error": "ไม่พบวิดีโอจาก RongYok"}, status_code=404)

async def api_image_proxy(request):
    """
    Smart on-demand image proxy and disk cache for any poster.
    """
    img_url = request.query_params.get("url", "").strip()
    if not img_url:
        return JSONResponse({"error": "No url provided"}, status_code=400)

    url_hash = hashlib.md5(img_url.encode()).hexdigest()
    cached_file = os.path.join(POSTERS_DIR, f"cache_{url_hash}.jpg")

    if os.path.exists(cached_file) and os.path.getsize(cached_file) > 500:
        return FileResponse(cached_file)

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(img_url, headers=RONGYOK_HEADERS)
            if resp.status_code == 200 and len(resp.content) > 500:
                with open(cached_file, "wb") as f:
                    f.write(resp.content)
                return FileResponse(cached_file)
    except Exception as e:
        print(f"Image proxy error: {e}")

    # Fallback to local default poster if available
    fallback_poster = os.path.join(POSTERS_DIR, "ry-100309804.jpg")
    if os.path.exists(fallback_poster):
        return FileResponse(fallback_poster)

    return JSONResponse({"error": "Image not found"}, status_code=404)

async def index(request):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# ──────────────────────────────────────────────
# APP BOOT
# ──────────────────────────────────────────────

init_db()

routes = [
    Route("/", endpoint=index),
    Route("/api/status", endpoint=api_status, methods=["GET"]),
    Route("/api/feed", endpoint=api_feed, methods=["GET"]),
    Route("/api/search", endpoint=api_search, methods=["GET"]),
    Route("/api/detail/{id}", endpoint=api_drama_detail, methods=["GET"]),
    Route("/api/episodes/{id}", endpoint=api_episodes, methods=["GET"]),
    Route("/api/play/{id}/{ep}", endpoint=api_play, methods=["GET"]),
    Route("/api/proxy-image", endpoint=api_image_proxy, methods=["GET"]),
    Mount("/static", app=StaticFiles(directory=STATIC_DIR), name="static"),
    Mount("/data", app=StaticFiles(directory=DATA_DIR), name="data"),
]

app = Starlette(debug=True, routes=routes)

if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*55)
    print(">> SHORTFLIX (100% RONGYOK EDITION)")
    print(">> URL: http://localhost:8000")
    print(">> Catalog: 800+ Real Thai Dubbed / Subbed Dramas")
    print(">> Unlimited Playback via RongYok Direct Stream")
    print("="*55 + "\n")
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
