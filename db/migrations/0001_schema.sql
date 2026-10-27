-- Layero Inbox — 0001: таблицы, доступ и RLS.
--
-- Модель: сайт (sites) принадлежит владельцу; команда сайта (site_members)
-- видит его сообщения (reports). Посетитель сайта (роль anon) не видит ни одной таблицы —
-- он отправляет формы только функциями из 0002.
-- Требует включённого входа: схема auth и auth.uid() появляются после
-- `layero data enable --auth`.

create schema if not exists inbox_private;
revoke all on schema inbox_private from public;
grant usage on schema inbox_private to anon, authenticated;

-- Сайт клиента: ключ для виджета, включённые формы, расписание записи, Telegram.
create table public.sites (
    id                   uuid primary key default gen_random_uuid(),
    owner_id             uuid not null default auth.uid(),
    name                 text not null check (char_length(name) between 1 and 80),
    domain               text check (domain is null or char_length(domain) <= 255),
    site_key             text not null unique
                         default 'st_' || replace(gen_random_uuid()::text, '-', ''),
    forms                text[] not null default '{problem}'
                         check (cardinality(forms) between 1 and 3
                                and forms <@ array['problem', 'lead', 'booking']),
    notify_kinds         text[] not null default '{problem,lead,booking}'
                         check (notify_kinds <@ array['problem', 'lead', 'booking']),
    booking_days         smallint[] not null default '{1,2,3,4,5}'
                         check (booking_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
    booking_from         time not null default '10:00',
    booking_to           time not null default '19:00',
    booking_slot_minutes int  not null default 60 check (booking_slot_minutes between 15 and 480),
    timezone             text not null default 'Europe/Moscow',
    telegram_chat_id     text check (telegram_chat_id is null or telegram_chat_id ~ '^-?[0-9]{1,20}$'),
    telegram_chat_title  text,
    created_at           timestamptz not null default now()
);

create table public.site_members (
    site_id    uuid not null references public.sites (id) on delete cascade,
    user_id    uuid not null,
    email      text,
    role       text not null default 'member' check (role in ('owner', 'member')),
    created_at timestamptz not null default now(),
    primary key (site_id, user_id)
);
create index site_members_user_idx on public.site_members (user_id);

create table public.invites (
    id          uuid primary key default gen_random_uuid(),
    site_id     uuid not null references public.sites (id) on delete cascade,
    email       text not null check (email = lower(email) and email like '%@%'),
    invited_by  uuid not null default auth.uid(),
    created_at  timestamptz not null default now(),
    accepted_at timestamptz,
    unique (site_id, email)
);

-- Сообщение с сайта: проблема (со снимком), заявка или запись.
create table public.reports (
    id              uuid primary key default gen_random_uuid(),
    site_id         uuid not null references public.sites (id) on delete cascade,
    kind            text not null default 'problem' check (kind in ('problem', 'lead', 'booking')),
    message         text check (message is null or char_length(message) between 1 and 2000),
    name            text check (name is null or char_length(name) <= 120),
    contact         text check (contact is null or char_length(contact) <= 200),
    booking_at      timestamptz,
    consent_at      timestamptz,
    page_url        text check (page_url is null or char_length(page_url) <= 2000),
    user_agent      text check (user_agent is null or char_length(user_agent) <= 500),
    viewport        text check (viewport is null or char_length(viewport) <= 40),
    language        text check (language is null or char_length(language) <= 40),
    screenshot_path text,
    status          text not null default 'new'
                    check (status in ('new', 'in_progress', 'resolved', 'rejected')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,
    notified_at     timestamptz,
    check ((kind = 'problem' and message is not null)
        or (kind = 'lead'    and contact is not null and consent_at is not null)
        or (kind = 'booking' and contact is not null and consent_at is not null and booking_at is not null))
);
create index reports_site_created_idx on public.reports (site_id, created_at desc);
-- Один слот — одна запись; отклонённая запись слот освобождает.
create unique index reports_booking_slot on public.reports (site_id, booking_at)
    where kind = 'booking' and status <> 'rejected';

-- Проверки членства — SECURITY DEFINER, чтобы политики разных таблиц
-- не зацикливались друг на друге через RLS.
create function inbox_private.is_member(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.site_members m
                    where m.site_id = p_site and m.user_id = auth.uid());
$$;

create function inbox_private.is_owner(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.sites s
                    where s.id = p_site and s.owner_id = auth.uid());
$$;

grant execute on function inbox_private.is_member(uuid), inbox_private.is_owner(uuid) to authenticated;

-- Владелец сайта сразу входит в его команду (почта — из auth.users).
create function inbox_private.add_owner_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into public.site_members (site_id, user_id, email, role)
    values (new.id, new.owner_id,
            (select lower(u.email) from auth.users u where u.id = new.owner_id), 'owner');
    return new;
end $$;

create trigger sites_add_owner after insert on public.sites
    for each row execute function inbox_private.add_owner_member();

-- «Изменено» — только смена статуса.
create function inbox_private.touch_updated_at() returns trigger
language plpgsql as $$
begin
    if new.status is distinct from old.status then
        new.updated_at := now();
    end if;
    return new;
end $$;

create trigger reports_touch before update on public.reports
    for each row execute function inbox_private.touch_updated_at();

-- RLS на всех таблицах. Посетителю сайта таблицы не нужны вовсе.
alter table public.sites        enable row level security;
alter table public.site_members enable row level security;
alter table public.invites      enable row level security;
alter table public.reports      enable row level security;
revoke all on public.sites, public.site_members, public.invites, public.reports from anon;

-- sites: читает команда сайта (и владелец — для insert … returning); меняет и удаляет владелец.
create policy sites_read on public.sites for select to authenticated
    using (owner_id = auth.uid() or inbox_private.is_member(id));
create policy sites_insert on public.sites for insert to authenticated
    with check (owner_id = auth.uid());
create policy sites_update on public.sites for update to authenticated
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy sites_delete on public.sites for delete to authenticated
    using (owner_id = auth.uid());

-- site_members: видит команда сайта; новые пользователи добавляются только триггером и api.accept_invites().
revoke insert, update on public.site_members from authenticated;
create policy members_read on public.site_members for select to authenticated
    using (inbox_private.is_member(site_id));
create policy members_delete on public.site_members for delete to authenticated
    using (role <> 'owner' and (inbox_private.is_owner(site_id) or user_id = auth.uid()));

-- invites: управляет владелец.
revoke update on public.invites from authenticated;
create policy invites_read on public.invites for select to authenticated
    using (inbox_private.is_owner(site_id));
create policy invites_insert on public.invites for insert to authenticated
    with check (inbox_private.is_owner(site_id) and invited_by = auth.uid());
create policy invites_delete on public.invites for delete to authenticated
    using (inbox_private.is_owner(site_id));

-- reports: команда сайта читает и меняет только статус; удаляет владелец.
-- Вставка с клиента закрыта — только функциями api.
revoke insert, update on public.reports from authenticated;
grant update (status) on public.reports to authenticated;
create policy reports_read on public.reports for select to authenticated
    using (inbox_private.is_member(site_id));
create policy reports_update on public.reports for update to authenticated
    using (inbox_private.is_member(site_id)) with check (inbox_private.is_member(site_id));
create policy reports_delete on public.reports for delete to authenticated
    using (inbox_private.is_owner(site_id));
