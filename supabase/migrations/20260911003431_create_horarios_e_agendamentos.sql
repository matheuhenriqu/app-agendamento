-- ============================================================
-- Migration: create_horarios_e_agendamentos
-- Gerada via Supabase CLI
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1. Tabela: horarios (id, dia, horario, disponivel)
-- ------------------------------------------------------------
create table if not exists public.horarios (
  id uuid default gen_random_uuid() primary key,
  dia text not null,
  horario time not null,
  disponivel boolean default true not null
);

-- Índices de consulta para agilizar busca por dia e disponibilidade
create index if not exists idx_horarios_dia_disponivel
  on public.horarios (dia, disponivel);

-- ------------------------------------------------------------
-- 2. Tabela: agendamentos (id, horarios_id, nome_cliente, criado_em)
-- ------------------------------------------------------------
create table if not exists public.agendamentos (
  id uuid default gen_random_uuid() primary key,
  horarios_id uuid references public.horarios (id) on delete cascade,
  nome_cliente text not null,
  criado_em timestamptz default now() not null
);

-- Se a tabela agendamentos já existia no banco, garante a existência das colunas solicitadas:
alter table public.agendamentos add column if not exists horarios_id uuid references public.horarios (id) on delete cascade;
alter table public.agendamentos add column if not exists nome_cliente text;
alter table public.agendamentos add column if not exists criado_em timestamptz default now();

create index if not exists idx_agendamentos_horarios_id
  on public.agendamentos (horarios_id);

-- ------------------------------------------------------------
-- 3. Row Level Security (RLS)
-- ------------------------------------------------------------
alter table public.horarios enable row level security;
alter table public.agendamentos enable row level security;

-- Políticas para horarios: leitura pública e atualização quando agendado
drop policy if exists "Leitura publica de horarios" on public.horarios;
create policy "Leitura publica de horarios"
  on public.horarios
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Atualizacao de disponibilidade de horarios" on public.horarios;
create policy "Atualizacao de disponibilidade de horarios"
  on public.horarios
  for update
  to anon, authenticated
  using (true)
  with check (true);

-- Políticas para agendamentos: inserção e leitura
drop policy if exists "Insercao publica de agendamentos" on public.agendamentos;
create policy "Insercao publica de agendamentos"
  on public.agendamentos
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Leitura publica de agendamentos" on public.agendamentos;
create policy "Leitura publica de agendamentos"
  on public.agendamentos
  for select
  to anon, authenticated
  using (true);

-- ------------------------------------------------------------
-- 4. Seed: Horários de exemplo (Segunda a Sexta, 09h às 18h, de hora em hora)
-- Todos com disponivel = true
-- ------------------------------------------------------------
insert into public.horarios (dia, horario, disponivel)
select
  d.dia,
  h.horario,
  true as disponivel
from (
  values
    ('Segunda-feira'),
    ('Terça-feira'),
    ('Quarta-feira'),
    ('Quinta-feira'),
    ('Sexta-feira')
) as d(dia)
cross join (
  values
    ('09:00:00'::time),
    ('10:00:00'::time),
    ('11:00:00'::time),
    ('12:00:00'::time),
    ('13:00:00'::time),
    ('14:00:00'::time),
    ('15:00:00'::time),
    ('16:00:00'::time),
    ('17:00:00'::time),
    ('18:00:00'::time)
) as h(horario);
