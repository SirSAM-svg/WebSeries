/**
 * Cloudflare Pages Function: /api/play/:id/:ep
 * Proxies video URL from RongYok playseries.php on Cloudflare Edge
 */

export async function onRequestGet(context) {
  const { id, ep } = context.params;
  const seriesId = id.startsWith('ry-') ? id.substring(3) : id;

  const watchUrl = `https://rongyok.com/watch/?series_id=${seriesId}`;
  const playUrl = `https://rongyok.com/watch/playseries.php?series_id=${seriesId}&ep=${ep}`;

  const reqHeaders = new Headers();
  reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124');
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

    if (resp.status === 403) {
      reqHeaders.set('Referer', 'https://rongyok.com/');
      resp = await fetch(playUrl, {
        method: 'GET',
        headers: reqHeaders,
        referrer: 'https://rongyok.com/',
        referrerPolicy: 'unsafe-url'
      });
    }

    if (!resp.ok) {
      return new Response(JSON.stringify({ status: false, error: `RongYok returned ${resp.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

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
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1200' // Cache 20 mins on edge
        }
      });
    }

    return new Response(JSON.stringify({ status: false, error: 'Video stream not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
