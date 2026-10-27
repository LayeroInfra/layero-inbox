-- Layero Inbox — 0002: публичные функции для виджета и кабинета.
--
-- Схема api — витрина Data API: функция отсюда, выданная роли, вызывается
-- по HTTP (`POST /rest/v1/rpc/<имя>`). Имена аргументов — публичный
-- контракт: виджет передаёт JSON с теми же ключами.

-- Свободные слоты записи на p_days дней вперёд, по часовому поясу сайта.
create function inbox_private.free_slots(p_site public.sites, p_days int default 14)
returns table (slot_at timestamptz)
language sql stable security definer set search_path = public as $$
    with days as (
        select (now() at time zone p_site.timezone)::date + g as d
          from generate_series(0, p_days - 1) g
    ), slots as (
        select ((d + p_site.booking_from + make_interval(mins => p_site.booking_slot_minutes * n))
                at time zone p_site.timezone) as slot_at
          from days,
               generate_series(0, (extract(epoch from (p_site.booking_to - p_site.booking_from))
                                   / 60 / p_site.booking_slot_minutes)::int - 1) n
         where extract(isodow from d)::smallint = any (p_site.booking_days)
    )
    select s.slot_at from slots s
     where s.slot_at > now() + interval '30 minutes'
       and not exists (select 1 from public.reports r
                        where r.site_id = p_site.id and r.kind = 'booking'
                          and r.status <> 'rejected' and r.booking_at = s.slot_at)
     order by s.slot_at;
$$;

-- Что показать в виджете: включённые формы и свободные слоты. Для посетителя сайта.
create function api.site_form(site_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_site public.sites%rowtype;
begin
    select * into v_site from public.sites s where s.site_key = site_form.site_key;
    if not found then
        raise exception 'unknown site key' using errcode = '22023';
    end if;
    return jsonb_build_object(
        'name', v_site.name,
        'forms', to_jsonb(v_site.forms),
        'timezone', v_site.timezone,
        'slot_minutes', v_site.booking_slot_minutes,
        'slots', case when 'booking' = any (v_site.forms)
                      then coalesce((select jsonb_agg(f.slot_at) from inbox_private.free_slots(v_site) f), '[]')
                      else '[]' end);
end $$;

grant execute on function api.site_form(text) to anon, authenticated;

-- Приём любой из трёх форм. SECURITY DEFINER пишет в закрытую таблицу,
-- поэтому всё, что приходит от посетителя, проверяется здесь.
create function api.submit_form(
    site_key       text,
    form           text,
    message        text        default null,
    name           text        default null,
    contact        text        default null,
    booking_at     timestamptz default null,
    consent        boolean     default false,
    page_url       text        default null,
    user_agent     text        default null,
    viewport       text        default null,
    language       text        default null,
    has_screenshot boolean     default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_site    public.sites%rowtype;
    v_id      uuid := gen_random_uuid();
    v_path    text;
    v_recent  int;
    v_msg     text := nullif(left(btrim(submit_form.message), 2000), '');
    v_name    text := nullif(left(btrim(submit_form.name), 120), '');
    v_contact text := nullif(left(btrim(submit_form.contact), 200), '');
begin
    select * into v_site from public.sites s where s.site_key = submit_form.site_key;
    if not found then
        raise exception 'unknown site key' using errcode = '22023';
    end if;
    if not (submit_form.form = any (v_site.forms)) then
        raise exception 'form is off for this site' using errcode = '22023';
    end if;

    -- Грубая защита от флуда: не больше 30 сообщений в минуту на сайт.
    select count(*) into v_recent from public.reports r
     where r.site_id = v_site.id and r.created_at > now() - interval '1 minute';
    if v_recent >= 30 then
        raise exception 'too many reports, try later' using errcode = '54000';
    end if;

    if submit_form.form = 'problem' then
        if v_msg is null then
            raise exception 'message is empty' using errcode = '22023';
        end if;
        if has_screenshot then
            v_path := v_site.id || '/' || v_id || '.jpg';   -- путь, по которому посетителю можно загрузить снимок
        end if;
    else
        if v_contact is null then
            raise exception 'contact is empty' using errcode = '22023';
        end if;
        if not coalesce(consent, false) then
            raise exception 'consent is required' using errcode = '22023';
        end if;
    end if;

    if submit_form.form = 'booking' and (submit_form.booking_at is null or not exists (
           select 1 from inbox_private.free_slots(v_site, 31) f where f.slot_at = submit_form.booking_at)) then
        raise exception 'slot is not available' using errcode = '22023';
    end if;

    begin
        insert into public.reports (id, site_id, kind, message, name, contact, booking_at, consent_at,
                                    page_url, user_agent, viewport, language, screenshot_path)
        values (v_id, v_site.id, submit_form.form, v_msg, v_name, v_contact,
                case when submit_form.form = 'booking' then submit_form.booking_at end,
                case when submit_form.form <> 'problem' then now() end,
                left(submit_form.page_url, 2000), left(submit_form.user_agent, 500),
                left(submit_form.viewport, 40), left(submit_form.language, 40), v_path);
    exception when unique_violation then
        raise exception 'slot is not available' using errcode = '22023';   -- слот заняли параллельно
    end;

    return jsonb_build_object('id', v_id, 'upload_path', v_path);
end $$;

grant execute on function api.submit_form(text, text, text, text, text, timestamptz, boolean, text, text, text, text, boolean)
    to anon, authenticated;

-- Принять приглашения на почту вошедшего пользователя. Кабинет зовёт после входа.
-- Почту берём из auth.users, а не из токена.
create function api.accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare
    v_uid   uuid := auth.uid();
    v_email text;
    v_n     int;
begin
    select lower(u.email) into v_email
      from auth.users u
     where u.id = v_uid and u.email_confirmed_at is not null;
    if v_uid is null or v_email is null then
        return 0;
    end if;

    with acc as (
        update public.invites i set accepted_at = now()
         where i.email = v_email and i.accepted_at is null
        returning i.site_id
    ), ins as (
        insert into public.site_members (site_id, user_id, email, role)
        select acc.site_id, v_uid, v_email, 'member' from acc
        on conflict do nothing
        returning 1
    )
    select count(*) into v_n from ins;
    return v_n;
end $$;

grant execute on function api.accept_invites() to authenticated;
