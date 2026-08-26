import "dotenv/config";

import { supabase } from "./database/supabase.js";
import { findEmailsWithApify } from "./apify-email.js";

type Candidate = {
  id: string;
  full_name: string | null;
  profile_url: string;
  email_scan_status: string | null;
};

function getArgument(name: string): string {
  const prefix = `--${name}=`;

  const argument = process.argv.find((item) =>
    item.startsWith(prefix)
  );

  return argument?.slice(prefix.length).trim() ?? "";
}

function parseBoolean(value: string): boolean {
  return ["true", "1", "yes"].includes(
    value.trim().toLowerCase()
  );
}

async function getCandidates(
  limit: number,
  retry: boolean
): Promise<Candidate[]> {
  let query = supabase
    .from("linkedin_candidates")
    .select(
      [
        "id",
        "full_name",
        "profile_url",
        "email_scan_status"
      ].join(",")
    )
    .not("profile_url", "is", null)
    .order("scanned_at", {
      ascending: true
    });

  if (!retry) {
    query = query.or(
      [
        "email_scan_status.is.null",
        "email_scan_status.eq.pending"
      ].join(",")
    );
  }

  if (limit > 0) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `Không lấy được candidates: ${error.message}`
    );
  }

  return (data ?? []) as Candidate[];
}

async function updateCandidate(
  profileUrl: string,
  values: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("linkedin_candidates")
    .update(values)
    .eq("profile_url", profileUrl);

  if (error) {
    throw new Error(
      `Không update được candidate: ${error.message}`
    );
  }
}

async function scanCandidateEmail(
  candidate: Candidate
): Promise<void> {
  console.log("");
  console.log(
    `[Email] Đang tìm: ${
      candidate.full_name ?? candidate.profile_url
    }`
  );

  await updateCandidate(
    candidate.profile_url,
    {
      email_scan_status: "scanning",
      email_scan_error: null
    }
  );

  try {
    const result = await findEmailsWithApify(
      candidate.profile_url
    );

    const checkedAt = new Date().toISOString();

    if (result.emails.length === 0) {
      await updateCandidate(
        candidate.profile_url,
        {
          emails: [],
          work_email: null,
          personal_emails: [],
          email_count: 0,
          email_source: null,
          email_scan_status: "not_found",
          email_checked_at: checkedAt,
          email_scan_error: null
        }
      );

      console.log("[Email] Không tìm thấy.");

      return;
    }

    await updateCandidate(
      candidate.profile_url,
      {
        emails: result.emails,
        work_email: result.workEmail,
        personal_emails: result.personalEmails,
        email_count: result.emails.length,
        email_source: result.source,
        email_scan_status: "completed",
        email_checked_at: checkedAt,
        email_scan_error: null
      }
    );

    console.log(
      `[Email] Đã lưu ${result.emails.length} email:`
    );

    result.emails.forEach((email, index) => {
      console.log(`  ${index + 1}. ${email}`);
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await updateCandidate(
      candidate.profile_url,
      {
        emails: [],
        work_email: null,
        personal_emails: [],
        email_count: 0,
        email_source: null,
        email_scan_status: "failed",
        email_checked_at: new Date().toISOString(),
        email_scan_error: message
      }
    );

    console.error(`[Email] Lỗi: ${message}`);
  }
}

async function main(): Promise<void> {
  const limit = Number(
    getArgument("limit") || "0"
  );

  const retry = parseBoolean(
    getArgument("retry") || "false"
  );

  if (
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    throw new Error(
      "--limit phải là số nguyên từ 0 trở lên."
    );
  }

  const candidates = await getCandidates(
    limit,
    retry
  );

  console.log(
    `Tìm thấy ${candidates.length} candidate cần quét email.`
  );

  if (candidates.length === 0) {
    return;
  }

  let completed = 0;

  for (const candidate of candidates) {
    await scanCandidateEmail(candidate);

    completed += 1;

    console.log(
      `[Progress] ${completed}/${candidates.length}`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 1_500)
    );
  }

  console.log("");
  console.log(
    `Hoàn thành quét email cho ${completed} candidate.`
  );
}

main().catch((error: unknown) => {
  console.error("\nEmail scan thất bại:");

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exit(1);
});
