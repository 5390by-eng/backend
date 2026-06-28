-- Telegram subscription storage and RPC for task notifications.
-- Apply in Supabase SQL editor before deploying Worker changes.

CREATE TABLE IF NOT EXISTS chat_telegram_subscriptions (
	chat_id bigint PRIMARY KEY,
	username text NOT NULL,
	is_subscribed boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_telegram_subscriptions_username_subscribed_idx
	ON chat_telegram_subscriptions (lower(username))
	WHERE is_subscribed = true;

CREATE OR REPLACE FUNCTION chat_telegram_get_subscription(p_chat_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	rec chat_telegram_subscriptions%ROWTYPE;
BEGIN
	SELECT * INTO rec FROM chat_telegram_subscriptions WHERE chat_id = p_chat_id;

	IF NOT FOUND THEN
		RETURN jsonb_build_object('isSubscribed', false, 'username', null);
	END IF;

	RETURN jsonb_build_object(
		'isSubscribed', rec.is_subscribed,
		'username', rec.username
	);
END;
$$;

CREATE OR REPLACE FUNCTION chat_telegram_set_subscription(
	p_chat_id bigint,
	p_username text,
	p_subscribed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	clean_username text;
BEGIN
	clean_username := nullif(trim(both '@' from trim(p_username)), '');

	IF clean_username IS NULL THEN
		RAISE EXCEPTION 'Telegram username is required';
	END IF;

	INSERT INTO chat_telegram_subscriptions (chat_id, username, is_subscribed, updated_at)
	VALUES (p_chat_id, clean_username, p_subscribed, now())
	ON CONFLICT (chat_id) DO UPDATE
	SET
		username = EXCLUDED.username,
		is_subscribed = EXCLUDED.is_subscribed,
		updated_at = now();

	RETURN jsonb_build_object(
		'isSubscribed', p_subscribed,
		'username', clean_username
	);
END;
$$;

CREATE OR REPLACE FUNCTION chat_telegram_find_subscribers(p_assignee_names text[])
RETURNS TABLE(chat_id bigint, username text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	SELECT s.chat_id, s.username
	FROM chat_telegram_subscriptions s
	WHERE s.is_subscribed = true
		AND lower(s.username) IN (
			SELECT lower(trim(name))
			FROM unnest(p_assignee_names) AS name
			WHERE trim(name) <> ''
		);
$$;

GRANT EXECUTE ON FUNCTION chat_telegram_get_subscription(bigint) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat_telegram_set_subscription(bigint, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat_telegram_find_subscribers(text[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION chat_user_telegram_lookup(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	SELECT jsonb_build_object(
		'telegramUsername', telegram_username,
		'name', name
	)
	FROM profiles
	WHERE id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION chat_user_telegram_lookup(uuid) TO anon, authenticated, service_role;
