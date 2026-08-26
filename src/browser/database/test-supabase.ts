import { supabase } from "./supabase.js";

async function main(): Promise<void> {
  const testProfileUrl =
    `https://www.linkedin.com/in/test-${Date.now()}`;

  const { data, error } = await supabase
    .from("linkedin_candidates")
    .insert({
      full_name: "Supabase Test Candidate",
      profile_url: testProfileUrl,
      headline: "Test headline",
      location: "Hanoi Capital Region",
      current_company_hint: "Test Company",
      action_type: "Connect",
      scanned_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  console.log("Supabase connected successfully:");
  console.log(data);
}

main().catch((error: unknown) => {
  console.error("Supabase test failed:", error);
  process.exit(1);
});
