/**
 * POST /api/criar-agendamento — Edge Function (Cloudflare Pages)
 * Recebe: { "horarios_id": string, "nome_cliente": string }
 *
 * Fluxo:
 * 1. Verifica se o horário existe e está com disponivel = true.
 * 2. Se NÃO estiver disponível, retorna aviso de que o horário acabou de ser ocupado.
 * 3. Se ESTIVER disponível, atualiza o horário para disponivel = false e cria registro em agendamentos.
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  try {
    const env = context?.env || {};
    const base = env.SUPABASE_URL;
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;

    if (!base || !key) {
      return json({ error: "Configuração do Supabase ausente nas variáveis de ambiente." }, 500);
    }

    const body = await context.request.json().catch(() => ({}));
    const horarios_id = body.horarios_id || body.horario_id;
    const nome_cliente = typeof body.nome_cliente === "string" ? body.nome_cliente.trim() : (body.nome || "").trim();

    if (!horarios_id) {
      return json({ error: "Campo 'horarios_id' é obrigatório." }, 400);
    }

    if (!nome_cliente || nome_cliente.length < 2) {
      return json({ error: "Campo 'nome_cliente' é obrigatório (mínimo de 2 caracteres)." }, 400);
    }

    const headers = {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=representation",
    };

    // 1. Consulta o horário na tabela horarios
    const getRes = await fetch(
      `${base}/rest/v1/horarios?id=eq.${encodeURIComponent(horarios_id)}&select=id,dia,horario,disponivel`,
      { headers }
    );

    if (!getRes.ok) {
      const errText = await getRes.text().catch(() => "");
      return json({ error: "Falha ao consultar horário.", details: errText }, getRes.status);
    }

    const slots = await getRes.json().catch(() => []);
    const slot = slots && slots[0];

    if (!slot) {
      return json({ error: "Horário informado não foi encontrado." }, 404);
    }

    // Se NÃO estiver disponível, avisa que acabou de ser ocupado
    if (!slot.disponivel) {
      return json(
        {
          success: false,
          error: "Este horário acabou de ser ocupado. Por favor, escolha outro horário.",
          disponivel: false,
        },
        409
      );
    }

    // 2. Se ESTIVER disponível:
    // Atualiza atomicamente o horário para disponivel = false
    const patchRes = await fetch(
      `${base}/rest/v1/horarios?id=eq.${encodeURIComponent(horarios_id)}&disponivel=eq.true`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ disponivel: false }),
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => "");
      return json({ error: "Falha ao atualizar status do horário.", details: errText }, patchRes.status);
    }

    const updatedRows = await patchRes.json().catch(() => []);
    if (!updatedRows || updatedRows.length === 0) {
      // Outro cliente ocupou no mesmo instante
      return json(
        {
          success: false,
          error: "Este horário acabou de ser ocupado. Por favor, escolha outro horário.",
          disponivel: false,
        },
        409
      );
    }

    // 3. Cria registro na tabela agendamentos
    const insertRes = await fetch(`${base}/rest/v1/agendamentos`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        horarios_id: horarios_id,
        nome_cliente: nome_cliente,
        cliente_nome: nome_cliente,
        status: "confirmado",
      }),
    });

    if (!insertRes.ok) {
      // Reverte disponibilidade do horário
      await fetch(`${base}/rest/v1/horarios?id=eq.${encodeURIComponent(horarios_id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ disponivel: true }),
      });

      const errText = await insertRes.text().catch(() => "");
      return json({ error: "Falha ao registrar agendamento.", details: errText }, insertRes.status);
    }

    const createdRows = await insertRes.json().catch(() => []);
    const agendamento = createdRows && createdRows[0];

    return json(
      {
        success: true,
        message: "Agendamento confirmado com sucesso!",
        agendamento,
        horario: updatedRows[0],
      },
      201
    );
  } catch (err) {
    return json({ error: "Erro interno ao processar agendamento.", details: String(err) }, 500);
  }
}
