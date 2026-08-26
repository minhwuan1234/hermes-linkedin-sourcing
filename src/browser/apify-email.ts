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

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function normalizeLinkedInUrl(value: string): string {
  const url = new URL(
    value,
    "https://www.linkedin.com"
  );

  url.search = "";
  url.hash = "";

  return url
    .toString()
    .replace(/\/$/, "")
    .toLowerCase();
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

  const emails =
    uniqueEmails([
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

  const normalizedInputUrl =
    normalizeLinkedInUrl(profileUrl);

  const endpoint =
    `https://api.apify.com/v2/actors/` +
    `${encodeURIComponent(actorId)}/` +
    `run-sync-get-dataset-items` +
    `?format=json&clean=true&timeout=300`;

  const actorInput = {
    includePersonalEmails: true,
    includeWorkEmails: true,

    linkedinUrls: [
      profileUrl
    ],

    onlyWithEmails: true
  };

  console.log(
    `[Apify] Actor: ${actorId}`
  );

  console.log(
    `[Apify] Input URL: ${profileUrl}`
  );

  const response = await fetch(
    endpoint,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${token}`,

        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify(
          actorInput
        ),

      signal:
        AbortSignal.timeout(
          310_000
        )
    }
  );

  const responseText =
    await response.text();

  console.log(
    `[Apify] HTTP status: ${response.status}`
  );

  if (!response.ok) {
    throw new Error(
      `Apify request failed ${response.status}: ` +
      responseText.slice(0, 800)
    );
  }

  let output: unknown;

  try {
    output =
      JSON.parse(
        responseText
      );
  } catch {
    throw new Error(
      "Apify output không phải JSON."
    );
  }

  if (!Array.isArray(output)) {
    throw new Error(
      "Apify output không phải dataset item array."
    );
  }

  console.log(
    `[Apify] Output items: ${output.length}`
  );

  const results =
    output as ApifyEmailResult[];

  if (
    results.length ===
    0
  ) {
    return {
      emails: [],
      workEmail: null,
      personalEmails: [],
      source: null
    };
  }

  /*
    Chỉ nhận output có LinkedIn URL khớp với candidate.
    Tránh đọc nhầm dữ liệu mẫu hoặc dữ liệu của profile khác.
  */
  const matchedResult =
    results.find(
      (item) => {
        if (!item.linkedin_url) {
          return false;
        }

        try {
          return (
            normalizeLinkedInUrl(
              item.linkedin_url
            ) ===
            normalizedInputUrl
          );
        } catch {
          return false;
        }
      }
    );

  if (!matchedResult) {
    const returnedUrls =
      results
        .map(
          (item) =>
            item.linkedin_url
        )
        .filter(Boolean);

    throw new Error(
      `Apify output không khớp input URL. ` +
      `Input: ${profileUrl}. ` +
      `Output URLs: ${JSON.stringify(returnedUrls)}`
    );
  }

  console.log(
    `[Apify] Matched output: ${matchedResult.linkedin_url}`
  );

  return parseResult(
    matchedResult
  );
}
