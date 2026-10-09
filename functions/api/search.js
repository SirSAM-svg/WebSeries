/**
 * Cloudflare Pages Function: /api/search
 * Fast edge search across 800+ catalog with live RongYok AJAX fallback
 */

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get('q') || '').trim();

  if (!query) {
    return new Response(JSON.stringify({ status: true, results: [] }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const qLower = query.toLowerCase();
  let matches = [];

  try {
    const dataUrl = new URL('/data/seed_data.json', context.request.url);
    const resp = await fetch(dataUrl);
    if (resp.ok) {
      const seed = await resp.json();
      const dramas = seed.dramas || [];
      matches = dramas.filter(d => 
        (d.title && d.title.toLowerCase().includes(qLower)) ||
        (d.synopsis && d.synopsis.toLowerCase().includes(qLower)) ||
        (d.genre && d.genre.some(g => g.toLowerCase().includes(qLower)))
      );
    }
  } catch (err) {
    console.error('Catalog search error:', err);
  }

  // If few matches, query RongYok live search
  if (matches.length < 4) {
    try {
      const searchUrl = `https://rongyok.com/search?ajax=load_more&keyword=${encodeURIComponent(query)}&offset=0`;
      const sResp = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://rongyok.com/search'
        }
      });

      if (sResp.ok) {
        const sData = await sResp.json();
        const html = sData.html || '';
        const regex = /<a href=["']series\/(\d+)\/[^"']*["'][^>]*>(.*?)<\/a>/gs;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const sid = parseInt(m[1], 10);
          if (matches.some(x => x.series_id === sid)) continue;

          const titleM = m[2].match(/alt=["']([^"']+)["']/);
          const title = titleM ? titleM[1] : `ซีรีส์ ${sid}`;

          const imgM = m[2].match(/src=["']([^"']+)["']/);
          let poster = imgM ? imgM[1] : '';
          if (poster && !poster.startsWith('http')) {
            poster = `https://rongyok.com/${poster.replace(/^\//, '')}`;
          }

          const badgeM = m[2].match(/>(พากย์ไทย|ซับไทย)</);
          const lang = badgeM ? badgeM[1] : 'พากย์ไทย';

          matches.push({
            id: `ry-${sid}`,
            series_id: sid,
            provider: 'rongyok',
            title: title,
            english_title: `RongYok Series ${sid}`,
            cover: poster || `/static/posters/ry-100309804.jpg`,
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
    } catch (e) {
      console.warn('Live search error:', e);
    }
  }

  return new Response(JSON.stringify({
    status: true,
    source: 'search_edge',
    query: query,
    results: matches
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800'
    }
  });
}
