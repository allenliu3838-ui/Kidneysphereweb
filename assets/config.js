/**
 * Runtime config (no build step).
 *
 * ✅ This file is intentionally kept in /assets and served with no-store on Netlify
 *    (see netlify.toml) so you can edit keys and refresh immediately.
 *
 * - Works as an ES Module (export constants)
 * - Also writes to window.* so older code / non-module scripts can still read it.
 */

export const SUPABASE_URL = "https://eaatpwakhcjxjonlyfii.supabase.co";

export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYXRwd2FraGNqeGpvbmx5ZmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5MDUzMzMsImV4cCI6MjA4MjQ4MTMzM30.OZ6mhKVsOKfJeI6opkk7GxRJuv0kY__k5N936h261PI";

// Feature flags
export const REQUIRE_DOCTOR_VERIFICATION_FOR_DISCUSSION = false;

// Backward compatibility (window globals)
try {
  if (typeof window !== "undefined") {
    window.SUPABASE_URL = SUPABASE_URL;
    window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
    window.REQUIRE_DOCTOR_VERIFICATION_FOR_DISCUSSION =
      REQUIRE_DOCTOR_VERIFICATION_FOR_DISCUSSION;
  }
} catch (_e) {
  // ignore
}

// Helpful during QA
try {
  console.log("✅ config.js loaded", SUPABASE_URL);
} catch (_e) {
  // ignore
}
