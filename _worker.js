/**
 * Cloudflare Worker & Pages Advanced Mode Router
 * Handles Edge APIs (/api/play, /api/episodes, /api/feed, /api/search, /api/status)
 * and serves static assets via env.ASSETS.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // Edge API Routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url, env);
    }

    // Serve Static Assets (HTML, CSS, JS, Posters, JSON)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleApiRequest(request, url, env) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // 1. Health Status: /api/status
  if (url.pathname === '/api/status') {
    return new Response(JSON.stringify({
      status: true,
      ok: true,
      service: 'RongYok Edge API',
      version: '2.1',
      timestamp: Date.now()
    }), { headers: corsHeaders });
  }

  // 2. Video Play Proxy: /api/play/:id/:ep
  const playMatch = url.pathname.match(/^\/api\/play\/([^\/]+)\/(\d+)/);
  if (playMatch) {
    const dramaId = playMatch[1];
    const ep = playMatch[2];
    const seriesId = dramaId.startsWith('ry-') ? dramaId.substring(3) : dramaId;

    const watchUrl = `https://rongyok.com/watch/?series_id=${seriesId}`;
    const playUrl = `https://rongyok.com/watch/playseries.php?series_id=${seriesId}&ep=${ep}`;
    
    const reqHeaders = new Headers();
    reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    reqHeaders.set('Referer', watchUrl);
    reqHeaders.set('Origin', 'https://rongyok.com');
    reqHeaders.set('Accept', 'application/json, text/plain, */*');
    reqHeaders.set('X-Requested-With', 'XMLHttpRequest');

    try {
      let resp = await fetch(playUrl, {
        method: 'GET',
        headers: reqHeaders,
        referrer: watchUrl,
        referrerPolicy: 'unsafe-url'
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data && data.ok && data.video_url) {
          return new Response(JSON.stringify({
            status: true,
            stream: { streamUrl: data.video_url, format: 'MP4' },
            source: 'rongyok_cf_edge',
            series_id: seriesId,
            ep: parseInt(ep, 10)
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Cache-Control': 'public, max-age=1200'
            }
          });
        }
      }
      return new Response(JSON.stringify({
        status: false,
        error: `Upstream returned HTTP ${resp.status}`,
        upstream_status: resp.status
      }), {
        status: 502,
        headers: corsHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        status: false,
        error: `Worker proxy error: ${err.message}`
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }

  // 3. Episode List: /api/episodes/:id
  const epMatch = url.pathname.match(/^\/api\/episodes\/([^\/]+)/);
  if (epMatch) {
    const dramaId = epMatch[1];
    const seriesId = dramaId.startsWith('ry-') ? dramaId.substring(3) : dramaId;

    let epCount = 60;
    try {
      const resp = await fetch(`https://rongyok.com/watch/?series_id=${seriesId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://rongyok.com/'
        }
      });
      if (resp.ok) {
        const html = await resp.text();
        const m = html.match(/const\s+seriesData\s*=\s*(\{.*?\});\s*\n/s);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed.episodes && Array.isArray(parsed.episodes) && parsed.episodes.length > 0) {
              epCount = parsed.episodes.length;
            } else if (parsed.episodes_count) {
              epCount = parseInt(parsed.episodes_count, 10);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    const episodes = [];
    for (let i = 1; i <= epCount; i++) {
      episodes.push({
        episode: i,
        title: `ตอนที่ ${i}`,
        duration: '1:30',
        is_free: true
      });
    }

    return new Response(JSON.stringify({
      status: true,
      series_id: seriesId,
      episodes: episodes,
      source: 'rongyok_cf_edge'
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=86400' // Cache 24 hours on Cloudflare Edge
      }
    });
  }

  // 4. Home Feed: /api/feed
  if (url.pathname === '/api/feed') {
    try {
      const langFilter = url.searchParams.get('lang') || 'all';
      const genreFilter = url.searchParams.get('genre') || 'ทั้งหมด';
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const limit = parseInt(url.searchParams.get('limit') || '48', 10);

      const seedReq = new Request(new URL('/data/seed_data.json', request.url));
      const seedResp = env.ASSETS ? await env.ASSETS.fetch(seedReq) : await fetch(seedReq);
      if (seedResp.ok) {
        const seed = await seedResp.json();
        let dramas = seed.dramas || [];

        if (langFilter === 'dubbed') {
          dramas = dramas.filter(d => (d.language && d.language.includes('พากย์ไทย')) || (d.genre && d.genre.includes('พากย์ไทย')));
        } else if (langFilter === 'subbed') {
          dramas = dramas.filter(d => (d.language && d.language.includes('ซับไทย')) || (d.genre && d.genre.includes('ซับไทย')));
        }

        if (genreFilter && genreFilter !== 'ทั้งหมด') {
          const gLower = genreFilter.toLowerCase();
          dramas = dramas.filter(d => d.genre && d.genre.some(g => g.toLowerCase().includes(gLower)));
        }

        const totalCount = dramas.length;
        const startIdx = (page - 1) * limit;
        const endIdx = startIdx + limit;
        const paginated = dramas.slice(startIdx, endIdx);

        return new Response(JSON.stringify({
          status: true,
          providers: seed.providers || [],
          genres: seed.genres || [],
          featured: seed.featured || paginated[0] || null,
          dramas: paginated,
          page,
          limit,
          total: totalCount,
          has_more: endIdx < totalCount
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ status: false, error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 5. Search: /api/search
  if (url.pathname === '/api/search') {
    const rawQuery = (url.searchParams.get('q') || '').trim();
    const q = rawQuery.toLowerCase();
    if (!q) {
      return new Response(JSON.stringify({ status: true, results: [] }), { headers: corsHeaders });
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    let matches = [];

    try {
      const seedReq = new Request(new URL('/data/seed_data.json', request.url));
      const seedResp = env.ASSETS ? await env.ASSETS.fetch(seedReq) : await fetch(seedReq);
      if (seedResp.ok) {
        const seed = await seedResp.json();
        matches = (seed.dramas || []).filter(d => {
          const title = (d.title || '').toLowerCase();
          const synopsis = (d.synopsis || '').toLowerCase();
          const genres = Array.isArray(d.genre) ? d.genre.map(g => g.toLowerCase()).join(' ') : '';
          const lang = (d.language || '').toLowerCase();
          const sid = String(d.series_id || d.id || '').toLowerCase();
          const combined = `${title} ${genres} ${lang} ${synopsis} ${sid}`;
          return combined.includes(q) || tokens.every(t => combined.includes(t));
        });
      }
    } catch (e) {}

    // Live RongYok AJAX search fallback when < 6 local matches
    if (matches.length < 6) {
      try {
        const liveResp = await fetch(`https://rongyok.com/search?ajax=load_more&keyword=${encodeURIComponent(rawQuery)}&offset=0`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': 'https://rongyok.com/search'
          }
        });
        if (liveResp.ok) {
          const liveData = await liveResp.json();
          const html = liveData.html || '';
          const cardRegex = /<a href=["']series\/(\d+)\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/g;
          let m;
          while ((m = cardRegex.exec(html)) !== null) {
            const sid = parseInt(m[1], 10);
            const cardContent = m[2];
            if (matches.some(item => item.series_id === sid)) continue;

            const titleM = cardContent.match(/alt=["']([^"']+)["']/);
            const title = titleM ? titleM[1] : `ซีรีส์ ${sid}`;
            const imgM = cardContent.match(/src=["']([^"']+)["']/);
            let poster = imgM ? imgM[1] : '';
            if (poster && !poster.startsWith('http')) {
              poster = `https://rongyok.com/${poster.replace(/^\/+/, '')}`;
            }
            const badgeM = cardContent.match(/>(พากย์ไทย|ซับไทย)</);
            const lang = badgeM ? badgeM[1] : 'พากย์ไทย';

            matches.push({
              id: `ry-${sid}`,
              series_id: sid,
              provider: 'rongyok',
              title,
              english_title: `RongYok Series ${sid}`,
              cover: poster || `https://rongyok.com/images/poster/${sid}.webp`,
              genre: ['หนังสั้นจีน', lang],
              rating: 9.5,
              episodes: 60,
              views: '1.2M',
              language: `${lang} (เต็มเรื่อง)`,
              synopsis: `ซีรีส์สั้นเรื่อง ${title} ${lang} รับชมฟรี`,
              status: 'จบแล้ว'
            });
          }
        }
      } catch (e) {}
    }

    return new Response(JSON.stringify({ status: true, results: matches }), {
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=1800' }
    });
  }

  return new Response(JSON.stringify({ status: false, error: 'Endpoint not found' }), {
    status: 404,
    headers: corsHeaders
  });
}
