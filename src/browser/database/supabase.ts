import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("Thiếu SUPABASE_URL trong file .env");
}

if (!serviceRoleKey) {
  throw new Error(
    "Thiếu SUPABASE_SERVICE_ROLE_KEY trong file .env"
  );
}

export const supabase = createClient(
  supabaseUrl,
  serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);
