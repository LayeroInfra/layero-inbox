-- Layero Inbox — 0003: снимки экрана в приватном бакете.
--
-- Бакет создаёт scripts/setup.sh:
--   layero data buckets create screenshots --private --max 5MB --types image/jpeg,image/png
-- Путь файла — <site_id>/<report_id>.jpg; его выдаёт api.submit_form.
-- Требует включённых файлов (`layero data enable --storage`).

-- Посетитель сайта загружает снимок только по пути свежего сообщения (10 минут),
-- у которого снимка ещё нет.
create function inbox_private.screenshot_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.reports r
         where r.screenshot_path = p_name
           and r.created_at > now() - interval '10 minutes')
       and not exists (
        select 1 from storage.objects o
         where o.bucket_id = 'screenshots' and o.name = p_name);
$$;

-- Посетитель может подписать ссылку на свой свежий снимок, пока владелец
-- не уведомлён, — чтобы Telegram скачал фото (см. 0004).
create function inbox_private.screenshot_fresh(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.reports r
                    where r.screenshot_path = p_name
                      and r.notified_at is null
                      and r.created_at > now() - interval '10 minutes');
$$;

-- Первая папка пути — id сайта.
create function inbox_private.screenshot_site(p_name text) returns uuid
language sql immutable as $$
    select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f-]{36}$'
                then (storage.foldername(p_name))[1]::uuid end;
$$;

grant execute on function inbox_private.screenshot_upload_allowed(text),
                          inbox_private.screenshot_fresh(text),
                          inbox_private.screenshot_site(text) to anon, authenticated;

create policy screenshots_visitor_upload on storage.objects
    for insert to anon, authenticated
    with check (bucket_id = 'screenshots' and inbox_private.screenshot_upload_allowed(name));

create policy screenshots_visitor_sign on storage.objects
    for select to anon
    using (bucket_id = 'screenshots'
           and created_at > now() - interval '1 minute'
           and inbox_private.screenshot_fresh(name));

create policy screenshots_member_read on storage.objects
    for select to authenticated
    using (bucket_id = 'screenshots' and inbox_private.is_member(inbox_private.screenshot_site(name)));

create policy screenshots_owner_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'screenshots' and inbox_private.is_owner(inbox_private.screenshot_site(name)));
