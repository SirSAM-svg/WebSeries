/**
 * Cloudflare Pages Function: /api/feed
 * Returns catalog with audio and genre filters, pagination, and instant edge response
 */

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const langFilter = url.searchParams.get('lang') || 'all';
  const genreFilter = url.searchParams.get('genre') || 'ทั้งหมด';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = parseInt(url.searchParams.get('limit') || '48', 10);

  try {
    // Fetch seed_data.json from the current deployment
    const dataUrl = new URL('/data/seed_data.json', context.request.url);
    const resp = context.env.ASSETS
      ? await context.env.ASSETS.fetch(new Request(dataUrl))
      : await fetch(dataUrl);
    
    if (!resp.ok) {
      throw new Error(`Failed to load seed_data.json: ${resp.status}`);
    }

    const seed = await resp.json();
    let dramas = seed.dramas || [];

    // Filter audio / language
    if (langFilter === 'dubbed') {
      dramas = dramas.filter(d => (d.language && d.language.includes('พากย์ไทย')) || (d.genre && d.genre.includes('พากย์ไทย')));
    } else if (langFilter === 'subbed') {
      dramas = dramas.filter(d => (d.language && d.language.includes('ซับไทย')) || (d.genre && d.genre.includes('ซับไทย')));
    }

    // Filter genre
    if (genreFilter && genreFilter !== 'ทั้งหมด') {
      const gLower = genreFilter.toLowerCase();
      dramas = dramas.filter(d => d.genre && d.genre.some(g => g.toLowerCase().includes(gLower)));
    }

    const totalCount = dramas.length;
    const startIdx = (page - 1) * limit;
    const endIdx = startIdx + limit;
    const paginatedDramas = dramas.slice(startIdx, endIdx);

    return new Response(JSON.stringify({
      status: true,
      providers: seed.providers || [],
      genres: seed.genres || [],
      featured: seed.featured || paginatedDramas[0] || null,
      dramas: paginatedDramas,
      page: page,
      limit: limit,
      total: totalCount,
      has_more: endIdx < totalCount
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600' // Cache 1 hour
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ status: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
