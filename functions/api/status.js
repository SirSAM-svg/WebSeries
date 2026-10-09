export async function onRequestGet(context) {
  return new Response(JSON.stringify({
    status: 'online',
    platform: 'Cloudflare Pages (Edge Workers)',
    provider: 'RongYok 100% Unlimited'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
