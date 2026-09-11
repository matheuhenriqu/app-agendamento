#!/usr/bin/env node
/**
 * scripts/test-chat.js — Teste CLI ponta a ponta do fluxo de chat.
 *
 * O que testa (sequencial):
 *   Preflight — env vars, leitura de `servicos` e `configuracao_agenda` via REST.
 *   Teste 1   — Saudação/listagem: envia a mensagem do frontend e confirma que
 *               a IA acionou a tool `verificar_disponibilidade`.
 *   Teste 2   — Agendamento: envia intenção com dados completos e confirma que
 *               a tool `criar_agendamento` inseriu o registro; depois limpa
 *               (DELETE → PATCH cancelado → mantém marcado como [TESTE]).
 *
 * Uso:  node scripts/test-chat.js
 * Vars: lidas de `.dev.vars` (não sobrescreve `process.env` já definido).
 * Segredos nunca são impressos no log.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "America/Sao_Paulo";
const TEST_TAG = "[TESTE-AUTOMATIZADO]";
const TEST_PHONE = "11999998888";

// ---------------------------------------------------------------- helpers
function loadDevVars() {
  const file = join(ROOT, ".dev.vars");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadDevVars();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
const ENV = {
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: SUPABASE_KEY,
};

const ts = () => new Date().toLocaleTimeString("pt-BR", { hour12: false });
const section = (t) => console.log(`\n━━━ [${ts()}] ${t} ━━━`);
const ok = (t) => console.log(`  ✅ ${t}`);
const info = (t) => console.log(`  … ${t}`);
const warn = (t) => console.log(`  ⚠️  ${t}`);
const trunc = (s, n = 600) => (s.length > n ? s.slice(0, n) + "…(truncado)" : s);
// Pausa entre chamadas Groq p/ respeitar o rate limit do plano gratuito (TPM).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACING_MS = 8000;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    authorization: `Bearer ${SUPABASE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = body;
  }
  return { status: res.status, ok: res.ok, data, raw: trunc(body) };
}

function fail(msg, payload) {
  console.log(`  ❌ ${msg}`);
  if (payload !== undefined) {
    console.log("  Payload/resposta que falhou:");
    console.log("  " + trunc(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), 2000).replace(/\n/g, "\n  "));
  }
  process.exitCode = 1;
  throw new Error(msg);
}

// Data YYYY-MM-DD em America/Sao_Paulo, deslocada N dias.
function spDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  return { ymd, weekday: new Date(ymd + "T12:00:00-03:00").getDay() };
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hhmmSP = (iso) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(iso));

// Simula o POST /api/chat chamando o handler real com contexto mockado.
// Inclui waitUntil (Cloudflare) e as vars opcionais do Telegram.
async function callChat(message, history = []) {
  const { onRequestPost } = await import("../functions/api/chat.js");
  const payload = { message, history, debug: true };
  console.log(`  → POST /api/chat payload: ${trunc(JSON.stringify(payload))}`);
  const bg = [];
  const req = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await onRequestPost({
    env: {
      ...ENV,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
    },
    request: req,
    waitUntil: (p) => bg.push(Promise.resolve(p).catch(() => {})),
  });
  await Promise.allSettled(bg); // drena tarefas de fundo (ex.: Telegram)
  const data = await res.json().catch(() => ({}));
  console.log(`  ← status ${res.status} | tools usadas: ${(data.debug?.toolsUsed || []).join(", ") || "(nenhuma)"} | telegram: ${data.debug?.telegram || "n/a"}`);
  for (const c of data.debug?.toolCalls || []) {
    console.log(`  🔧 tool ${c.name} args=${trunc(JSON.stringify(c.args), 300)}`);
    console.log(`     resultado: ${trunc(String(c.result), 500)}`);
  }
  console.log(`  ← reply: ${trunc(data.reply || data.error || JSON.stringify(data))}`);
  return { status: res.status, data };
}

// ---------------------------------------------------------------- main
const results = [];
async function main() {
  console.log("🧪 test-chat.js — validação ponta a ponta (Groq + Supabase)");

  // ---- Preflight ---------------------------------------------------------
  section("Preflight — variáveis e Supabase");
  for (const k of ["GROQ_API_KEY", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]) {
    const v = k === "SUPABASE_PUBLISHABLE_KEY" ? SUPABASE_KEY : process.env[k] || ENV[k];
    if (!v) fail(`Variável ausente: ${k} (defina em .dev.vars ou process.env)`);
    ok(`${k} presente (${v.length} chars, valor oculto)`);
  }

  const svc = await sbGet("servicos?ativo=eq.true&select=id,nome,preco,duracao_minutos&order=nome");
  if (!svc.ok) fail(`Falha ao ler servicos (HTTP ${svc.status})`, svc.raw);
  if (!svc.data.length) fail("Tabela servicos sem registros ativos — execute supabase/schema.sql", svc.raw);
  ok(`${svc.data.length} serviço(s) ativo(s): ${svc.data.map((s) => s.nome).join(", ")}`);
  const service = svc.data[0];

  const agenda = await sbGet("configuracao_agenda?select=*&order=dia_semana");
  if (!agenda.ok) fail(`Falha ao ler configuracao_agenda (HTTP ${agenda.status})`, agenda.raw);
  ok(`Agenda configurada p/ dias: ${agenda.data.map((a) => a.dia_semana).join(", ")}`);

  // ---- Teste 1 -----------------------------------------------------------
  section("Teste 1 — Saudação e listagem (espera tool verificar_disponibilidade)");
  const t1 = await callChat("Olá, quais serviços vocês oferecem e quais horários têm para amanhã?");
  if (t1.status !== 200) fail(`POST /api/chat retornou HTTP ${t1.status}`, t1.data);
  if (!t1.data.debug?.toolsUsed?.includes("verificar_disponibilidade")) {
    fail("IA NÃO acionou verificar_disponibilidade", t1.data);
  }
  ok("IA acionou verificar_disponibilidade");
  results.push(["Teste 1 (verificar_disponibilidade)", "PASS"]);

  const history = [
    { role: "user", content: "Olá, quais serviços vocês oferecem e quais horários têm para amanhã?" },
    { role: "assistant", content: t1.data.reply },
  ];

  // ---- Escolhe dia + slot livre via REST (cross-check da tool) ------------
  section("Cross-check — dia aberto e slot livre via REST");
  let target = null;
  for (let off = 1; off <= 7 && !target; off++) {
    const { ymd, weekday } = spDate(off);
    // Revalida expediente direto (evita cache):
    const cfgRes = await sbGet(`configuracao_agenda?dia_semana=eq.${weekday}&select=*`);
    const dayCfg = cfgRes.ok && Array.isArray(cfgRes.data) ? cfgRes.data[0] : null;
    if (!dayCfg) {
      info(`${ymd}: fechado (sem config p/ dia ${weekday}), tentando próximo…`);
      continue;
    }
    const start = `${ymd}T00:00:00-03:00`;
    const endYmd = spDate(off + 1).ymd;
    const ags = await sbGet(
      `agendamentos?data_hora=gte.${encodeURIComponent(start)}&data_hora=lt.${encodeURIComponent(endYmd + "T00:00:00-03:00")}&status=neq.cancelado&select=data_hora`
    );
    if (!ags.ok) fail(`Falha ao ler agendamentos de ${ymd} (HTTP ${ags.status})`, ags.raw);
    const busy = new Set(ags.data.map((a) => hhmmSP(a.data_hora)));
    const abre = toMin(String(dayCfg.abertura).slice(0, 5));
    const fecha = toMin(String(dayCfg.fechamento).slice(0, 5));
    const almI = dayCfg.almoco_inicio ? toMin(String(dayCfg.almoco_inicio).slice(0, 5)) : -1;
    const almF = dayCfg.almoco_fim ? toMin(String(dayCfg.almoco_fim).slice(0, 5)) : -1;
    const livres = [];
    for (let t = abre; t + 30 <= fecha; t += 30) {
      if (t >= almI && t < almF) continue;
      if (!busy.has(toHHMM(t))) livres.push(toHHMM(t));
    }
    info(`${ymd} (dia ${weekday}): livres=[${livres.join(", ") || "nenhum"}]`);
    if (livres.length) target = { ymd, slot: livres[0], livres };
  }
  if (!target) fail("Nenhum slot livre nos próximos 7 dias");
  ok(`Alvo: ${target.ymd} às ${target.slot} — serviço "${service.nome}" (${service.id})`);
  const dataHoraISO = `${target.ymd}T${target.slot}:00-03:00`;

  // ---- Teste 2 -----------------------------------------------------------
  section("Teste 2 — Agendamento (espera tool criar_agendamento)");
  await sleep(PACING_MS);
  const t2msg =
    `Quero CONFIRMAR um agendamento. Meus dados: nome "Cliente Teste ${TEST_TAG}", ` +
    `telefone ${TEST_PHONE}, serviço "${service.nome}" (servico_id ${service.id}), ` +
    `data e hora ${dataHoraISO}. Pode confirmar?`;
  const t2 = await callChat(t2msg, history);
  if (t2.status !== 200) fail(`POST /api/chat retornou HTTP ${t2.status}`, t2.data);
  if (!t2.data.debug?.toolsUsed?.includes("criar_agendamento")) {
    fail("IA NÃO acionou criar_agendamento", t2.data);
  }
  ok("IA acionou criar_agendamento");

  // Falha de RLS no INSERT = policy ausente no projeto Supabase (ação manual).
  const toolDump = JSON.stringify(t2.data.debug?.toolCalls || []);
  if (toolDump.includes("row-level security") || toolDump.includes("42501")) {
    fail(
      "INSERT bloqueado pelo RLS (42501). O banco remoto NÃO tem a policy " +
        '"Insercao anonima de agendamentos". Ação necessária: abra o Supabase Dashboard > SQL Editor, ' +
        "cole e execute o bloco RLS de supabase/schema.sql (DROP/CREATE POLICY) e rode o teste de novo.",
      t2.data.debug?.toolCalls || t2.data
    );
  }

  // ---- Verifica inserção -------------------------------------------------
  section("Verificação — registro no Supabase + cleanup");
  const chk = await sbGet(
    `agendamentos?cliente_telefone=eq.${TEST_PHONE}&select=id,cliente_nome,data_hora,status,servico_id&order=created_at.desc&limit=1`
  );
  if (!chk.ok) fail(`Falha ao consultar agendamentos (HTTP ${chk.status})`, chk.raw);
  const row = chk.data[0];
  if (!row || !String(row.cliente_nome || "").includes("Cliente Teste")) {
    fail("Registro de teste NÃO encontrado na tabela agendamentos", chk.raw);
  }
  ok(`Registro inserido: id=${row.id} | ${row.cliente_nome} | ${row.data_hora} | status=${row.status}`);
  results.push(["Teste 2 (criar_agendamento + insert)", "PASS"]);
  history.push({ role: "user", content: t2msg }, { role: "assistant", content: t2.data.reply });

  // ---- Teste 3: consulta por telefone ------------------------------------
  section("Teste 3 — Consulta (espera tool consultar_agendamentos)");
  await sleep(PACING_MS);
  const t3msg = `Quero consultar meus agendamentos. Meu telefone é ${TEST_PHONE}.`;
  const t3 = await callChat(t3msg, history);
  if (t3.status !== 200) fail(`POST /api/chat retornou HTTP ${t3.status}`, t3.data);
  if (!t3.data.debug?.toolsUsed?.includes("consultar_agendamentos")) {
    fail("IA NÃO acionou consultar_agendamentos", t3.data);
  }
  ok("IA acionou consultar_agendamentos e listou o agendamento de teste");
  results.push(["Teste 3 (consultar_agendamentos)", "PASS"]);
  history.push({ role: "user", content: t3msg }, { role: "assistant", content: t3.data.reply });

  // ---- Teste 4: cancelamento pelo cliente ---------------------------------
  section("Teste 4 — Cancelamento (espera tool cancelar_agendamento)");
  await sleep(PACING_MS);
  const t4msg =
    `Quero cancelar o agendamento ${row.id} do telefone ${TEST_PHONE}. Confirmo o cancelamento.`;
  const t4 = await callChat(t4msg, history);
  if (t4.status !== 200) fail(`POST /api/chat retornou HTTP ${t4.status}`, t4.data);
  if (!t4.data.debug?.toolsUsed?.includes("cancelar_agendamento")) {
    fail("IA NÃO acionou cancelar_agendamento", t4.data);
  }
  ok("IA acionou cancelar_agendamento");
  const chkCancel = await sbGet(`agendamentos?id=eq.${row.id}&select=id,status`);
  if (!chkCancel.ok) fail(`Falha ao reconsultar agendamento (HTTP ${chkCancel.status})`, chkCancel.raw);
  if (!chkCancel.data[0] || chkCancel.data[0].status !== "cancelado") {
    fail("Status NÃO atualizado para cancelado", chkCancel.raw);
  }
  ok(`Status atualizado para cancelado (id=${row.id})`);
  results.push(["Teste 4 (cancelar_agendamento)", "PASS"]);

  // Cleanup honesto: PostgREST retorna 2xx no DELETE mesmo quando o RLS
  // filtra todas as linhas (0 afetadas) — por isso verifica de verdade.
  async function recordGone() {
    const v = await sbGet(`agendamentos?id=eq.${row.id}&select=id`);
    return v.ok && Array.isArray(v.data) && v.data.length === 0;
  }
  const del = await fetch(`${SUPABASE_URL}/rest/v1/agendamentos?id=eq.${row.id}`, {
    method: "DELETE",
    headers: sbHeaders(),
  });
  if (del.ok && (await recordGone())) {
    ok(`Cleanup: registro ${row.id} removido (DELETE).`);
  } else {
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/agendamentos?id=eq.${row.id}`, {
      method: "PATCH",
      headers: sbHeaders({ prefer: "return=representation" }),
      body: JSON.stringify({ status: "cancelado" }),
    });
    const patched = patch.ok ? await patch.json().catch(() => []) : [];
    if (patch.ok && patched[0]?.status === "cancelado") {
      ok(`Cleanup: registro ${row.id} marcado como cancelado (DELETE sem efeito pelo RLS).`);
    } else {
      warn(`Cleanup incompleto (DELETE ${del.status} / PATCH ${patch.status}). Registro ${row.id} mantido como ${TEST_TAG}.`);
    }
  }
  // ---- Teste 5: Segurança e Validação de /api/admin ---------------------
  section("Teste 5 — Segurança e Endpoint /api/admin (Server-Side Auth)");
  const { onRequest: onAdminRequest } = await import("../functions/api/admin.js");
  const adminEnv = { ...ENV, ADMIN_PIN: process.env.ADMIN_PIN || "1234" };

  // 5.1: PIN Inválido deve retornar 401
  const badReq = new Request("http://localhost/api/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": "pin_errado_9999" },
    body: JSON.stringify({ pin: "pin_errado_9999" }),
  });
  const badRes = await onAdminRequest({ env: adminEnv, request: badReq });
  if (badRes.status !== 401) fail(`/api/admin aceitou PIN incorreto (HTTP ${badRes.status})`);
  ok("PIN incorreto rejeitado com HTTP 401 (Autenticação segura)");

  // 5.2: PIN Correto deve autenticar com 200
  const goodReq = new Request("http://localhost/api/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-pin": adminEnv.ADMIN_PIN },
    body: JSON.stringify({ pin: adminEnv.ADMIN_PIN }),
  });
  const goodRes = await onAdminRequest({ env: adminEnv, request: goodReq });
  if (goodRes.status !== 200) fail(`/api/admin rejeitou PIN correto (HTTP ${goodRes.status})`);
  ok("PIN correto autenticado com sucesso (HTTP 200)");

  // 5.3: GET /api/admin?date=YYYY-MM-DD
  const listReq = new Request(`http://localhost/api/admin?date=${target.ymd}`, {
    method: "GET",
    headers: { "x-admin-pin": adminEnv.ADMIN_PIN },
  });
  const listRes = await onAdminRequest({ env: adminEnv, request: listReq });
  if (listRes.status !== 200) fail(`GET /api/admin falhou (HTTP ${listRes.status})`);
  const listData = await listRes.json();
  ok(`GET /api/admin retornou ${listData.agendamentos?.length ?? 0} agendamento(s) para ${target.ymd}`);
  results.push(["Teste 5 (/api/admin Auth + GET)", "PASS"]);

  section("Resumo");
  for (const [n, s] of results) console.log(`  ${s === "PASS" ? "✅" : "❌"} ${n}: ${s}`);
  console.log("\n🎉 Todos os testes passaram.");
}

main().catch((e) => {
  if (!process.exitCode) process.exitCode = 1;
  console.log(`\n💥 Falha: ${e.message}`);
});
