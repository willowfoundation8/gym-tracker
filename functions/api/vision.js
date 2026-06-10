// functions/api/vision.js
// TEMPORARY: the GET handler makes a live test call to Anthropic and returns
// the exact status + response, so you can see what's failing. Remove it later.

export async function onRequestGet({ env }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return new Response(JSON.stringify({ keyLoaded: false }), { headers: { 'content-type': 'application/json' } });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 50, messages: [{ role: 'user', content: 'Say hi' }] }),
    });
    const body = await r.text();
    return new Response(JSON.stringify({ keyLoaded: true, anthropicStatus: r.status, anthropicBody: body }, null, 2), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ keyLoaded: true, fetchError: String(e) }), { headers: { 'content-type': 'application/json' } });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { messages } = await request.json();
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages }),
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}

