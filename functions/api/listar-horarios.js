/**
 * GET /api/listar-horarios — Edge Function (Cloudflare Pages)
 * Busca na tabela horarios todos os registros com disponivel = true,
 * ordenados por dia e horario, retornando lista em JSON.
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  try {
    const env = context?.env || {};
    const base = env.SUPABASE_URL;
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;

    if (!base || !key) {
      return json({ error: "Configuração do Supabase ausente nas variáveis de ambiente." }, 500);
    }

    const endpoint = `${base}/rest/v1/horarios?disponivel=eq.true&select=id,dia,horario,disponivel&order=dia.asc,horario.asc`;

    const res = await fetch(endpoint, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return json({ error: "Falha ao consultar tabela horarios.", details: errText }, res.status);
    }

    const data = await res.json().catch(() => []);
    return json(Array.isArray(data) ? data : []);
  } catch (err) {
    return json({ error: "Erro interno ao listar horários.", details: String(err) }, 500);
  }
}
