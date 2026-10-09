#!/usr/bin/env python3
"""
RongYok Auto-Update Engine
Fetches new drama releases from RongYok, downloads posters, and prepends to seed_data.json.
Runs locally or via GitHub Actions every 6 hours.
"""

import urllib.request
import urllib.parse
import json
import os
import re
import sys

# Force UTF-8 encoding
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
POSTERS_DIR = os.path.join(BASE_DIR, "static", "posters")
SEED_PATH = os.path.join(DATA_DIR, "seed_data.json")

os.makedirs(POSTERS_DIR, exist_ok=True)

RONGYOK_BASE = "https://rongyok.com"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
    'Referer': 'https://rongyok.com/',
    'Accept': 'text/html,application/json,*/*'
}

def load_catalog():
    if os.path.exists(SEED_PATH):
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading catalog: {e}")
    return {"providers": [], "genres": [], "featured": {}, "dramas": []}

def save_catalog(catalog):
    with open(SEED_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

def fetch_homepage_series():
    series_list = []
    try:
        req = urllib.request.Request(f"{RONGYOK_BASE}/", headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='replace')
        
        ld_blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL)
        for block in ld_blocks:
            try:
                data = json.loads(block)
                if data.get("@type") == "CollectionPage":
                    items = data.get("mainEntity", {}).get("itemListElement", [])
                    for item in items:
                        url = item.get("url", "")
                        name = item.get("name", "")
                        m = re.search(r'/series/(\d+)/', url)
                        if m:
                            series_list.append({"series_id": int(m.group(1)), "title": name})
            except Exception:
                pass
    except Exception as e:
        print(f"Failed to fetch homepage: {e}")
    return series_list

def fetch_search_updates():
    series_list = []
    headers = {**HEADERS, 'X-Requested-With': 'XMLHttpRequest', 'Referer': f"{RONGYOK_BASE}/search"}
    keywords = ['รัก', 'ประธาน', 'แค้น', 'เกิดใหม่', 'หมอ']
    
    for kw in keywords:
        try:
            url = f"{RONGYOK_BASE}/search?ajax=load_more&keyword={urllib.parse.quote(kw)}&offset=0"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode('utf-8', errors='replace'))
                html = data.get('html', '')
                cards = re.findall(r'<a href=["\']series/(\d+)/[^"\']*["\'][^>]*>(.*?)</a>', html, re.DOTALL)
                for sid, card in cards:
                    sid = int(sid)
                    title_m = re.search(r'alt=["\']([^"\']+)["\']', card)
                    title = title_m.group(1) if title_m else f"ซีรีส์ {sid}"
                    img_m = re.search(r'src=["\']([^"\']+)["\']', card)
                    poster = img_m.group(1) if img_m else ""
                    if poster and not poster.startswith("http"):
                        poster = f"{RONGYOK_BASE}/{poster.lstrip('/')}"
                    badge_m = re.search(r'>(พากย์ไทย|ซับไทย)<', card)
                    lang = badge_m.group(1) if badge_m else "พากย์ไทย"
                    series_list.append({"series_id": sid, "title": title, "poster": poster, "lang": lang})
        except Exception:
            pass
    return series_list

def download_image(url, target_path):
    try:
        parsed = urllib.parse.urlsplit(url)
        clean_path = urllib.parse.quote(parsed.path)
        safe_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, clean_path, parsed.query, parsed.fragment))
        req = urllib.request.Request(safe_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=8) as resp:
            content = resp.read()
            if len(content) > 500:
                with open(target_path, 'wb') as f:
                    f.write(content)
                return True
    except Exception:
        pass
    return False

def main():
    print("="*50)
    print("RongYok Auto-Update Engine Running...")
    print("="*50)

    catalog = load_catalog()
    existing_dramas = catalog.get("dramas", [])
    existing_ids = set(d.get("series_id") for d in existing_dramas)
    print(f"Current catalog size: {len(existing_dramas)} dramas")

    # Fetch recent updates
    discovered = {}
    for item in fetch_homepage_series():
        sid = item["series_id"]
        if sid not in existing_ids:
            discovered[sid] = item
            
    for item in fetch_search_updates():
        sid = item["series_id"]
        if sid not in existing_ids and sid not in discovered:
            discovered[sid] = item

    print(f"Discovered new drama candidates: {len(discovered)}")

    if not discovered:
        print("No new dramas found. Catalog is already up to date!")
        return

    new_entries = []
    for sid, item in discovered.items():
        title = item["title"]
        did = f"ry-{sid}"
        poster_url = item.get("poster") or f"{RONGYOK_BASE}/images/poster/{sid}.webp"
        lang = item.get("lang") or "พากย์ไทย"

        # Download poster
        local_poster = f"static/posters/{did}.webp"
        target_path = os.path.join(BASE_DIR, local_poster)
        download_image(poster_url, target_path)

        genres = ["หนังสั้นจีน", lang]
        if "ประธาน" in title: genres.append("ประธานบริษัท (CEO)")
        if "แค้น" in title: genres.append("แก้แค้น (Revenge)")
        if "รัก" in title: genres.append("รักโรแมนติก (Romance)")
        if "หมอ" in title: genres.append("แฟนตาซี (Fantasy)")
        if "เกิดใหม่" in title or "ย้อน" in title: genres.append("ย้อนเวลา / กำเนิดใหม่ (Rebirth)")

        entry = {
            "id": did,
            "series_id": sid,
            "provider": "rongyok",
            "title": title,
            "english_title": f"RongYok Series {sid}",
            "cover": f"/{local_poster}",
            "genre": list(set(genres)),
            "rating": 9.6,
            "episodes": 60,
            "views": "New",
            "language": f"{lang} (เต็มเรื่อง)",
            "synopsis": f"ซีรีส์สั้นมาใหม่เรื่อง {title} {lang} รับชมฟรี ไม่มีโฆษณา",
            "status": "จบแล้ว",
            "release_year": 2024
        }
        new_entries.append(entry)
        print(f"Added new series: [ID {sid}] {title}")

    # Prepend new entries to the top of the catalog
    catalog["dramas"] = new_entries + existing_dramas
    if new_entries:
        catalog["featured"] = new_entries[0]

    save_catalog(catalog)
    print(f"\nSuccessfully added {len(new_entries)} new dramas!")
    print(f"New total catalog size: {len(catalog['dramas'])} dramas")

if __name__ == "__main__":
    main()
