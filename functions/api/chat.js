/**
 * POST /api/chat — Cloudflare Pages Function (proxy seguro da Groq + Tool Calling).
 *
 * Body esperado: { "message": string, "history": [{ role, content }] }
 * Retorno: { "reply": string }
 *
 * Segredos NUNCA vão para o frontend. Lidos de `context.env`:
 * - GROQ_API_KEY (secret)
 * - SUPABASE_URL (ex.: https://xxx.supabase.co)
 * - SUPABASE_PUBLISHABLE_KEY (aceita fallback SUPABASE_ANON_KEY)
 *
 * Tools (llama-3.3-70b-versatile):
 * - verificar_disponibilidade { data: "YYYY-MM-DD" }
 * - criar_agendamento { cliente_nome, cliente_telefone, servico_id, data_hora }
 */

const SYSTEM_PROMPT = [
  "Você é a atendente virtual de WhatsApp de um pequeno negócio (salão/barbearia).",
  "Seja ágil e objetiva: no máximo 2 a 3 frases curtas por resposta.",
  "HOJE é a data atual informada no contexto. Resolva datas relativas (hoje, amanhã, dia 12) para YYYY-MM-DD.",
  "Fluxo: 1) descubra serviço + data; 2) SEMPRE chame verificar_disponibilidade antes de oferecer horário; 3) colete nome + telefone; 4) só então chame criar_agendamento.",
  "Nunca confirme horário sem chamar verificar_disponibilidade. Nunca invente horários livres, preços ou IDs de serviço.",
  "Para criar o agendamento você precisa dos 4 campos. Se faltar algo, peça só o que falta (1 pergunta por vez).",
  "data_hora deve ser ISO com fuso de São Paulo, ex.: 2026-09-15T14:30:00-03:00.",
  "Após a tool retornar, resuma o resultado em até 3 frases curtas, com tom cordial (máx. 1 emoji).",
].join(" ");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const TZ = "America/Sao_Paulo";
const SLOT_MIN = 30;
const MAX_TOOL_ROUNDS = 3;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "verificar_disponibilidade",
      description:
        "Consulta os horários livres de um dia (YYYY-MM-DD), considerando expediente, almoço e agendamentos existentes. Use SEMPRE antes de oferecer ou confirmar horário.",
      parameters: {
        type: "object",
        properties: {
          data: {
            type: "string",
            description: "Dia no formato YYYY-MM-DD (ex.: 2026-09-15).",
          },
        },
        required: ["data"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "criar_agendamento",
      description:
        "Cria o agendamento no Supabase. Chame SOMENTE com os 4 campos confirmados pelo cliente.",
      parameters: {
        type: "object",
        properties: {
          cliente_nome: { type: "string", description: "Nome completo do cliente." },
          cliente_telefone: {
            type: "string",
            description: "Telefone/WhatsApp do cliente (só dígitos com DDD).",
          },
          servico_id: {
            type: "string",
            description: "UUID do serviço (tabela servicos).",
          },
          data_hora: {
            type: "string",
            description: "ISO com fuso, ex.: 2026-09-15T14:30:00-03:00.",
          },
        },
        required: ["cliente_nome", "cliente_telefone", "servico_id", "data_hora"],
        additionalProperties: false,
      },
    },
  },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function supaCfg(env) {
  const base = (env?.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env?.SUPABASE_PUBLISHABLE_KEY || env?.SUPABASE_ANON_KEY || "";
  return { base, key };
}

function sbHeaders(key) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(s + "T12:00:00");
  return !Number.isNaN(d.getTime());
}

function isValidUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmInSaoPaulo(iso) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(new Date(iso));
}

function dayRangeISO(data) {
  // Faixa do dia em -03:00 (São Paulo, sem horário de verão desde 2019).
  const d = new Date(data + "T12:00:00-03:00");
  const next = new Date(d);
  next.setDate(d.getDate() + 1);
  const fmt = (x) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(
      x.getDate()
    ).padStart(2, "0")}`;
  return {
    start: `${fmt(d)}T00:00:00-03:00`,
    end: `${fmt(next)}T00:00:00-03:00`,
    weekday: d.getDay(), // 0=domingo ... 6=sábado
  };
}

function normalizeDataHora(s) {
  let v = String(s || "").trim();
  // "2026-09-15 14:30" -> "2026-09-15T14:30:00-03:00"
  v = v.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v += ":00-03:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) v += "-03:00";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return v;
}

/** Executa verificar_disponibilidade via REST do Supabase. Retorna string JSON. */
async function toolVerificarDisponibilidade(env, args) {
  const { base, key } = supaCfg(env);
  if (!base || !key) return JSON.stringify({ erro: "Supabase não configurado no servidor." });
  const data = args?.data;
  if (!isValidDate(data)) {
    return JSON.stringify({ erro: "Data inválida. Use YYYY-MM-DD.", recebido: data ?? null });
  }
  const { start, end, weekday } = dayRangeISO(data);

  // 1) Expediente do dia da semana
  const cfgRes = await fetch(
    `${base}/rest/v1/configuracao_agenda?dia_semana=eq.${weekday}&select=*`,
    { headers: sbHeaders(key) }
  );
  if (!cfgRes.ok) {
    return JSON.stringify({ erro: "Falha ao ler expediente.", status: cfgRes.status });
  }
  const cfg = (await cfgRes.json().catch(() => []))[0];
  if (!cfg) {
    return JSON.stringify({ data, aberto: false, livres: [], motivo: "Fechado neste dia." });
  }

  // 2) Agendamentos do dia (ignora cancelados)
  const agRes = await fetch(
    `${base}/rest/v1/agendamentos?data_hora=gte.${encodeURIComponent(
      start
    )}&data_hora=lt.${encodeURIComponent(end)}&status=neq.cancelado&select=data_hora`,
    { headers: sbHeaders(key) }
  );
  if (!agRes.ok) {
    return JSON.stringify({ erro: "Falha ao ler agendamentos.", status: agRes.status });
  }
  const ags = await agRes.json().catch(() => []);
  const ocupados = new Set(
    (Array.isArray(ags) ? ags : []).map((a) => hhmmInSaoPaulo(a.data_hora))
  );

  // 3) Gera slots de 30min, excluindo almoço e ocupados
  const abre = toMin(String(cfg.abertura).slice(0, 5));
  const fecha = toMin(String(cfg.fechamento).slice(0, 5));
  const almI = cfg.almoco_inicio ? toMin(String(cfg.almoco_inicio).slice(0, 5)) : null;
  const almF = cfg.almoco_fim ? toMin(String(cfg.almoco_fim).slice(0, 5)) : null;
  const livres = [];
  const ocupadosList = [];
  for (let t = abre; t + SLOT_MIN <= fecha; t += SLOT_MIN) {
    if (almI !== null && almF !== null && t >= almI && t < almF) continue;
    const slot = toHHMM(t);
    if (ocupados.has(slot)) ocupadosList.push(slot);
    else livres.push(slot);
  }

  return JSON.stringify({
    data,
    aberto: true,
    expediente: { abertura: cfg.abertura, fechamento: cfg.fechamento },
    livres,
    ocupados: ocupadosList,
  });
}

/** Executa criar_agendamento via REST do Supabase. Retorna string JSON. */
async function toolCriarAgendamento(env, args) {
  const { base, key } = supaCfg(env);
  if (!base || !key) return JSON.stringify({ erro: "Supabase não configurado no servidor." });

  const nome = String(args?.cliente_nome || "").trim();
  const fone = String(args?.cliente_telefone || "").replace(/\D/g, "");
  const servicoId = String(args?.servico_id || "").trim();
  const dataHora = normalizeDataHora(args?.data_hora);

  if (nome.length < 2) return JSON.stringify({ erro: "cliente_nome inválido." });
  if (fone.length < 8) return JSON.stringify({ erro: "cliente_telefone inválido. Envie DDD + número." });
  if (!isValidUuid(servicoId)) return JSON.stringify({ erro: "servico_id inválido (UUID esperado)." });
  if (!dataHora) return JSON.stringify({ erro: "data_hora inválida. Use ISO ex.: 2026-09-15T14:30:00-03:00." });
  if (new Date(dataHora).getTime() < Date.now() - 5 * 60 * 1000) {
    return JSON.stringify({ erro: "data_hora está no passado." });
  }

  // Confere serviço existe e está ativo
  const svcRes = await fetch(
    `${base}/rest/v1/servicos?id=eq.${encodeURIComponent(servicoId)}&select=id,nome,ativo`,
    { headers: sbHeaders(key) }
  );
  if (!svcRes.ok) return JSON.stringify({ erro: "Falha ao validar serviço.", status: svcRes.status });
  const svc = (await svcRes.json().catch(() => []))[0];
  if (!svc) return JSON.stringify({ erro: "Serviço não encontrado." });
  if (svc.ativo === false) return JSON.stringify({ erro: "Serviço inativo." });

  // Checa conflito no dia (evita double-booking no mesmo HH:MM)
  const dia = dataHora.slice(0, 10);
  const disp = JSON.parse(await toolVerificarDisponibilidade(env, { data: dia }));
  if (disp.erro) return JSON.stringify({ erro: "Não foi possível validar disponibilidade.", detalhes: disp.erro });
  if (disp.aberto === false) return JSON.stringify({ erro: "Estabelecimento fechado nesta data." });
  const slot = hhmmInSaoPaulo(dataHora);
  if (!disp.livres.includes(slot)) {
    return JSON.stringify({ erro: `Horário ${slot} ocupado. Ofereça: ${(disp.livres.slice(0, 5)).join(", ") || "nenhum"}.` });
  }

  // Insere
  const insRes = await fetch(`${base}/rest/v1/agendamentos`, {
    method: "POST",
    headers: { ...sbHeaders(key), prefer: "return=representation" },
    body: JSON.stringify({
      cliente_nome: nome,
      cliente_telefone: fone,
      servico_id: servicoId,
      data_hora: dataHora,
      status: "confirmado",
    }),
  });
  if (!insRes.ok) {
    const t = await insRes.text().catch(() => "");
    return JSON.stringify({ erro: "Falha ao salvar agendamento.", status: insRes.status, detalhes: t.slice(0, 300) });
  }
  const row = (await insRes.json().catch(() => []))[0] || {};
  return JSON.stringify({
    ok: true,
    agendamento_id: row.id || null,
    resumo: `${nome} — ${svc.nome} em ${dia} às ${slot}`,
  });
}

async function dispatchTool(env, name, args) {
  if (name === "verificar_disponibilidade") return toolVerificarDisponibilidade(env, args);
  if (name === "criar_agendamento") return toolCriarAgendamento(env, args);
  return JSON.stringify({ erro: `Tool desconhecida: ${name}` });
}

async function callGroq(apiKey, messages, withTools) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 300,
      ...(withTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error("Falha na Groq.");
    err.status = 502;
    err.details = t.slice(0, 500);
    throw err;
  }
  return res.json().catch(() => ({}));
}

export async function onRequestPost(context) {
  try {
    const env = context?.env || {};
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return json({ error: "GROQ_API_KEY não configurada no servidor." }, 500);

    const body = await context.request.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];
    if (!message) return json({ error: "Campo 'message' é obrigatório." }, 400);

    const safeHistory = history
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
      )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    const today = new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).format(new Date());

    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\nContexto: hoje é ${today} (${TZ}).` },
      ...safeHistory,
      { role: "user", content: message.slice(0, 2000) },
    ];

    // Loop de tool calling: modelo -> tools -> modelo (até MAX_TOOL_ROUNDS).
    let data = await callGroq(apiKey, messages, true);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = data?.choices?.[0]?.message;
      const calls = msg?.tool_calls;
      if (!Array.isArray(calls) || calls.length === 0) break;

      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: calls,
      });

      for (const tc of calls) {
        let args = {};
        try {
          args = JSON.parse(tc?.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await dispatchTool(env, tc?.function?.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      const lastRound = round === MAX_TOOL_ROUNDS - 1;
      data = await callGroq(apiKey, messages, !lastRound);
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Desculpe, não entendi. Pode repetir?";

    return json({ reply });
  } catch (err) {
    const status = err?.status || 500;
    return json(
      { error: status === 502 ? "Falha na Groq." : "Erro interno.", details: String(err.details || err).slice(0, 300) },
      status
    );
  }
}

export async function onRequestGet() {
  return json({ error: "Use POST com { message, history }." }, 405);
}
