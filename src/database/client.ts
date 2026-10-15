import { createClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config.js";

/** Build a server-only client. Disabling auth session behavior prevents key persistence or refresh. */
export function createDatabase(config: AppConfig) {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: { "x-application-name": "riven-server" }
    }
  });
}
