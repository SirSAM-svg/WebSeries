/**
 * Cloudflare Pages Function: /api/episodes/:id
 * Fetches real episode count and episode list for any series from RongYok watch page
 */

export async function onRequestGet(context) {
  const { id } = context.params;
  const seriesId = id.startsWith('ry-') ? id.substring(3) : id;

  const url = `https://rongyok.com/watch/?series_id=${seriesId}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
    'Referer': 'https://rongyok.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  let epCount = 0;
  let source = 'rongyok_cf_edge';

  try {
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const html = await resp.text();
      const match = html.match(/const\s+seriesData\s*=\s*(\{.*?\});\s*\n/s);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          if (data.episodes && Array.isArray(data.episodes) && data.episodes.length > 0) {
            epCount = data.episodes.length;
          } else if (data.episodes_count) {
            epCount = parseInt(data.episodes_count, 10);
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error(`Error resolving episodes for ${seriesId}:`, err);
  }

  if (!epCount) {
    try {
      const seedUrl = new URL('/data/seed_data.json', context.request.url);
      const seedResp = context.env && context.env.ASSETS
        ? await context.env.ASSETS.fetch(new Request(seedUrl))
        : await fetch(seedUrl);
      if (seedResp.ok) {
        const seed = await seedResp.json();
        const found = (seed.dramas || []).find(
          d => String(d.series_id) === String(seriesId) || d.id === `ry-${seriesId}`
        );
        if (found && found.episodes) {
          epCount = parseInt(found.episodes, 10);
          source = 'catalog';
        }
      }
    } catch (e) {}
  }

  if (!epCount) {
    epCount = 60;
    source = 'fallback';
  }

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
    source: source
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400' // Cache 24 hours on Cloudflare Edge
    }
  });
}
