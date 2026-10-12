/**
 * Cloudflare Worker & Pages Advanced Mode Router
 * Handles Edge APIs for both GoSeries4K + Torbo007 (4K HLS) & RongYok (Short Dramas):
 * - /stream/:slug/index.m3u8 & /stream/:slug/segment
 * - /api/movies & /api/movies/:slug
 * - /api/play/:id/:ep, /api/episodes/:id, /api/feed, /api/search, /api/status
 * - /api/goseries/comments/:post_id
 * and serves static assets via env.ASSETS.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GOSERIES_BASE = 'https://goseries4k.com';
const TORBO_BASE = 'https://torbo007.com';

export class UsRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('target');
    const referer = url.searchParams.get('referer') || 'https://rongyok.com/';
    if (!targetUrl) {
      return new Response(JSON.stringify({ status: 400, body: 'Missing target' }), { status: 400 });
    }
    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const body = await resp.text();
    return new Response(JSON.stringify({ status: resp.status, body }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Range',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/stream/')) {
      return handleApiRequest(request, url, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function scrapeGoSeriesHtmlEdge(slug) {
  const cleanSlug = decodeURIComponent(slug.replace(/^gs-/, '').replace(/^\/+|\/+$/g, ''));
  const pageUrl = `${GOSERIES_BASE}/${encodeURIComponent(cleanSlug)}/`;
  const resp = await fetch(pageUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Referer': `${GOSERIES_BASE}/`,
    }
  });
  if (!resp.ok) return { md5: '', episodes: [], audio_tracks: [] };
  const html = await resp.text();

  const epIdToMd5 = {};
  const cacheMatch = html.match(/window\.miru_ep_cache\s*=\s*(\{[\s\S]*?\});/);
  if (cacheMatch) {
    try {
      const rawMap = JSON.parse(cacheMatch[1]);
      for (const [btnId, iframeHtml] of Object.entries(rawMap)) {
        const m = String(iframeHtml).match(/torbo007\.com\/embed\/([a-f0-9]{32})/);
        if (m) epIdToMd5[String(btnId)] = m[1];
      }
    } catch (e) {}
  }

  const episodes = [];
  const audioTracks = [];
  const groupRegex = /<div class="mp-epg-title">([^<]+)<\/div><div class="mp-epg-list">([\s\S]*?)<\/div><\/div>/g;
  let gMatch;
  while ((gMatch = groupRegex.exec(html)) !== null) {
    const rawLang = gMatch[1].trim();
    const langNorm = rawLang.includes('พากย์') ? 'พากย์ไทย' : (rawLang.includes('ซับ') ? 'ซับไทย' : rawLang);
    if (!audioTracks.includes(langNorm)) audioTracks.push(langNorm);

    const btnRegex = /data-id="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
    let bMatch;
    let idx = 1;
    while ((bMatch = btnRegex.exec(gMatch[2])) !== null) {
      const btnId = bMatch[1];
      const text = bMatch[2].replace(/<[^>]+>/g, '').trim();
      const numM = text.match(/(\d+)/);
      const epNum = numM ? parseInt(numM[1], 10) : idx;
      const md5 = epIdToMd5[btnId] || '';
      if (md5) {
        episodes.push({ episode: epNum, lang: langNorm, title: text || `EP ${epNum}`, md5 });
      }
      idx++;
    }
  }

  if (episodes.length === 0) {
    const directRegex = /torbo007\.com\\?\/embed\\?\/([a-f0-9]{32})/g;
    const seen = new Set();
    let dMatch;
    let idx = 1;
    while ((dMatch = directRegex.exec(html)) !== null) {
      if (!seen.has(dMatch[1])) {
        seen.add(dMatch[1]);
        episodes.push({ episode: idx, lang: 'พากย์ไทย', title: `EP ${idx}`, md5: dMatch[1] });
        idx++;
      }
    }
    if (episodes.length > 0) audioTracks.push('พากย์ไทย');
  }

  return {
    md5: episodes.length > 0 ? episodes[0].md5 : '',
    episodes,
    audio_tracks: audioTracks,
  };
}

async function requestTorboTokenEdge(md5) {
  const resp = await fetch(`${TORBO_BASE}/api/tokenplay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${TORBO_BASE}/embed/${md5}`,
      'Origin': TORBO_BASE,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ md5, parent: 'goseries4k.com' }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return {
    stream_id: data.stream_id || '',
    token: data.token || '',
    expires: data.expires || 0,
    sid: data.sid || data.session_id || '',
  };
}

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
      service: 'SO+ Edge API (RongYok + GoSeries4K + Torbo007)',
      version: '4.0',
      timestamp: Date.now()
    }), { headers: corsHeaders });
  }

  // 2. Torbo007 HLS M3U8 Proxy: /stream/:slug/index.m3u8
  const m3u8Match = url.pathname.match(/^\/(?:api\/)?stream\/([^\/]+)\/index\.m3u8$/);
  if (m3u8Match) {
    const slug = m3u8Match[1].replace(/^gs-/, '');
    let md5 = (url.searchParams.get('md5') || '').trim();
    const ep = parseInt(url.searchParams.get('ep') || '1', 10);
    const lang = (url.searchParams.get('lang') || '').trim();

    if (!/^[a-f0-9]{32}$/.test(md5)) {
      const scraped = await scrapeGoSeriesHtmlEdge(slug);
      const eps = scraped.episodes || [];
      let found = eps.find(e => e.episode === ep && (!lang || e.lang.includes(lang)));
      if (!found) found = eps.find(e => e.episode === ep) || eps[0];
      md5 = found ? found.md5 : scraped.md5;
    }

    if (!/^[a-f0-9]{32}$/.test(md5)) {
      return new Response(JSON.stringify({ status: false, error: 'Could not resolve md5' }), { status: 404, headers: corsHeaders });
    }

    const tok = await requestTorboTokenEdge(md5);
    if (!tok || !tok.token || !tok.stream_id) {
      return new Response(JSON.stringify({ status: false, error: 'Tokenplay failed' }), { status: 502, headers: corsHeaders });
    }

    const realM3u8Url = `${TORBO_BASE}/api/stream/${tok.stream_id}/index.m3u8?token=${tok.token}&expires=${tok.expires}&parent=goseries4k.com&sid=${tok.sid}`;
    const m3u8Resp = await fetch(realM3u8Url, {
      headers: {
        'Referer': `${TORBO_BASE}/embed/${md5}`,
        'Origin': TORBO_BASE,
        'User-Agent': USER_AGENT,
      }
    });
    if (!m3u8Resp.ok) {
      return new Response(JSON.stringify({ status: false, error: `Upstream M3U8 HTTP ${m3u8Resp.status}` }), { status: 502, headers: corsHeaders });
    }

    const m3u8Text = await m3u8Resp.text();
    const rewritten = m3u8Text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const absUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, realM3u8Url).toString();
        return `/stream/${slug}/segment?url=${encodeURIComponent(absUrl)}&md5=${md5}`;
      }
      return line;
    }).join('\n');

    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      }
    });
  }

  // 3. Torbo007 HLS Segment Proxy: /stream/:slug/segment
  const segMatch = url.pathname.match(/^\/(?:api\/)?stream\/([^\/]+)\/segment$/);
  if (segMatch) {
    const targetUrl = url.searchParams.get('url') || '';
    const md5 = url.searchParams.get('md5') || '77c5d4d1c67567ab6abc3b9875050a4e';
    if (!targetUrl) {
      return new Response('Missing url', { status: 400 });
    }

    const segHeaders = {
      'Referer': `${TORBO_BASE}/embed/${md5}`,
      'Origin': TORBO_BASE,
      'User-Agent': USER_AGENT,
    };
    const rangeHdr = request.headers.get('Range');
    if (rangeHdr) segHeaders['Range'] = rangeHdr;

    const segResp = await fetch(targetUrl, { headers: segHeaders });
    if (!segResp.ok && segResp.status !== 206) {
      return new Response(null, { status: segResp.status });
    }

    const buf = new Uint8Array(await segResp.arrayBuffer());
    let sliceOffset = 0;
    if (buf.length > 512 && buf[0] !== 0x47) {
      const limit = Math.min(buf.length - 376, 2048);
      for (let off = 0; off < limit; off++) {
        if (buf[off] === 0x47 && buf[off + 188] === 0x47 && buf[off + 376] === 0x47) {
          sliceOffset = off;
          break;
        }
      }
    }

    return new Response(sliceOffset > 0 ? buf.subarray(sliceOffset) : buf, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      }
    });
  }

  // 4. Video Play Proxy: /api/play/:id/:ep
  const playMatch = url.pathname.match(/^\/api\/play\/([^\/]+)\/(\d+)/);
  if (playMatch) {
    const dramaId = decodeURIComponent(playMatch[1]);
    const ep = parseInt(playMatch[2], 10);
    const provider = url.searchParams.get('provider') || '';
    const lang = url.searchParams.get('lang') || '';
    let md5 = url.searchParams.get('md5') || '';

    if (dramaId.startsWith('gs-') || provider === 'goseries4k') {
      const cleanSlug = dramaId.replace(/^gs-/, '');
      if (!/^[a-f0-9]{32}$/.test(md5)) {
        const scraped = await scrapeGoSeriesHtmlEdge(cleanSlug);
        const eps = scraped.episodes || [];
        let found = eps.find(e => e.episode === ep && (!lang || e.lang.includes(lang)));
        if (!found) found = eps.find(e => e.episode === ep) || eps[0];
        md5 = found ? found.md5 : scraped.md5;
      }
      if (!md5) {
        return new Response(JSON.stringify({ status: false, error: 'MD5 not found for episode' }), { status: 404, headers: corsHeaders });
      }
      const streamUrl = `/stream/${cleanSlug}/index.m3u8?ep=${ep}&md5=${md5}${lang ? '&lang=' + encodeURIComponent(lang) : ''}`;
      return new Response(JSON.stringify({
        status: true,
        stream: { streamUrl, format: 'HLS', md5 },
        source: 'torbo007_cf_edge'
      }), { status: 200, headers: corsHeaders });
    }

    const seriesId = dramaId.startsWith('ry-') ? dramaId.substring(3) : dramaId;
    const watchUrl = `https://rongyok.com/watch/?series_id=${seriesId}`;
    const playUrl = `https://rongyok.com/watch/playseries.php?series_id=${seriesId}&ep=${ep}`;

    try {
      const resp = await fetch(playUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': watchUrl,
          'Origin': 'https://rongyok.com',
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        }
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data && data.ok && data.video_url) {
          return new Response(JSON.stringify({
            status: true,
            stream: { streamUrl: data.video_url, format: 'MP4' },
            source: 'rongyok_cf_edge',
            series_id: seriesId,
            ep
          }), { status: 200, headers: corsHeaders });
        }
      }
      return new Response(JSON.stringify({ status: false, error: `Upstream HTTP ${resp.status}` }), { status: 502, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ status: false, error: err.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 5. Episode List: /api/episodes/:id
  const epMatch = url.pathname.match(/^\/api\/episodes\/([^\/]+)/);
  if (epMatch) {
    const dramaId = decodeURIComponent(epMatch[1]);
    const provider = url.searchParams.get('provider') || '';

    if (dramaId.startsWith('gs-') || provider === 'goseries4k') {
      const cleanSlug = dramaId.replace(/^gs-/, '');
      const scraped = await scrapeGoSeriesHtmlEdge(cleanSlug);
      const episodesByLang = {};
      for (const ep of scraped.episodes || []) {
        const lKey = ep.lang || 'พากย์ไทย';
        if (!episodesByLang[lKey]) episodesByLang[lKey] = [];
        episodesByLang[lKey].push({
          episode: ep.episode,
          title: ep.title,
          lang: lKey,
          md5: ep.md5,
          duration: '45:00',
          is_free: true,
        });
      }
      const tracks = scraped.audio_tracks.length ? scraped.audio_tracks : Object.keys(episodesByLang);
      const activeLang = tracks[0] || 'พากย์ไทย';
      return new Response(JSON.stringify({
        status: true,
        provider: 'goseries4k',
        slug: cleanSlug,
        audio_tracks: tracks,
        active_lang: activeLang,
        episodes_by_lang: episodesByLang,
        episodes: episodesByLang[activeLang] || [],
        source: 'goseries4k_edge'
      }), { status: 200, headers: corsHeaders });
    }

    const seriesId = dramaId.startsWith('ry-') ? dramaId.substring(3) : dramaId;
    let epCount = 0;
    let source = 'rongyok_cf_edge';
    try {
      const resp = await fetch(`https://rongyok.com/watch/?series_id=${seriesId}`, {
        headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://rongyok.com/' }
      });
      if (resp.ok) {
        const html = await resp.text();
        const m = html.match(/const\s+seriesData\s*=\s*(\{.*?\});\s*\n/s);
        if (m) {
          const parsed = JSON.parse(m[1]);
          if (Array.isArray(parsed.episodes) && parsed.episodes.length > 0) epCount = parsed.episodes.length;
          else if (parsed.episodes_count) epCount = parseInt(parsed.episodes_count, 10);
        }
      }
    } catch (e) {}

    if (!epCount) epCount = 60;
    const episodes = Array.from({ length: epCount }, (_, i) => ({
      episode: i + 1,
      title: `ตอนที่ ${i + 1}`,
      duration: '1:30',
      is_free: true
    }));

    return new Response(JSON.stringify({ status: true, series_id: seriesId, episodes, source }), { status: 200, headers: corsHeaders });
  }

  // 6. GoSeries4K Comments Proxy: /api/goseries/comments/:post_id
  const commentMatch = url.pathname.match(/^\/api\/goseries\/comments\/(\d+)/);
  if (commentMatch) {
    const postId = commentMatch[1];
    try {
      const r = await fetch(`${GOSERIES_BASE}/wp-json/mov/v1/comments/${postId}?page=1&_locale=th&_=${Date.now()}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Referer': `${GOSERIES_BASE}/` }
      });
      if (r.ok) {
        return new Response(await r.text(), { status: 200, headers: corsHeaders });
      }
    } catch (e) {}
    return new Response(JSON.stringify({ success: false, data: { comments: [] } }), { status: 200, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ status: false, error: 'Endpoint not found' }), {
    status: 404,
    headers: corsHeaders
  });
}
