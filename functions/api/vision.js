// functions/api/vision.js
// Includes a TEMPORARY GET handler to check if the API key is loaded.
// Remove the onRequestGet block once you've confirmed things work.

export async function onRequestGet({ env }) {
  const key = env.ANTHROPIC_API_KEY;
  return new Response(JSON.stringify({
    keyLoaded: !!key,
    keyLength: key ? key.length : 0,
    keyPrefix: key ? key.slice(0, 7) : null,
  }), { headers: { 'content-type': 'application/json' } });
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
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages }),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
