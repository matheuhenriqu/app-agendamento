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
 * Tools (modelo padrão: openai/gpt-oss-120b, configurável via GROQ_MODEL):
 * - verificar_disponibilidade { data: "YYYY-MM-DD" }
 * - criar_agendamento { cliente_nome, cliente_telefone, servico_id, data_hora }
 */

const SYSTEM_PROMPT = [
  "Você é a atendente virtual de WhatsApp de um pequeno negócio (salão/barbearia).",
  "Seja ágil e objetiva: no máximo 2 a 3 frases curtas por resposta.",
  "HOJE é a data atual informada no contexto. Resolva datas relativas (hoje, amanhã, dia 12) para YYYY-MM-DD.",
  "Fluxo: 1) descubra serviço + data; 2) SEMPRE chame verificar_disponibilidade antes de oferecer horário; 3) colete nome + telefone; 4) só então chame criar_agendamento.",
  "REGRA DE OURO: se o usuário perguntar sobre horários, disponibilidade, vagas ou 'quando tem horário', CHAME verificar_disponibilidade IMEDIATAMENTE e responda SOMENTE após o retorno da tool, usando os horários reais retornados.",
  "Nunca liste serviços fora do catálogo informado no contexto. Nunca invente horários livres, preços ou IDs de serviço.",
  "Para criar o agendamento você precisa dos 4 campos. Se faltar algo, peça só o que falta (1 pergunta por vez).",
  "data_hora deve ser ISO com fuso de São Paulo, ex.: 2026-09-15T14:30:00-03:00.",
  "Após a tool retornar, resuma o resultado em até 3 frases curtas, com tom cordial (máx. 1 emoji).",
].join(" ");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Modelo configurável via env (Groq descontinuou o llama-3.3-70b-versatile).
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
function groqModel(env) {
  return env?.GROQ_MODEL || DEFAULT_GROQ_MODEL;
}
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

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function supaCfg(env) {
  const base = (env?.SUPABASE_URL || "").replace(/\/+$/, "");
  // JWT anon primeiro (carrega claim role:anon); publishable como fallback.
  const key = env?.SUPABASE_ANON_KEY || env?.SUPABASE_PUBLISHABLE_KEY || "";
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
async function toolCriarAgendamento(env, args, extras) {
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
    `${base}/rest/v1/servicos?id=eq.${encodeURIComponent(servicoId)}&select=id,nome,preco,ativo`,
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

  // Notifica o dono no Telegram (não bloqueante; falha silenciosa).
  const pendingTelegram = notifyTelegram(extras, {
    nome,
    fone,
    servico: svc.nome,
    preco: svc.preco,
    dataHora,
    agendamentoId: row.id || null,
  });
  // Sem waitUntil (ex.: teste CLI), aguarda o envio p/ permitir verificação.
  if (pendingTelegram) await pendingTelegram;

  return JSON.stringify({
    ok: true,
    agendamento_id: row.id || null,
    resumo: `${nome} — ${svc.nome} em ${dia} às ${slot}`,
  });
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c]);
}

function waNumber(fone) {
  const digits = String(fone || "").replace(/\D/g, "");
  return digits.length <= 11 ? `55${digits}` : digits;
}

function fmtDataHoraSP(iso) {
  const d = new Date(iso);
  const data = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(d);
  return `${data} às ${hora}`;
}

/**
 * Dispara alerta de Telegram em segundo plano via context.waitUntil.
 * Nunca quebra o fluxo do chat: sem config → ignora; falha → console.error.
 * extras = { context, dbg } repassado pelo onRequestPost (opcional).
 */
function notifyTelegram(extras, info) {
  const context = extras?.context;
  const env = context?.env || extras?.env || {};
  const dbg = extras?.dbg;
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    if (dbg) dbg.telegram = "skipped";
    return;
  }
  const preco = Number(info.preco || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  const wa = waNumber(info.fone);
  const text =
    `🗓 <b>Novo Agendamento Confirmado!</b>\n` +
    `<b>Cliente:</b> ${escHtml(info.nome)}\n` +
    `<b>Telefone:</b> <a href="https://wa.me/${wa}">${escHtml(info.fone)}</a>\n` +
    `<b>Serviço:</b> ${escHtml(info.servico)} — ${escHtml(preco)}\n` +
    `<b>Data e Horário:</b> ${escHtml(fmtDataHoraSP(info.dataHora))}` +
    (info.agendamentoId ? `\n<b>ID:</b> <code>${escHtml(info.agendamentoId)}</code>` : "");

  const task = (async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error(`[chat] Telegram sendMessage falhou (HTTP ${res.status}): ${t.slice(0, 200)}`);
        if (dbg) dbg.telegram = `failed:${res.status}`;
      } else if (dbg) {
        dbg.telegram = "sent";
      }
    } catch (e) {
      console.error(`[chat] Telegram erro: ${String(e).slice(0, 200)}`);
      if (dbg) dbg.telegram = "error";
    }
  })();

  // Cloudflare: responde ao cliente sem esperar o Telegram.
  if (typeof context?.waitUntil === "function") context.waitUntil(task);
  else return task; // fallback (ex.: teste CLI): chamador pode aguardar
}

async function dispatchTool(env, name, args, extras) {
  if (name === "verificar_disponibilidade") return toolVerificarDisponibilidade(env, args);
  if (name === "criar_agendamento") return toolCriarAgendamento(env, args, extras);
  return JSON.stringify({ erro: `Tool desconhecida: ${name}` });
}

const MAX_GROQ_ATTEMPTS = 3;
const GROQ_BACKOFF_BASE_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groqError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.apiError = message;
  // Retentável: falha de rede (502), rate limit (429) e 5xx.
  // 4xx (auth inválida, modelo inexistente etc.) falham direto, sem retry.
  err.retryable = status === 502 || status === 429 || (status >= 500 && status <= 599);
  return err;
}

function isEmptyMessage(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return true;
  const hasContent = typeof msg.content === "string" && msg.content.trim().length > 0;
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  return !hasContent && !hasTools;
}

async function callGroq(apiKey, model, messages, withTools) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_GROQ_ATTEMPTS; attempt++) {
    try {
      let res;
      try {
        res = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.6,
            max_tokens: 300,
            ...(withTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
          }),
        });
      } catch (networkErr) {
        throw groqError(`Erro na API Groq: falha de rede (${String(networkErr).slice(0, 200)})`, 502);
      }
      if (!res.ok) {
        const groqErrText = await res.text().catch(() => "").then((t) => t.slice(0, 500));
        const err = groqError(`Erro na API Groq: ${groqErrText || `HTTP ${res.status}`}`, res.status);
        // 400 tool_use_failed = o modelo gerou JSON inválido (falha transitória
        // do próprio modelo, não erro do cliente) → vale retentar.
        if (res.status === 400 && groqErrText.includes("tool_use_failed")) {
          err.retryable = true;
        }
        throw err;
      }
      const data = await res.json().catch(() => ({}));
      if (isEmptyMessage(data)) {
        throw groqError("Erro na API Groq: resposta vazia (sem content nem tool_calls).", 502);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const canRetry = err?.retryable === true && attempt < MAX_GROQ_ATTEMPTS;
      if (!canRetry) throw err;
      const delay = GROQ_BACKOFF_BASE_MS * 2 ** (attempt - 1); // 500ms, 1000ms
      console.warn(
        `[chat] Groq tentativa ${attempt}/${MAX_GROQ_ATTEMPTS} falhou (HTTP ${err.status ?? "?"}): ${String(err.message).slice(0, 160)} — retry em ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function onRequestPost(context) {
  try {
    const env = context?.env || {};
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) {
      return json(
        {
          error:
            "Configuração ausente: GROQ_API_KEY não foi encontrada nas variáveis de ambiente do Cloudflare.",
        },
        500
      );
    }

    const body = await context.request.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];
    // debug:true → inclui { toolsUsed } na resposta (usado pelo script CLI de teste).
    const debug = body.debug === true;
    const toolsUsed = [];
    const toolCalls = [];
    const dbg = { telegram: "skipped" };
    const extras = { context, env, dbg };
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

    // Catálogo real de serviços (evita alucinação e fornece IDs p/ a tool).
    // Best-effort: se o Supabase falhar aqui, o chat segue sem catálogo.
    let catalogLine = "";
    try {
      const { base, key } = supaCfg(env);
      if (base && key) {
        const catRes = await fetch(
          `${base}/rest/v1/servicos?ativo=eq.true&select=id,nome,preco,duracao_minutos&order=nome`,
          { headers: sbHeaders(key) }
        );
        if (catRes.ok) {
          const list = await catRes.json().catch(() => []);
          if (Array.isArray(list) && list.length) {
            catalogLine =
              "\nCatálogo real (use SÓ estes; IDs para criar_agendamento):\n" +
              list
                .map((s) => `- ${s.nome} | id=${s.id} | R$ ${s.preco} | ${s.duracao_minutos}min`)
                .join("\n");
          }
        }
      }
    } catch {
      catalogLine = "";
    }

    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\nContexto: hoje é ${today} (${TZ}).${catalogLine}` },
      ...safeHistory,
      { role: "user", content: message.slice(0, 2000) },
    ];

    // Loop de tool calling: modelo -> tools -> modelo (até MAX_TOOL_ROUNDS).
    const model = groqModel(env);
    let data = await callGroq(apiKey, model, messages, true);
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
        let result;
        try {
          result = await dispatchTool(env, tc?.function?.name, args, extras);
          toolsUsed.push(tc?.function?.name || "desconhecida");
        } catch (toolErr) {
          result = JSON.stringify({
            erro: `Falha ao executar ${tc?.function?.name || "tool"}: ${String(toolErr).slice(0, 200)}`,
          });
          toolsUsed.push(`${tc?.function?.name || "desconhecida"}:erro`);
        }
        if (debug) {
          toolCalls.push({ name: tc?.function?.name || "?", args, result: String(result).slice(0, 1000) });
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      const lastRound = round === MAX_TOOL_ROUNDS - 1;
      data = await callGroq(apiKey, model, messages, !lastRound);
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Desculpe, não entendi. Pode repetir?";

    return json(debug ? { reply, debug: { toolsUsed, toolCalls, telegram: dbg.telegram } } : { reply });
  } catch (err) {
    // Erros vindos da Groq já trazem status + mensagem legível ("Erro na API Groq: ...").
    if (err?.apiError) {
      return json({ error: err.apiError }, err.status || 502);
    }
    const status = err?.status || 500;
    return json(
      { error: status === 502 ? "Erro na API Groq." : "Erro interno.", details: String(err?.details || err).slice(0, 300) },
      status
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

export async function onRequestGet() {
  return json({ error: "Use POST com { message, history }." }, 405);
}
