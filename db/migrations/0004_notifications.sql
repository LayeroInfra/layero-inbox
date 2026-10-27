-- Layero Inbox — 0004: уведомления в Telegram через net.http_post.
--
-- net.http_post(url, body, …) — HTTP из SQL, как pg_net в Supabase: запрос
-- встаёт в очередь в той же транзакции и уходит после коммита; ответ — в
-- net._http_response. Токен бота — секрет базы, в SQL пишется подстановкой:
--   printf %s "$BOT_TOKEN" | npx layero@latest data secrets set TELEGRAM_BOT_TOKEN --db <база>
--
--   сообщение без снимка — текст сразу из триггера;
--   со снимком — виджет загружает файл, подписывает ссылку и зовёт
--   api.notify_screenshot: уходит sendPhoto, Telegram скачивает картинку сам.

-- Настройки приложения. app_url — адрес кабинета для ссылок в уведомлениях;
-- его записывает scripts/setup.sh.
create table inbox_private.config (
    key   text primary key,
    value text not null
);

create function inbox_private.app_url() returns text
language sql stable security definer set search_path = public as $$
    select coalesce((select value from inbox_private.config where key = 'app_url'), '');
$$;

create function inbox_private.ru_datetime(p_at timestamptz, p_tz text) returns text
language sql immutable as $$
    select (array['пн','вт','ср','чт','пт','сб','вс'])[extract(isodow from l)::int] || ' '
           || extract(day from l)::int || ' '
           || (array['января','февраля','марта','апреля','мая','июня','июля','августа',
                     'сентября','октября','ноября','декабря'])[extract(month from l)::int]
           || ', ' || to_char(l, 'HH24:MI')
      from (select p_at at time zone p_tz as l) t;
$$;

-- Текст уведомления по типу сообщения.
create function inbox_private.report_text(p_site public.sites, p_report public.reports, p_limit int)
returns text language sql stable as $$
    select left(case p_report.kind
        when 'lead' then format(E'Заявка · %s\n\n%s%s%s\n\nОткрыть: %s',
            p_site.name, coalesce(p_report.name || ', ', ''), p_report.contact,
            coalesce(E'\n«' || left(p_report.message, 500) || '»', ''), inbox_private.app_url())
        when 'booking' then format(E'Запись · %s\n\n%s\n%s%s\n\nОткрыть: %s',
            p_site.name, inbox_private.ru_datetime(p_report.booking_at, p_site.timezone),
            coalesce(p_report.name || ', ', ''), p_report.contact, inbox_private.app_url())
        else format(E'Проблема · %s\n\n%s\n\n%sОткрыть: %s',
            p_site.name, left(p_report.message, 600),
            coalesce('Страница: ' || left(p_report.page_url, 300) || E'\n', ''), inbox_private.app_url())
        end, p_limit);
$$;

create function inbox_private.tg_send_text(p_chat text, p_text text) returns void
language sql as $$
    select net.http_post(
        url  := 'https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage',
        body := jsonb_build_object('chat_id', p_chat, 'text', p_text, 'disable_web_page_preview', true));
$$;

create function inbox_private.notify_new_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    v_site public.sites%rowtype;
begin
    if new.screenshot_path is not null then
        return new;                       -- ждём снимок: уведомит api.notify_screenshot
    end if;
    select * into v_site from public.sites where id = new.site_id;
    if v_site.telegram_chat_id is not null and new.kind = any (v_site.notify_kinds) then
        perform inbox_private.tg_send_text(v_site.telegram_chat_id,
                                           inbox_private.report_text(v_site, new, 4000));
    end if;
    update public.reports set notified_at = now() where id = new.id;
    return new;
end $$;

create trigger reports_notify after insert on public.reports
    for each row execute function inbox_private.notify_new_report();

-- Фото снимка в Telegram. Виджет зовёт после загрузки (или без ссылки, если
-- загрузка не удалась — тогда уходит текст).
create function api.notify_screenshot(report_id uuid, signed_url text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
    v_report public.reports%rowtype;
    v_site   public.sites%rowtype;
    v_re     text;
begin
    select * into v_report from public.reports r
     where r.id = notify_screenshot.report_id
       and r.screenshot_path is not null
       and r.notified_at is null
       and r.created_at > now() - interval '10 minutes'
       for update;
    if not found then
        return false;                     -- чужое, старое или уже уведомлено
    end if;
    update public.reports set notified_at = now() where id = v_report.id;

    select * into v_site from public.sites where id = v_report.site_id;
    if v_site.telegram_chat_id is null or not (v_report.kind = any (v_site.notify_kinds)) then
        return true;
    end if;

    -- Ссылка должна вести ровно на снимок этого сообщения в этой базе.
    v_re := '^https://data\.layero\.ru/[a-z0-9-]+/storage/v1/object/sign/screenshots/'
            || replace(v_report.screenshot_path, '.', '\.') || '\?token=[A-Za-z0-9._-]+$';
    if signed_url is not null and signed_url ~ v_re
       and exists (select 1 from storage.objects o
                    where o.bucket_id = 'screenshots' and o.name = v_report.screenshot_path) then
        perform net.http_post(
            url  := 'https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendPhoto',
            body := jsonb_build_object('chat_id', v_site.telegram_chat_id, 'photo', signed_url,
                                       'caption', inbox_private.report_text(v_site, v_report, 1024)));
    else
        perform inbox_private.tg_send_text(v_site.telegram_chat_id,
            inbox_private.report_text(v_site, v_report, 4000) || E'\n(снимок не загрузился)');
    end if;
    return true;
end $$;

grant execute on function api.notify_screenshot(uuid, text) to anon, authenticated;

-- Telegram одной кнопкой. Входящих вебхуков у Data API нет, поэтому:
-- кабинет получает код → открывает t.me/<бот>?start=<код> → пока владелец
-- на странице, раз в 2 с зовёт api.telegram_link_check, а она опрашивает
-- getUpdates бота (с offset) и ищет «/start <код>».
create table inbox_private.tg_links (
    code       text primary key,
    site_id    uuid not null references public.sites (id) on delete cascade,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    polled_at  timestamptz,
    done_at    timestamptz
);

create table inbox_private.tg_state (
    id             boolean primary key default true check (id),
    last_update_id bigint not null default 0
);
insert into inbox_private.tg_state default values;

create function inbox_private.tg_poll() returns void
language plpgsql security definer set search_path = public as $$
declare
    v_last bigint;
begin
    select greatest(s.last_update_id, coalesce(max((u ->> 'update_id')::bigint), 0)) into v_last
      from inbox_private.tg_state s
      left join lateral (
          select u from net._http_response r,
               jsonb_array_elements(case when r.content like '{"ok":true,"result":[%' then r.content::jsonb -> 'result' end) u
           where r.created > now() - interval '1 hour') x on true
     group by s.last_update_id;
    update inbox_private.tg_state set last_update_id = v_last;
    perform net.http_get(
        url    := 'https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/getUpdates',
        params := jsonb_build_object('offset', v_last + 1, 'allowed_updates', '["message"]'));
end $$;

create function api.telegram_link_start(site_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_code text := 'li' || replace(gen_random_uuid()::text, '-', '');
begin
    if not inbox_private.is_owner(telegram_link_start.site_id) then
        raise exception 'only the site owner can connect Telegram' using errcode = '42501';
    end if;
    insert into inbox_private.tg_links (code, site_id, created_by, polled_at)
    values (v_code, telegram_link_start.site_id, auth.uid(), now());
    perform inbox_private.tg_poll();
    return jsonb_build_object('code', v_code);
end $$;

create function api.telegram_link_check(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_link inbox_private.tg_links%rowtype;
    v_site public.sites%rowtype;
    v_chat jsonb;
begin
    select * into v_link from inbox_private.tg_links l
     where l.code = telegram_link_check.code and l.created_by = auth.uid()
       for update;
    if not found then
        return jsonb_build_object('status', 'unknown');
    end if;
    select * into v_site from public.sites where id = v_link.site_id;
    if v_link.done_at is not null then
        return jsonb_build_object('status', 'linked', 'chat_title', v_site.telegram_chat_title);
    end if;
    if v_link.created_at < now() - interval '15 minutes' then
        return jsonb_build_object('status', 'expired');
    end if;

    select u -> 'message' -> 'chat' into v_chat
      from net._http_response r,
           jsonb_array_elements(case when r.content like '{"ok":true,"result":[%' then r.content::jsonb -> 'result' end) u
     where r.created >= v_link.created_at
       and u -> 'message' ->> 'text' = '/start ' || v_link.code
     order by r.id desc
     limit 1;

    if v_chat is not null then
        update public.sites
           set telegram_chat_id = v_chat ->> 'id',
               telegram_chat_title = coalesce(v_chat ->> 'title',
                   nullif(btrim(coalesce(v_chat ->> 'first_name', '') || ' ' || coalesce(v_chat ->> 'last_name', '')), ''),
                   v_chat ->> 'username')
         where id = v_link.site_id
        returning * into v_site;
        update inbox_private.tg_links set done_at = now() where code = v_link.code;
        perform inbox_private.tg_send_text(v_site.telegram_chat_id,
            format(E'Готово. %s подключён к Layero Inbox.\nСюда будут приходить проблемы, заявки и записи.', v_site.name));
        return jsonb_build_object('status', 'linked', 'chat_title', v_site.telegram_chat_title);
    end if;

    if v_link.polled_at < now() - interval '2 seconds' then
        perform inbox_private.tg_poll();
        update inbox_private.tg_links set polled_at = now() where code = v_link.code;
    end if;
    return jsonb_build_object('status', 'waiting');
end $$;

-- Пробное сообщение в подключённый чат.
create function api.telegram_test(site_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_site public.sites%rowtype;
begin
    if not inbox_private.is_owner(telegram_test.site_id) then
        raise exception 'only the site owner' using errcode = '42501';
    end if;
    select * into v_site from public.sites where id = telegram_test.site_id;
    if v_site.telegram_chat_id is null then
        return false;
    end if;
    perform inbox_private.tg_send_text(v_site.telegram_chat_id,
        format('Пробное сообщение от Layero Inbox: %s на связи.', v_site.name));
    return true;
end $$;

grant execute on function api.telegram_link_start(uuid), api.telegram_link_check(text),
                          api.telegram_test(uuid) to authenticated;
