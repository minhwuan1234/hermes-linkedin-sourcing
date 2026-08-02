type ApifyEmailResult = {
  linkedin_url?: string | null;
  full_name?: string | null;
  job_title?: string | null;
  company?: string | null;
  work_email?: string | null;
  personal_emails?: string[] | null;
  has_email?: string | boolean | null;
};

export type EmailLookupResult = {
  emails: string[];
  workEmail: string | null;
  personalEmails: string[];
  source: "apify" | null;
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();

  if (!email) {
    return null;
  }

  const valid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  return valid ? email : null;
}

function uniqueEmails(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeEmail)
        .filter(
          (email): email is string =>
            Boolean(email)
        )
    )
  ];
}

function parseResult(
  result: ApifyEmailResult
): EmailLookupResult {
  const workEmail =
    normalizeEmail(result.work_email);

  const personalEmails =
    uniqueEmails(
      Array.isArray(result.personal_emails)
        ? result.personal_emails
        : []
    );

  const emails = uniqueEmails([
    workEmail,
    ...personalEmails
  ]);

  return {
    emails,
    workEmail,
    personalEmails,
    source:
      emails.length > 0
        ? "apify"
        : null
  };
}

export async function findEmailsWithApify(
  profileUrl: string
): Promise<EmailLookupResult> {
  const token =
    process.env.APIFY_API_TOKEN?.trim();

  const actorId =
    process.env.APIFY_ACTOR_ID?.trim() ||
    "q3wko0Sbx6ZAAB2xf";

  if (!token) {
    throw new Error(
      "Missing APIFY_API_TOKEN"
    );
  }

  const endpoint =
    `https://api.apify.com/v2/actors/` +
    `${encodeURIComponent(actorId)}/` +
    `run-sync-get-dataset-items` +
    `?format=json&clean=true&timeout=300`;

  const response = await fetch(endpoint, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      linkedin_url: profileUrl
    }),

    signal: AbortSignal.timeout(310_000)
  });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Apify request failed ${response.status}: ` +
      responseText.slice(0, 500)
    );
  }

  let output: unknown;

  try {
    output = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Apify output không phải JSON."
    );
  }

  const items =
    Array.isArray(output)
      ? output
      : [];

  const result =
    items[0] as ApifyEmailResult | undefined;

  if (!result) {
    return {
      emails: [],
      workEmail: null,
      personalEmails: [],
      source: null
    };
  }

  return parseResult(result);
}
