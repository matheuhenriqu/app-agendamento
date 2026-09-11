import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Método não permitido. Envie uma requisição POST." }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Variáveis de ambiente do Supabase não configuradas." }),
        { status: 500, headers: corsHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const horarios_id = body.horarios_id ?? body.horario_id;
    const nome_cliente = (body.nome_cliente ?? body.nome ?? "").trim();

    if (!horarios_id) {
      return new Response(
        JSON.stringify({ error: "Campo 'horarios_id' é obrigatório." }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!nome_cliente || nome_cliente.length < 2) {
      return new Response(
        JSON.stringify({ error: "Campo 'nome_cliente' é obrigatório (mínimo de 2 caracteres)." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Verifica se o horário existe e se ainda está com disponivel = true
    const { data: slot, error: slotError } = await supabase
      .from("horarios")
      .select("id, dia, horario, disponivel")
      .eq("id", horarios_id)
      .maybeSingle();

    if (slotError) {
      return new Response(
        JSON.stringify({ error: "Erro ao consultar horário.", details: slotError.message }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!slot) {
      return new Response(
        JSON.stringify({ error: "Horário informado não foi encontrado." }),
        { status: 404, headers: corsHeaders }
      );
    }

    // Se NÃO estiver disponível, retorna aviso de que o horário acabou de ser ocupado
    if (!slot.disponivel) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Este horário acabou de ser ocupado. Por favor, escolha outro horário.",
          disponivel: false,
        }),
        { status: 409, headers: corsHeaders }
      );
    }

    // 2. Se ESTIVER disponível:
    // Atualiza atomicamente o horário para disponivel = false
    const { data: updatedSlot, error: updateError } = await supabase
      .from("horarios")
      .update({ disponivel: false })
      .eq("id", horarios_id)
      .eq("disponivel", true)
      .select()
      .maybeSingle();

    if (updateError || !updatedSlot) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Este horário acabou de ser ocupado. Por favor, escolha outro horário.",
          disponivel: false,
        }),
        { status: 409, headers: corsHeaders }
      );
    }

    // 3. Cria o registro na tabela agendamentos
    const { data: agendamento, error: insertError } = await supabase
      .from("agendamentos")
      .insert({
        horarios_id: horarios_id,
        nome_cliente: nome_cliente,
        cliente_nome: nome_cliente,
        status: "confirmado",
      })
      .select()
      .single();

    if (insertError) {
      // Reverte o status do horário para disponivel em caso de falha no agendamento
      await supabase.from("horarios").update({ disponivel: true }).eq("id", horarios_id);
      return new Response(
        JSON.stringify({ error: "Falha ao registrar agendamento.", details: insertError.message }),
        { status: 400, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Agendamento confirmado com sucesso!",
        agendamento,
        horario: updatedSlot,
      }),
      { status: 201, headers: corsHeaders }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
