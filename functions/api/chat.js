/**
 * POST /api/chat — Cloudflare Pages Function (proxy seguro da Groq).
 *
 * Body esperado: { "message": string, "history": [{ role, content }] }
 * Retorno: { "reply": string }
 *
 * A chave NUNCA vai para o frontend. Ela é lida de `context.env.GROQ_API_KEY`
 * (secret configurado no Cloudflare Pages / .dev.vars local).
 */

const SYSTEM_PROMPT = [
  "Você é a atendente virtual de WhatsApp de um pequeno negócio (salão/barbearia).",
  "Seja ágil e objetiva: no máximo 2 a 3 frases curtas por resposta.",
  "Foco: informar horários livres e coletar nome, serviço e telefone para agendar.",
  "Se faltar alguma info (nome, serviço, data/horário, telefone), peça só o que falta.",
  "Quando tiver nome + serviço + data/horário + telefone, confirme o resumo em 2 frases.",
  "Nunca invente preços ou horários: diga que vai conferir na agenda.",
  "Use tom cordial, sem emojis em excesso (máx. 1).",
].join(" ");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost(context) {
  try {
    const apiKey = context?.env?.GROQ_API_KEY;
    if (!apiKey) {
      return json(
        { error: "GROQ_API_KEY não configurada no servidor." },
        500
      );
    }

    const body = await context.request.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return json({ error: "Campo 'message' é obrigatório." }, 400);
    }

    // Sanitiza histórico: só role/content válidos, limite de 20 turnos.
    const safeHistory = history
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
      )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...safeHistory,
          { role: "user", content: message.slice(0, 2000) },
        ],
        temperature: 0.6,
        max_tokens: 300,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => "");
      return json(
        { error: "Falha na Groq.", details: errText.slice(0, 500) },
        502
      );
    }

    const data = await groqRes.json().catch(() => ({}));
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Desculpe, não entendi. Pode repetir?";

    return json({ reply });
  } catch (err) {
    return json({ error: "Erro interno.", details: String(err).slice(0, 300) }, 500);
  }
}

// Qualquer método diferente de POST recebe 405 explícito.
export async function onRequestGet() {
  return json({ error: "Use POST com { message, history }." }, 405);
}
