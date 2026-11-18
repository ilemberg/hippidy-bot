-- Calls the API's reconcile route about every minute (decision 54): the safety net for
-- Anthropic webhooks that never arrived. It also keeps the free-plan project awake.
--
-- The URL and the API's service token are read from Supabase Vault at run time, so neither
-- is in this public repo. Until both secrets exist the job does nothing. Create them once in
-- the Supabase SQL editor (see the README's Setup section):
--   select vault.create_secret('https://hippidy-bot.vercel.app', 'hippidy_api_url');
--   select vault.create_secret('<the API service token>', 'hippidy_api_token');
--
-- pg_cron, pg_net and Vault exist only on Supabase; elsewhere (tests) this does nothing.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron, pg_net or Vault not available: reconcile schedule not created';
    return;
  end if;

  -- The schemas Supabase's documentation uses for these extensions.
  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;

  perform cron.schedule(
    'hippidy-reconcile',
    '* * * * *',
    $job$
      select net.http_post(
        url := s.url || '/v1/reconcile',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || s.token
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      )
      from (
        select
          (select decrypted_secret from vault.decrypted_secrets where name = 'hippidy_api_url') as url,
          (select decrypted_secret from vault.decrypted_secrets where name = 'hippidy_api_token') as token
      ) s
      where s.url is not null and s.token is not null
    $job$
  );
end
$$;
