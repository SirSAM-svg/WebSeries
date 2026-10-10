#!/usr/bin/env python3
"""
RongYok Auto-Update & Full Metadata Sync Engine
- Discovers new drama releases from RongYok (Homepage, Sitemap, Search AJAX).
- Extracts REAL episode counts, REAL synopses, and REAL poster URLs from /watch/?series_id=<id>.
- Downloads missing poster images to static/posters/.
- Can sync new releases incrementally (default) or refresh all catalog metadata (--sync-all).
"""

import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# Force UTF-8 encoding for Windows console & GitHub Actions logs
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(ROOT_DIR, "data")
POSTERS_DIR = os.path.join(ROOT_DIR, "static", "posters")
SEED_PATH = os.path.join(DATA_DIR, "seed_data.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(POSTERS_DIR, exist_ok=True)

RONGYOK_BASE = "https://rongyok.com"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://rongyok.com/",
    "Accept": "text/html,application/json,*/*",
}


def load_catalog():
    if os.path.exists(SEED_PATH):
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[ERROR] Loading catalog failed: {e}")
    return {"providers": [], "genres": [], "featured": {}, "dramas": []}


def save_catalog(catalog):
    with open(SEED_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)


def make_safe_url(url: str) -> str:
    if not url:
        return ""
    if not url.startswith("http"):
        url = f"{RONGYOK_BASE}/{url.lstrip('/')}"
    parsed = urllib.parse.urlsplit(url)
    # Unquote first to prevent double-encoding if already percent-encoded
    raw_path = urllib.parse.unquote(parsed.path)
    clean_path = urllib.parse.quote(raw_path, safe="/")
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, clean_path, parsed.query, parsed.fragment)
    )


def download_image(url: str, target_path: str) -> bool:
    if not url:
        return False
    try:
        safe_url = make_safe_url(url)
        req = urllib.request.Request(safe_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
            if len(content) > 500 and not content.startswith(b"<!DOCTYPE"):
                with open(target_path, "wb") as f:
                    f.write(content)
                return True
    except Exception:
        pass
    return False


def infer_genres(title: str, synopsis: str, lang: str) -> list:
    text = f"{title} {synopsis}"
    genres = ["หนังสั้นจีน", lang]
    if any(k in text for k in ["ประธาน", "ซีอีโอ", "CEO", "บอส"]):
        genres.append("ประธานบริษัท (CEO)")
    if any(k in text for k in ["แค้น", "แก้แค้น", "เอาคืน", "ทรยศ", "หย่า"]):
        genres.append("แก้แค้น (Revenge)")
    if any(k in text for k in ["รัก", "เจ้าสาว", "ภรรยา", "สามี", "แต่งงาน", "หัวใจ"]):
        genres.append("รักโรแมนติก (Romance)")
    if any(k in text for k in ["หมอ", "เซียน", "เทพ", "ระบบ", "พลัง", "อสูร", "ไลแคน", "ปาฏิหาริย์"]):
        genres.append("แฟนตาซี (Fantasy)")
    if any(k in text for k in ["เกิดใหม่", "ย้อนเวลา", "ข้ามเวลา", "ทะลุมิติ", "ย้อนอดีต", "ชาติที่แล้ว"]):
        genres.append("ย้อนเวลา / กำเนิดใหม่ (Rebirth)")
    if any(k in text for k in ["เศรษฐี", "ตระกูล", "พันล้าน", "ทายาท", "คุณหนู", "คุณชาย"]):
        genres.append("ตระกูลไฮโซ (Billionaire)")
    # Preserve order while deduplicating
    return list(dict.fromkeys(genres))


def fetch_series_metadata(sid: int) -> dict:
    """
    Fetches real metadata (title, description, poster_url, episodes_count, lang, release_year)
    directly from https://rongyok.com/watch/?series_id=<sid>.
    """
    url = f"{RONGYOK_BASE}/watch/?series_id={sid}"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        m = re.search(r"const\s+seriesData\s*=\s*(\{.*?\});\s*\n", html, re.DOTALL)
        if not m:
            return {}

        data = json.loads(m.group(1))
        raw_title = (data.get("title") or "").strip()

        # Detect language from suffix or poster_url or page title
        lang = "พากย์ไทย"
        if raw_title.lower().endswith("sub") or "ซับไทย" in (data.get("poster_url") or ""):
            lang = "ซับไทย"

        clean_title = re.sub(r"(?i)(th|sub)$", "", raw_title).strip()
        if not clean_title:
            clean_title = f"ซีรีส์ {sid}"

        # Real episode count
        eps_list = data.get("episodes")
        ep_count = 0
        if isinstance(eps_list, list) and len(eps_list) > 0:
            ep_count = len(eps_list)
        elif data.get("episodes_count"):
            try:
                ep_count = int(data.get("episodes_count"))
            except Exception:
                ep_count = 0

        # Real poster URL
        poster_rel = data.get("poster_url") or data.get("jpg_url") or ""
        jpg_rel = data.get("jpg_url") or ""
        poster_url = make_safe_url(poster_rel) if poster_rel else ""
        jpg_url = make_safe_url(jpg_rel) if jpg_rel else ""

        # Real description
        desc = (data.get("description") or "").replace("\r\n", " ").replace("\n", " ").strip()

        # Release year
        created_at = data.get("created_at") or ""
        year_m = re.match(r"^(\d{4})", created_at)
        release_year = int(year_m.group(1)) if year_m else 2026

        return {
            "series_id": int(sid),
            "title": clean_title,
            "lang": lang,
            "episodes": ep_count,
            "poster_url": poster_url,
            "jpg_url": jpg_url,
            "synopsis": desc,
            "release_year": release_year,
        }
    except Exception:
        return {}


def fetch_homepage_candidates() -> dict:
    """Scrapes all series cards and JSON-LD items from RongYok homepage."""
    candidates = {}
    try:
        req = urllib.request.Request(f"{RONGYOK_BASE}/", headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # 1. Parse movie-card HTML blocks (contains href, img src, title, lang-badge)
        card_pattern = re.compile(
            r'<a\s+href=["\']/?series/(\d+)/[^"\']*["\'][^>]*>(.*?)</a>',
            re.DOTALL,
        )
        for m in card_pattern.finditer(html):
            sid = int(m.group(1))
            card_html = m.group(2)
            img_m = re.search(r'src=["\']([^"\']+)["\']', card_html)
            poster = img_m.group(1) if img_m else ""
            if poster and "no-image" not in poster:
                poster = make_safe_url(poster)
            else:
                poster = ""

            tag_m = re.search(r'<div class="movie-tag">([^<]+)</div>', card_html)
            alt_m = re.search(r'alt=["\']([^"\']+)["\']', card_html)
            title = (
                tag_m.group(1).strip()
                if tag_m
                else (alt_m.group(1).split("—")[0].strip() if alt_m else f"ซีรีส์ {sid}")
            )
            badge_m = re.search(r">(พากย์ไทย|ซับไทย)<", card_html)
            lang = badge_m.group(1) if badge_m else "พากย์ไทย"

            candidates[sid] = {
                "series_id": sid,
                "title": title,
                "poster_url": poster,
                "lang": lang,
            }

        # 2. Parse JSON-LD CollectionPage
        ld_blocks = re.findall(
            r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL
        )
        for block in ld_blocks:
            try:
                data = json.loads(block)
                if data.get("@type") == "CollectionPage":
                    items = data.get("mainEntity", {}).get("itemListElement", [])
                    for item in items:
                        url = item.get("url", "")
                        name = item.get("name", "")
                        m = re.search(r"/series/(\d+)/", url)
                        if m:
                            sid = int(m.group(1))
                            if sid not in candidates:
                                candidates[sid] = {
                                    "series_id": sid,
                                    "title": name,
                                    "poster_url": "",
                                    "lang": "พากย์ไทย",
                                }
            except Exception:
                pass
    except Exception as e:
        print(f"[WARN] Failed to fetch homepage: {e}")
    return candidates


def fetch_sitemap_recent_candidates(limit: int = 80) -> dict:
    """Scrapes the latest series IDs from the tail of RongYok's sitemap.xml."""
    candidates = {}
    try:
        req = urllib.request.Request(f"{RONGYOK_BASE}/sitemap.xml", headers=HEADERS)
        with urllib.request.urlopen(req, timeout=12) as resp:
            xml = resp.read().decode("utf-8", errors="replace")

        sids = [int(x) for x in re.findall(r"/series/(\d+)/", xml)]
        # The tail of sitemap.xml has the most recently added series
        for sid in reversed(sids[-limit:]):
            if sid >= 100000000 and sid not in candidates:
                candidates[sid] = {
                    "series_id": sid,
                    "title": f"ซีรีส์ {sid}",
                    "poster_url": "",
                    "lang": "พากย์ไทย",
                }
    except Exception as e:
        print(f"[WARN] Failed to fetch sitemap: {e}")
    return candidates


def fetch_search_candidates() -> dict:
    """Scrapes RongYok AJAX search for popular keywords."""
    candidates = {}
    headers = {
        **HEADERS,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{RONGYOK_BASE}/search",
    }
    keywords = ["รัก", "ประธาน", "แค้น", "เกิดใหม่", "หมอ", "ทะลุมิติ", "ระบบ"]

    for kw in keywords:
        try:
            url = f"{RONGYOK_BASE}/search?ajax=load_more&keyword={urllib.parse.quote(kw)}&offset=0"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
                html = data.get("html", "")
                cards = re.findall(
                    r'<a href=["\']/?series/(\d+)/[^"\']*["\'][^>]*>(.*?)</a>',
                    html,
                    re.DOTALL,
                )
                for sid_str, card in cards:
                    sid = int(sid_str)
                    if sid in candidates:
                        continue
                    title_m = re.search(r'alt=["\']([^"\']+)["\']', card)
                    title = (
                        title_m.group(1).split("—")[0].strip()
                        if title_m
                        else f"ซีรีส์ {sid}"
                    )
                    img_m = re.search(r'src=["\']([^"\']+)["\']', card)
                    poster = make_safe_url(img_m.group(1)) if img_m else ""
                    badge_m = re.search(r">(พากย์ไทย|ซับไทย)<", card)
                    lang = badge_m.group(1) if badge_m else "พากย์ไทย"
                    candidates[sid] = {
                        "series_id": sid,
                        "title": title,
                        "poster_url": poster,
                        "lang": lang,
                    }
        except Exception:
            pass
    return candidates


def ensure_poster_downloaded(sid: int, current_cover: str, poster_url: str, jpg_url: str = "") -> str:
    """
    Ensures a valid poster exists on disk in static/posters/.
    Returns the relative cover path (e.g. '/static/posters/ry-100056493.webp').
    """
    did = f"ry-{sid}"
    # Check if current local file already exists and is valid
    if current_cover and current_cover.startswith("/static/posters/"):
        existing_file = os.path.join(ROOT_DIR, current_cover.lstrip("/").replace("/", os.sep))
        if os.path.exists(existing_file) and os.path.getsize(existing_file) > 500:
            return current_cover

    # Also check both .webp and .jpg on disk
    for ext in (".webp", ".jpg"):
        candidate_rel = f"static/posters/{did}{ext}"
        candidate_abs = os.path.join(ROOT_DIR, candidate_rel.replace("/", os.sep))
        if os.path.exists(candidate_abs) and os.path.getsize(candidate_abs) > 500:
            return f"/{candidate_rel}"

    # Need to download from poster_url or jpg_url
    for url_to_try in [poster_url, jpg_url]:
        if not url_to_try:
            continue
        ext = ".jpg" if url_to_try.lower().endswith(".jpg") else ".webp"
        local_rel = f"static/posters/{did}{ext}"
        target_path = os.path.join(ROOT_DIR, local_rel.replace("/", os.sep))
        if download_image(url_to_try, target_path):
            return f"/{local_rel}"

    return current_cover or f"/static/posters/{did}.webp"


def run_sync(sync_all_metadata: bool = False, max_new: int = 35) -> dict:
    t0 = time.time()
    print("=" * 60)
    print("RongYok Auto-Update & Metadata Sync Engine Running...")
    print("=" * 60)

    catalog = load_catalog()
    existing_dramas = catalog.get("dramas", [])
    existing_ids = {int(d["series_id"]) for d in existing_dramas if d.get("series_id")}
    print(f"Current catalog size: {len(existing_dramas)} dramas")

    # 1. Discover new series candidates (Homepage first, then recent Sitemap, then Search)
    discovered = {}
    home_cands = fetch_homepage_candidates()
    for sid, item in home_cands.items():
        if sid not in existing_ids:
            discovered[sid] = item

    sitemap_cands = fetch_sitemap_recent_candidates(limit=60)
    for sid, item in sitemap_cands.items():
        if sid not in existing_ids and sid not in discovered:
            discovered[sid] = item

    for sid, item in fetch_search_candidates().items():
        if sid not in existing_ids and sid not in discovered:
            discovered[sid] = item

    new_sids = list(discovered.keys())[:max_new]
    print(f"Discovered {len(new_sids)} new series to add.")

    # 2. Fetch full metadata for all new series concurrently
    new_entries = []
    if new_sids:
        with concurrent.futures.ThreadPoolExecutor(max_workers=15) as pool:
            meta_map = dict(zip(new_sids, pool.map(fetch_series_metadata, new_sids)))

        for sid in new_sids:
            cand = discovered[sid]
            meta = meta_map.get(sid) or {}

            title = meta.get("title") or cand.get("title") or f"ซีรีส์ {sid}"
            if title.startswith("ซีรีส์ ") and cand.get("title") and not cand["title"].startswith("ซีรีส์ "):
                title = cand["title"]

            lang = meta.get("lang") or cand.get("lang") or "พากย์ไทย"
            episodes = meta.get("episodes") or 0
            if episodes <= 0:
                # Skip dead/empty series pages that have 0 episodes
                continue

            poster_url = meta.get("poster_url") or cand.get("poster_url") or ""
            jpg_url = meta.get("jpg_url") or ""
            did = f"ry-{sid}"

            cover_path = ensure_poster_downloaded(sid, "", poster_url, jpg_url)
            synopsis = (
                meta.get("synopsis")
                or f"ซีรีส์สั้นเรื่อง {title} {lang} ({episodes} ตอนจบ) รับชมฟรี ไม่มีโฆษณา"
            )
            genres = infer_genres(title, synopsis, lang)

            entry = {
                "id": did,
                "series_id": sid,
                "provider": "rongyok",
                "title": title,
                "english_title": f"RongYok Series {sid}",
                "cover": cover_path,
                "remote_cover": poster_url or jpg_url,
                "genre": genres,
                "episodes": episodes,
                "views": "New",
                "language": f"{lang} (เต็มเรื่อง)",
                "synopsis": synopsis,
                "status": "จบแล้ว",
                "release_year": meta.get("release_year", 2026),
            }
            new_entries.append(entry)
            print(f"  + [NEW] ID {sid}: {title} ({episodes} ตอน) -> {cover_path}")

    # 3. Check existing dramas that need poster repair or metadata/episode sync
    to_repair = []
    for d in existing_dramas:
        sid = int(d.get("series_id") or str(d.get("id", "0")).replace("ry-", ""))
        cov = (d.get("cover") or "").lstrip("/")
        cov_abs = os.path.join(ROOT_DIR, cov.replace("/", os.sep)) if cov else ""
        poster_missing = not cov_abs or not os.path.exists(cov_abs) or os.path.getsize(cov_abs) < 500
        if sync_all_metadata or poster_missing or not d.get("episodes"):
            to_repair.append((d, poster_missing))

    updated_existing = 0
    posters_repaired = 0
    if to_repair:
        print(f"Syncing real episode counts & posters for {len(to_repair)} existing dramas...")
        repair_sids = [
            int(d.get("series_id") or str(d.get("id", "0")).replace("ry-", ""))
            for d, _ in to_repair
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=25) as pool:
            repair_metas = dict(zip(repair_sids, pool.map(fetch_series_metadata, repair_sids)))

        for d, poster_missing in to_repair:
            sid = int(d.get("series_id") or str(d.get("id", "0")).replace("ry-", ""))
            meta = repair_metas.get(sid) or {}
            changed = False

            if meta.get("episodes") and meta["episodes"] > 0:
                if d.get("episodes") != meta["episodes"]:
                    d["episodes"] = meta["episodes"]
                    changed = True

            if meta.get("synopsis"):
                cur_syn = d.get("synopsis") or ""
                if not cur_syn or "รับชมได้แบบเต็มเรื่องฟรี" in cur_syn or "ซีรีส์สั้นมาใหม่เรื่อง" in cur_syn:
                    d["synopsis"] = meta["synopsis"]
                    changed = True

            if meta.get("poster_url") or meta.get("jpg_url"):
                remote = meta.get("poster_url") or meta.get("jpg_url")
                if d.get("remote_cover") != remote:
                    d["remote_cover"] = remote
                    changed = True

            if poster_missing:
                home_poster = home_cands.get(sid, {}).get("poster_url", "")
                new_cov = ensure_poster_downloaded(
                    sid,
                    d.get("cover", ""),
                    meta.get("poster_url") or home_poster,
                    meta.get("jpg_url") or "",
                )
                if new_cov != d.get("cover"):
                    d["cover"] = new_cov
                    changed = True
                cov_check = os.path.join(ROOT_DIR, new_cov.lstrip("/").replace("/", os.sep))
                if os.path.exists(cov_check) and os.path.getsize(cov_check) > 500:
                    posters_repaired += 1

            if changed:
                updated_existing += 1

    # Combine & update catalog
    all_dramas = new_entries + existing_dramas
    catalog["dramas"] = all_dramas
    if all_dramas:
        catalog["featured"] = all_dramas[0]

    # Update provider label count
    total_count = len(all_dramas)
    for p in catalog.get("providers", []):
        if p.get("id") == "all":
            p["name"] = f"ทั้งหมด ({total_count} เรื่อง)"

    if new_entries or updated_existing > 0 or posters_repaired > 0:
        save_catalog(catalog)
        print(
            f"\n[SUCCESS] Added {len(new_entries)} new dramas, "
            f"updated {updated_existing} existing records, "
            f"repaired {posters_repaired} posters in {time.time() - t0:.1f}s."
        )
        print(f"Total catalog size: {total_count} dramas")
    else:
        print(f"\n[OK] Catalog is already up to date ({total_count} dramas, {time.time() - t0:.1f}s).")

    return {
        "added": len(new_entries),
        "updated": updated_existing,
        "posters_repaired": posters_repaired,
        "total": total_count,
    }


if __name__ == "__main__":
    sync_all = "--sync-all" in sys.argv
    run_sync(sync_all_metadata=sync_all)
