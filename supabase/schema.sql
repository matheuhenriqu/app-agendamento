-- ============================================================
-- Schema: App de Agendamento (Supabase / PostgreSQL)
-- Execute no SQL Editor do Supabase (Dashboard > SQL Editor)
-- Versão com Segurança Blindada (Anti-Double-Booking + RLS sem vazamento PII)
-- ============================================================

-- Extensão para gen_random_uuid() (geralmente já ativa no Supabase)
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Tabela: servicos
-- ------------------------------------------------------------
create table if not exists public.servicos (
  id uuid default gen_random_uuid() primary key,
  nome text not null,
  duracao_minutos int default 30,
  preco numeric(10, 2) not null,
  ativo boolean default true
);

-- ------------------------------------------------------------
-- Tabela: agendamentos
-- ------------------------------------------------------------
create table if not exists public.agendamentos (
  id uuid default gen_random_uuid() primary key,
  cliente_nome text not null,
  cliente_telefone text not null,
  servico_id uuid references public.servicos (id) on delete set null,
  data_hora timestamptz not null,
  status text default 'pendente',
  created_at timestamptz default now()
);

create index if not exists idx_agendamentos_data_hora
  on public.agendamentos (data_hora);
create index if not exists idx_agendamentos_servico
  on public.agendamentos (servico_id);

-- Garante no nível do banco de dados que não ocorra double-booking (concorrência simultânea no mesmo horário)
create unique index if not exists idx_agendamentos_sem_conflito
  on public.agendamentos (data_hora)
  where (status != 'cancelado');

-- ------------------------------------------------------------
-- Tabela: configuracao_agenda (0=domingo ... 6=sábado)
-- ------------------------------------------------------------
create table if not exists public.configuracao_agenda (
  dia_semana int primary key check (dia_semana between 0 and 6),
  abertura time not null,
  fechamento time not null,
  almoco_inicio time,
  almoco_fim time
);

-- ------------------------------------------------------------
-- View pública: horários ocupados (segurança: ZERO vazamento de PII)
-- Usada pelo chatbot para consultar slots livres sem expor nomes ou telefones.
-- ------------------------------------------------------------
create or replace view public.horarios_ocupados with (security_invoker = false) as
  select data_hora, status
  from public.agendamentos
  where status != 'cancelado';

grant select on public.horarios_ocupados to anon, authenticated;

-- ------------------------------------------------------------
-- Row Level Security (RLS)
-- ------------------------------------------------------------
alter table public.servicos enable row level security;
alter table public.agendamentos enable row level security;
alter table public.configuracao_agenda enable row level security;

-- Limpa políticas antigas e vulneráveis para permitir re-execução idempotente
drop policy if exists "Leitura publica de servicos ativos" on public.servicos;
drop policy if exists "Leitura publica da agenda" on public.configuracao_agenda;
drop policy if exists "Insercao anonima de agendamentos" on public.agendamentos;
drop policy if exists "Insercao restrita de agendamentos" on public.agendamentos;
drop policy if exists "Leitura anonima de agendamentos por telefone" on public.agendamentos;
drop policy if exists "Leitura anonima de horarios ocupados" on public.agendamentos;
drop policy if exists "Atualizacao anonima de status" on public.agendamentos;
drop policy if exists "Acesso restrito de agendamentos para administradores" on public.agendamentos;
drop policy if exists "Acesso completo via service_role ou auth" on public.agendamentos;

-- Serviços: qualquer pessoa (anon) pode ler serviços ativos
create policy "Leitura publica de servicos ativos"
  on public.servicos
  for select
  to anon, authenticated
  using (ativo = true);

-- Agenda: qualquer pessoa pode ler horários de funcionamento
create policy "Leitura publica da agenda"
  on public.configuracao_agenda
  for select
  to anon, authenticated
  using (true);

-- Agendamentos: inserção controlada pelo fluxo de agendamento com validação
create policy "Insercao restrita de agendamentos"
  on public.agendamentos
  for insert
  to anon, authenticated
  with check (
    length(cliente_nome) >= 2
    and length(cliente_telefone) >= 8
    and status in ('pendente', 'confirmado')
  );

-- Agendamentos: leitura e atualização completas restritas à role autenticada ou service_role.
-- Anônimos NÃO podem listar dados pessoais de clientes nem alterar status diretamente via PostgREST.
create policy "Acesso completo via service_role ou auth"
  on public.agendamentos
  for all
  to authenticated
  using (true)
  with check (true);

-- ------------------------------------------------------------
-- Seed: serviços de exemplo
-- ------------------------------------------------------------
insert into public.servicos (nome, duracao_minutos, preco)
values
  ('Corte de cabelo', 30, 50.00),
  ('Barba', 20, 30.00),
  ('Corte + Barba', 50, 70.00),
  ('Manicure', 45, 40.00)
on conflict do nothing;

-- ------------------------------------------------------------
-- Seed: agenda padrão seg–sáb 09:00–18:00, almoço 12:00–13:00
-- ------------------------------------------------------------
insert into public.configuracao_agenda (dia_semana, abertura, fechamento, almoco_inicio, almoco_fim)
values
  (1, '09:00', '18:00', '12:00', '13:00'),
  (2, '09:00', '18:00', '12:00', '13:00'),
  (3, '09:00', '18:00', '12:00', '13:00'),
  (4, '09:00', '18:00', '12:00', '13:00'),
  (5, '09:00', '18:00', '12:00', '13:00'),
  (6, '09:00', '14:00', null, null)
on conflict (dia_semana) do update set
  abertura = excluded.abertura,
  fechamento = excluded.fechamento,
  almoco_inicio = excluded.almoco_inicio,
  almoco_fim = excluded.almoco_fim;

