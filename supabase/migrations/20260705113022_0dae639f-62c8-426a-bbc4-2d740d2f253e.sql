
-- Extensions for cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Roles enum
CREATE TYPE public.app_role AS ENUM ('owner');

-- user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- has_role security definer function
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Auto-grant owner role to the first user who signs up
CREATE OR REPLACE FUNCTION public.handle_new_user_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'owner');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_grant_owner
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_owner();

-- Meetings table
CREATE TABLE public.meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'telegram', 'public_booking')),
  attendee_name TEXT,
  attendee_email TEXT,
  attendee_purpose TEXT,
  google_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings TO authenticated;
GRANT ALL ON public.meetings TO service_role;

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage all meetings"
  ON public.meetings FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE INDEX meetings_status_idx ON public.meetings (status);
CREATE INDEX meetings_start_time_idx ON public.meetings (start_time);

-- Settings singleton
CREATE TABLE public.settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  working_hours JSONB NOT NULL DEFAULT '{
    "0": [{"start": "09:00", "end": "18:00"}],
    "1": [{"start": "09:00", "end": "18:00"}],
    "2": [{"start": "09:00", "end": "18:00"}],
    "3": [{"start": "09:00", "end": "18:00"}],
    "4": [{"start": "09:00", "end": "18:00"}],
    "5": [{"start": "09:00", "end": "13:00"}],
    "6": []
  }'::jsonb,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  booking_page_title TEXT DEFAULT 'Book a Session',
  booking_page_description TEXT DEFAULT 'Select an available time slot below.',
  logo_url TEXT,
  google_connected BOOLEAN NOT NULL DEFAULT FALSE,
  google_account_email TEXT,
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_token_expiry TIMESTAMPTZ,
  telegram_chat_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read settings"
  ON public.settings FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Owners can update settings"
  ON public.settings FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

INSERT INTO public.settings (id) VALUES (1);

-- Public read policy for booking page branding (title/description/logo only)
-- We won't expose this via anon; the public booking server fn uses service_role.

-- Auto-cancel pending bookings older than 48 hours
SELECT cron.schedule(
  'auto-cancel-stale-pending',
  '*/15 * * * *',
  $$
  UPDATE public.meetings
  SET status = 'cancelled'
  WHERE status = 'pending'
    AND created_at < now() - INTERVAL '48 hours';
  $$
);
