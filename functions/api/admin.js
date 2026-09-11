/**
 * Cloudflare Pages Function: /api/admin
 * Endpoint de controle seguro para o painel administrativo.
 *
 * Autenticação Server-Side via cabeçalho 'X-Admin-Pin' ou 'Authorization: Bearer <pin>'.
 * Nunca expõe o PIN nem chaves de serviço para o navegador do cliente.
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-admin-pin",
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function supaCfg(env) {
  const base = (env?.SUPABASE_URL || "").replace(/\/+$/, "");
  // Prioriza service_role key no backend se configurada; fallback p/ anon key
  const key = env?.SUPABASE_SERVICE_ROLE_KEY || env?.SUPABASE_ANON_KEY || env?.SUPABASE_PUBLISHABLE_KEY || "";
  return { base, key };
}

function sbHeaders(key) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    prefer: "return=representation",
  };
}

/** Comparação segura em tempo constante contra Timing Attacks */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

function authenticate(context) {
  const env = context?.env || {};
  const expectedPin = String(env.ADMIN_PIN || "1234").trim();

  const req = context.request;
  const pinHeader = req.headers.get("x-admin-pin") || "";
  const authHeader = req.headers.get("authorization") || "";

  let providedPin = pinHeader.trim();
  if (!providedPin && authHeader.toLowerCase().startsWith("bearer ")) {
    providedPin = authHeader.slice(7).trim();
  }

  if (!providedPin || !timingSafeEqualStr(providedPin, expectedPin)) {
    return false;
  }
  return true;
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || "");
}

function isValidUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
}

const ALLOWED_STATUSES = new Set(["pendente", "confirmado", "concluido", "cancelado"]);

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

export async function onRequest(context) {
  // 1. Verificação de Autenticação Server-Side
  if (!authenticate(context)) {
    return json({ error: "PIN de acesso inválido ou não fornecido." }, 401);
  }

  const method = context.request.method.toUpperCase();
  const env = context.env || {};
  const { base, key } = supaCfg(env);

  if (!base || !key) {
    return json({ error: "Configuração do Supabase ausente no servidor." }, 500);
  }

  // 2. Rota POST: Validação de PIN (Login check)
  if (method === "POST") {
    return json({ ok: true, message: "PIN autenticado com sucesso." });
  }

  // 3. Rota GET: Listagem de agendamentos por data
  if (method === "GET") {
    const url = new URL(context.request.url);
    const date = url.searchParams.get("date") || "";

    if (!isValidDate(date)) {
      return json({ error: "Parâmetro 'date' inválido. Use YYYY-MM-DD." }, 400);
    }

    // Calcula faixa de 24h para o fuso America/Sao_Paulo (-03:00)
    const start = `${date}T00:00:00-03:00`;
    const nextDate = new Date(date + "T12:00:00-03:00");
    nextDate.setDate(nextDate.getDate() + 1);
    const m = String(nextDate.getMonth() + 1).padStart(2, "0");
    const d = String(nextDate.getDate()).padStart(2, "0");
    const end = `${nextDate.getFullYear()}-${m}-${d}T00:00:00-03:00`;

    const sbUrl =
      `${base}/rest/v1/agendamentos?data_hora=gte.${encodeURIComponent(start)}` +
      `&data_hora=lt.${encodeURIComponent(end)}` +
      `&select=*,servicos(nome,preco)&order=data_hora.asc`;

    const res = await fetch(sbUrl, { headers: sbHeaders(key) });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return json(
        { error: "Falha ao consultar agendamentos no banco.", details: errText.slice(0, 200) },
        res.status
      );
    }

    const data = await res.json().catch(() => []);
    return json({ ok: true, date, agendamentos: Array.isArray(data) ? data : [] });
  }

  // 4. Rota PATCH: Atualização segura de status
  if (method === "PATCH") {
    const body = await context.request.json().catch(() => ({}));
    const id = String(body?.id || "").trim();
    const status = String(body?.status || "").trim().toLowerCase();

    if (!isValidUuid(id)) {
      return json({ error: "Campo 'id' inválido (UUID esperado)." }, 400);
    }
    if (!ALLOWED_STATUSES.has(status)) {
      return json(
        { error: `Status inválido. Permitidos: ${Array.from(ALLOWED_STATUSES).join(", ")}` },
        400
      );
    }

    const sbUrl = `${base}/rest/v1/agendamentos?id=eq.${encodeURIComponent(id)}`;
    const patchRes = await fetch(sbUrl, {
      method: "PATCH",
      headers: sbHeaders(key),
      body: JSON.stringify({ status }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => "");
      return json(
        { error: "Falha ao atualizar status no banco.", details: errText.slice(0, 200) },
        patchRes.status
      );
    }

    return json({ ok: true, id, status, updated_at: new Date().toISOString() });
  }

  return json({ error: "Método HTTP não permitido." }, 405);
}
