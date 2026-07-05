import { createFileRoute } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/oauth/google/callback")({
  server: {
    handlers: {
      GET: async () => {
        const req = getRequest();
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        if (err)
          return Response.redirect(
            `${url.origin}/settings?google_error=${encodeURIComponent(err)}`,
            302,
          );
        if (!code) return new Response("Missing code", { status: 400 });

        const clientId = process.env.GOOGLE_CLIENT_ID!;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
        const redirectUri = `${url.origin}/api/public/oauth/google/callback`;

        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });
        if (!tokenResp.ok) {
          const t = await tokenResp.text();
          return new Response(`Token exchange failed: ${t}`, { status: 500 });
        }
        const tokens = await tokenResp.json();

        // Fetch email
        let email: string | null = null;
        try {
          const infoResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (infoResp.ok) {
            const info = await infoResp.json();
            email = info.email ?? null;
          }
        } catch {
          /* ignore */
        }

        const svc = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
        const patch: Record<string, unknown> = {
          google_connected: true,
          google_account_email: email,
          google_access_token: tokens.access_token,
          google_token_expiry: expiry,
        };
        // Google only returns a refresh_token on some grants (first consent,
        // or when prompt=consent forces re-approval — which start.ts always
        // sets). If it's ever missing on a reconnect, don't overwrite a
        // previously-working refresh token with null.
        if (tokens.refresh_token) {
          patch.google_refresh_token = tokens.refresh_token;
        } else {
          console.error(
            "[google oauth] No refresh_token in token response — keeping existing one, if any",
          );
        }
        await svc.from("settings").update(patch).eq("id", 1);

        return Response.redirect(`${url.origin}/settings?google=connected`, 302);
      },
    },
  },
});
