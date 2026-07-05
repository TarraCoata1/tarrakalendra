import { createFileRoute } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";

export const Route = createFileRoute("/api/public/oauth/google/start")({
  server: {
    handlers: {
      GET: async () => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId) return new Response("GOOGLE_CLIENT_ID not configured", { status: 500 });
        const req = getRequest();
        const url = new URL(req.url);
        const redirectUri = `${url.origin}/api/public/oauth/google/callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email",
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        });
        return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
      },
    },
  },
});
