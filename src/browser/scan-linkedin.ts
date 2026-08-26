import "dotenv/config";

import path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright";

import {
  upsertCandidate,
  updateCandidateByProfileUrl
} from "../storage/github-json-store.js";

import {
  findEmailsWithApify
} from "./apify-email.js";

const profilePath =
  path.resolve(
    "data",
    "chrome-profile"
  );

type Experience = {
  position_order: number;

  job_title: string | null;
  company_name: string | null;
  company_url: string | null;

  employment_type: string | null;
  location: string | null;

  date_range_text: string | null;
  duration_text: string | null;

  description: string | null;
  raw_text: string;
};

type Candidate = {
  full_name: string | null;
  profile_url: string;

  headline: string | null;
  location: string | null;

  current_company_hint: string | null;
  action_type: string | null;

  scanned_at: string;
};

type ExperienceStatus =
  | "pending"
  | "scanning"
  | "completed"
  | "failed";

type EmailStatus =
  | "pending"
  | "scanning"
  | "completed"
  | "not_found"
  | "failed";

function getArgument(
  name: string
): string {
  const prefix =
    `--${name}=`;

  const argument =
    process.argv.find(
      (item) =>
        item.startsWith(prefix)
    );

  return (
    argument
      ?.slice(prefix.length)
      .trim() ??
    ""
  );
}

function normalizeText(
  value:
    | string
    | null
    | undefined
): string | null {
  const normalized =
    value
      ?.replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return normalized || null;
}

function normalizeLinkedInUrl(
  value: string
): string {
  const url =
    new URL(
      value,
      "https://www.linkedin.com"
    );

  url.search = "";
  url.hash = "";

  return url
    .toString()
    .replace(/\/$/, "");
}

function uniqueLines(
  values: string[]
): string[] {
  return [
    ...new Set(
      values
        .map(normalizeText)
        .filter(
          (
            value
          ): value is string =>
            Boolean(value)
        )
    )
  ];
}

function extractCompanyHint(
  headline: string | null
): string | null {
  if (!headline) {
    return null;
  }

  const patterns = [
    /\s+at\s+([^|•]+)/i,
    /\s+@\s*([^|•]+)/i
  ];

  for (
    const pattern of patterns
  ) {
    const company =
      normalizeText(
        headline.match(
          pattern
        )?.[1]
      );

    if (company) {
      return company;
    }
  }

  return null;
}

function looksLikeDateRange(
  value: string
): boolean {
  return (
    /\b(19|20)\d{2}\b/.test(
      value
    ) ||
    /\bPresent\b/i.test(
      value
    ) ||
    /\bHiện tại\b/i.test(
      value
    )
  );
}

function looksLikeDuration(
  value: string
): boolean {
  return (
    /\b\d+\s+(yr|yrs|year|years|mo|mos|month|months)\b/i.test(
      value
    ) ||
    /\b\d+\s+(năm|tháng)\b/i.test(
      value
    )
  );
}

function looksLikeLocation(
  value: string
): boolean {
  return (
    /Hanoi|Vietnam|Region|Ho Chi Minh|Da Nang/i.test(
      value
    ) ||
    /Remote|Hybrid|On-site/i.test(
      value
    )
  );
}

function parseCompanyLine(
  companyLine: string | null
): {
  companyName: string | null;
  employmentType: string | null;
} {
  if (!companyLine) {
    return {
      companyName: null,
      employmentType: null
    };
  }

  const parts =
    companyLine
      .split("·")
      .map(normalizeText)
      .filter(
        (
          part
        ): part is string =>
          Boolean(part)
      );

  return {
    companyName:
      parts[0] ?? null,

    employmentType:
      parts[1] ?? null
  };
}

async function getSinglePage(
  context: BrowserContext
): Promise<Page> {
  const pages =
    context.pages();

  const page =
    pages[0] ??
    await context.newPage();

  for (
    const extraPage
    of pages.slice(1)
  ) {
    await extraPage
      .close()
      .catch(
        () => undefined
      );
  }

  return page;
}

async function openSearchPage(
  page: Page,
  keyword: string
): Promise<void> {
  const url =
    new URL(
      "https://www.linkedin.com/search/results/people/"
    );

  url.searchParams.set(
    "keywords",
    keyword
  );

  url.searchParams.set(
    "origin",
    "GLOBAL_SEARCH_HEADER"
  );

  console.log(
    `[Search] Keyword: ${keyword}`
  );

  await page.goto(
    url.toString(),
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60_000
    }
  );

  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    {
      timeout:
        30_000
    }
  );
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) {
    return;
  }

  console.log(
    `[Location] ${location}`
  );

  const locationsButton =
    page
      .getByRole(
        "button",
        {
          name:
            /locations/i
        }
      )
      .first();

  await locationsButton.waitFor(
    {
      state:
        "visible",

      timeout:
        20_000
    }
  );

  await locationsButton.click();

  const locationInput =
    page
      .getByPlaceholder(
        /add a location/i
      )
      .first();

  await locationInput.waitFor(
    {
      state:
        "visible",

      timeout:
        20_000
    }
  );

  await locationInput.fill(
    location
  );

  await page.waitForTimeout(
    2_000
  );

  await locationInput.press(
    "ArrowDown"
  );

  await locationInput.press(
    "Enter"
  );

  await page.waitForTimeout(
    800
  );

  const showResults =
    page
      .getByText(
        /^Show results$/i,
        {
          exact: true
        }
      )
      .last();

  await showResults.click(
    {
      force: true,
      timeout: 20_000
    }
  );

  await page.waitForTimeout(
    3_000
  );
}

async function getCardAction(
  card: Locator
): Promise<string | null> {
  const texts =
    await card
      .locator(
        "button, a"
      )
      .allTextContents();

  const actions = [
    "Connect",
    "Message",
    "Follow",
    "View"
  ];

  for (
    const action of actions
  ) {
    const found =
      texts.some(
        (text) =>
          normalizeText(text) ===
          action
      );

    if (found) {
      return action;
    }
  }

  return null;
}

async function getFullName(
  profileLink: Locator
): Promise<string | null> {
  const rawName =
    normalizeText(
      await profileLink
        .locator(
          "span[aria-hidden='true']"
        )
        .first()
        .textContent()
        .catch(
          () => null
        )
    ) ??
    normalizeText(
      await profileLink
        .getAttribute(
          "aria-label"
        )
        .catch(
          () => null
        )
    ) ??
    normalizeText(
      await profileLink
        .textContent()
        .catch(
          () => null
        )
    );

  if (!rawName) {
    return null;
  }

  const cleanName =
    rawName
      .replace(
        /^View\s+/i,
        ""
      )
      .replace(
        /['’]s profile$/i,
        ""
      )
      .replace(
        /\s*[·•]\s*(1st|2nd|3rd\+?).*$/i,
        ""
      )
      .trim();

  return cleanName || null;
}

async function getResultContainer(
  profileLink: Locator
): Promise<Locator> {
  const knownContainer =
    profileLink.locator(
      [
        "xpath=ancestor::*[",
        "self::li",
        " or @data-chameleon-result-urn",
        " or contains(@class, 'reusable-search__result-container')",
        " or contains(@class, 'entity-result')",
        "][1]"
      ].join("")
    );

  if (
    await knownContainer.count() >
    0
  ) {
    return knownContainer.first();
  }

  return profileLink.locator(
    [
      "xpath=ancestor::div[",
      ".//a[contains(@href, '/in/')]",
      "][1]"
    ].join("")
  );
}

async function isPrimarySearchResultProfileLink(
  profileLink: Locator
): Promise<boolean> {
  const resultContainer =
    profileLink.locator(
      [
        "xpath=ancestor::*[",
        "@data-chameleon-result-urn",
        " or contains(@class, 'reusable-search__result-container')",
        " or contains(@class, 'entity-result')",
        "][1]"
      ].join("")
    );

  if (
    await resultContainer.count() ===
    0
  ) {
    return false;
  }

  const currentHref =
    await profileLink
      .getAttribute("href")
      .catch(
        () => null
      );

  if (!currentHref) {
    return false;
  }

  const currentProfileUrl =
    normalizeLinkedInUrl(
      currentHref
    );

  const profileLinks =
    resultContainer
      .first()
      .locator(
        'a[href*="/in/"]'
      );

  const linkCount =
    await profileLinks.count();

  for (
    let index = 0;
    index < linkCount;
    index += 1
  ) {
    const href =
      await profileLinks
        .nth(index)
        .getAttribute("href")
        .catch(
          () => null
        );

    if (!href) {
      continue;
    }

    const candidateUrl =
      normalizeLinkedInUrl(
        href
      );

    if (
      !candidateUrl.includes(
        "linkedin.com/in/"
      )
    ) {
      continue;
    }

    /*
     * The first LinkedIn profile URL inside a search-result card
     * belongs to the actual search result.
     *
     * Additional /in/ URLs in the same card are commonly mutual
     * connections or secondary profile references and must not be
     * scanned as candidates.
     */
    return (
      candidateUrl ===
      currentProfileUrl
    );
  }

  return false;
}

async function extractCandidateFromProfileLink(
  profileLink: Locator
): Promise<Candidate | null> {
  const href =
    await profileLink.getAttribute(
      "href"
    );

  if (!href) {
    return null;
  }

  const profileUrl =
    normalizeLinkedInUrl(
      href
    );

  if (
    !profileUrl.includes(
      "linkedin.com/in/"
    )
  ) {
    return null;
  }

  const card =
    await getResultContainer(
      profileLink
    );

  if (
    await card.count() ===
    0
  ) {
    return null;
  }

  const fullName =
    await getFullName(
      profileLink
    );

  const rawLines =
    await card
      .locator(
        "span[aria-hidden='true'], p, div"
      )
      .allTextContents();

  const cleanLines =
    uniqueLines(
      rawLines
    ).filter(
      (line) => {
        if (
          fullName &&
          (
            line ===
              fullName ||
            line.startsWith(
              `${fullName} ·`
            )
          )
        ) {
          return false;
        }

        if (
          /^(1st|2nd|3rd\+?)$/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /^(Connect|Message|Follow|View)$/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /^(Past|Current|Education):/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /mutual connection/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /^\d+\s+connections?$/i.test(
            line
          )
        ) {
          return false;
        }

        return true;
      }
    );

  const location =
    cleanLines.find(
      looksLikeLocation
    ) ?? null;

  const headline =
    cleanLines.find(
      (line) => {
        if (
          line ===
          location
        ) {
          return false;
        }

        if (
          /^(Skills|Summary|Past|Current|Education):/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /connections?$/i.test(
            line
          )
        ) {
          return false;
        }

        return (
          line.length >=
          3
        );
      }
    ) ?? null;

  const normalizedHeadline =
    normalizeText(
      headline
    );

  return {
    full_name:
      fullName,

    profile_url:
      profileUrl,

    headline:
      normalizedHeadline,

    location:
      normalizeText(
        location
      ),

    current_company_hint:
      extractCompanyHint(
        normalizedHeadline
      ),

    action_type:
      await getCardAction(
        card
      ),

    scanned_at:
      new Date()
        .toISOString()
  };
}

async function scrollSearchResults(
  page: Page
): Promise<void> {
  for (
    let index = 0;
    index < 8;
    index += 1
  ) {
    await page.evaluate(
      () => {
        window.scrollBy(
          0,
          Math.floor(
            window.innerHeight *
            0.75
          )
        );
      }
    );

    await page.waitForTimeout(
      500
    );
  }

  await page.evaluate(
    () =>
      window.scrollTo(
        0,
        0
      )
  );

  await page.waitForTimeout(
    1_500
  );
}

async function scanCurrentPage(
  page: Page,
  pageNumber: number
): Promise<Candidate[]> {
  await page.waitForTimeout(
    3_000
  );

  await scrollSearchResults(
    page
  );

  const links =
    page.locator(
      [
        'main a[href*="/in/"]',
        'div[role="main"] a[href*="/in/"]',
        'a[href^="https://www.linkedin.com/in/"]'
      ].join(", ")
    );

  const candidates:
    Candidate[] = [];

  const seen =
    new Set<string>();

  const count =
    await links.count();

  console.log(
    `[Page ${pageNumber}] ` +
    `${count} link tiềm năng`
  );

  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const link =
      links.nth(
        index
      );

    const visible =
      await link
        .isVisible()
        .catch(
          () => false
        );

    if (!visible) {
      continue;
    }

    const href =
      await link.getAttribute(
        "href"
      );

    if (!href) {
      continue;
    }

    const profileUrl =
      normalizeLinkedInUrl(
        href
      );

    if (
      !profileUrl.includes(
        "linkedin.com/in/"
      )
    ) {
      continue;
    }

    const isPrimaryProfile =
      await isPrimarySearchResultProfileLink(
        link
      );

    if (!isPrimaryProfile) {
      continue;
    }

    if (
      seen.has(
        profileUrl
      )
    ) {
      continue;
    }

    seen.add(
      profileUrl
    );

    const candidate =
      await extractCandidateFromProfileLink(
        link
      );

    if (!candidate) {
      continue;
    }

    candidates.push(
      candidate
    );

    console.log(
      `[Page ${pageNumber}] ` +
      `${candidates.length}. ` +
      `${candidate.full_name ?? "Không có tên"}`
    );
  }

  console.log(
    `[Page ${pageNumber}] ` +
    `${candidates.length} candidate`
  );

  return candidates;
}

async function saveBasicCandidates(
  candidates: Candidate[]
): Promise<void> {
  if (candidates.length === 0) {
    return;
  }

  for (const candidate of candidates) {
    upsertCandidate({
      ...candidate,

      experience_scan_status:
        "pending" as ExperienceStatus,

      email_scan_status:
        "pending" as EmailStatus
    });
  }

  console.log(
    `[JSON] Đã lưu ${candidates.length} candidate`
  );
}

async function updateCandidate(
  profileUrl: string,
  values: Record<
    string,
    unknown
  >
): Promise<void> {
  const updated =
    updateCandidateByProfileUrl(
      profileUrl,
      values
    );

  if (!updated) {
    throw new Error(
      `Không tìm thấy candidate để update: ${profileUrl}`
    );
  }
}


async function openExperiencePage(
  page: Page,
  profileUrl: string
): Promise<void> {
  const cleanProfileUrl =
    profileUrl.replace(
      /\/$/,
      ""
    );

  const experienceUrl =
    `${cleanProfileUrl}/details/experience/`;

  await page.goto(
    experienceUrl,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60_000
    }
  );

  await page.waitForTimeout(
    3_000
  );

  if (
    page.url().includes(
      "/login"
    ) ||
    page.url().includes(
      "/checkpoint"
    )
  ) {
    throw new Error(
      `LinkedIn yêu cầu login/checkpoint: ${page.url()}`
    );
  }
}

async function scrollExperiencePage(
  page: Page
): Promise<void> {
  for (
    let index = 0;
    index < 6;
    index += 1
  ) {
    await page.evaluate(
      () => {
        window.scrollBy(
          0,
          Math.floor(
            window.innerHeight *
            0.8
          )
        );
      }
    );

    await page.waitForTimeout(
      500
    );
  }

  await page.evaluate(
    () =>
      window.scrollTo(
        0,
        0
      )
  );

  await page.waitForTimeout(
    1_500
  );
}

async function getExperienceItems(
  page: Page
): Promise<Locator> {
  const selectors = [
    "main li:has(span[aria-hidden='true'])",
    "main div[data-view-name*='profile-component-entity']",
    "main section li"
  ];

  for (
    const selector
    of selectors
  ) {
    const locator =
      page.locator(
        selector
      );

    const count =
      await locator.count();

    if (count > 0) {
      return locator;
    }
  }

  return page.locator(
    "main __no_experience_items__"
  );
}

async function extractExperienceItem(
  item: Locator,
  positionOrder: number
): Promise<Experience | null> {
  const visible =
    await item
      .isVisible()
      .catch(
        () => false
      );

  if (!visible) {
    return null;
  }

  const rawValues =
    await item
      .locator(
        "span[aria-hidden='true'], p"
      )
      .allTextContents();

  const lines =
    uniqueLines(
      rawValues
    );

  if (
    lines.length <
    2
  ) {
    return null;
  }

  const dateRangeText =
    lines.find(
      looksLikeDateRange
    ) ?? null;

  if (!dateRangeText) {
    return null;
  }

  const durationText =
    lines.find(
      looksLikeDuration
    ) ?? null;

  const dateIndex =
    lines.indexOf(
      dateRangeText
    );

  const preDateLines =
    lines.slice(
      0,
      dateIndex
    );

  const jobTitle =
    preDateLines.find(
      (line) => {
        if (
          /^Experience$/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /^Skills?:/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          looksLikeDuration(
            line
          )
        ) {
          return false;
        }

        return true;
      }
    ) ?? null;

  if (!jobTitle) {
    return null;
  }

  const jobTitleIndex =
    preDateLines.indexOf(
      jobTitle
    );

  const companyLine =
    preDateLines
      .slice(
        jobTitleIndex +
        1
      )
      .find(
        (line) => {
          if (
            looksLikeDateRange(
              line
            )
          ) {
            return false;
          }

          if (
            looksLikeDuration(
              line
            )
          ) {
            return false;
          }

          return true;
        }
      ) ?? null;

  const parsedCompany =
    parseCompanyLine(
      companyLine
    );

  const companyLink =
    item
      .locator(
        'a[href*="/company/"]'
      )
      .first();

  const companyLinkCount =
    await companyLink.count();

  const linkedCompanyName =
    companyLinkCount > 0
      ? normalizeText(
          await companyLink
            .textContent()
            .catch(
              () => null
            )
        )
      : null;

  const rawCompanyUrl =
    companyLinkCount > 0
      ? normalizeText(
          await companyLink
            .getAttribute(
              "href"
            )
            .catch(
              () => null
            )
        )
      : null;

  const companyUrl =
    rawCompanyUrl
      ? normalizeLinkedInUrl(
          rawCompanyUrl
        )
      : null;

  const experienceLocation =
    lines
      .slice(
        dateIndex +
        1
      )
      .find(
        (line) => {
          if (
            line ===
            durationText
          ) {
            return false;
          }

          if (
            /^Skills?:/i.test(
              line
            )
          ) {
            return false;
          }

          return looksLikeLocation(
            line
          );
        }
      ) ?? null;

  const excluded =
    new Set(
      [
        jobTitle,
        companyLine,
        dateRangeText,
        durationText,
        experienceLocation
      ].filter(
        (
          value
        ): value is string =>
          Boolean(value)
      )
    );

  const descriptionLines =
    lines.filter(
      (line) => {
        if (
          excluded.has(
            line
          )
        ) {
          return false;
        }

        if (
          /^Experience$/i.test(
            line
          )
        ) {
          return false;
        }

        if (
          /^Skills?:/i.test(
            line
          )
        ) {
          return false;
        }

        return true;
      }
    );

  return {
    position_order:
      positionOrder,

    job_title:
      jobTitle,

    company_name:
      linkedCompanyName ??
      parsedCompany.companyName,

    company_url:
      companyUrl,

    employment_type:
      parsedCompany.employmentType,

    location:
      experienceLocation,

    date_range_text:
      dateRangeText,

    duration_text:
      durationText,

    description:
      descriptionLines.length >
      0
        ? descriptionLines.join(
            "\n"
          )
        : null,

    raw_text:
      lines.join(
        "\n"
      )
  };
}

async function extractExperiences(
  page: Page
): Promise<Experience[]> {
  await scrollExperiencePage(
    page
  );

  const items =
    await getExperienceItems(
      page
    );

  const itemCount =
    await items.count();

  const experiences:
    Experience[] = [];

  const seenRawTexts =
    new Set<string>();

  console.log(
    `[Experience] ${itemCount} item tiềm năng`
  );

  for (
    let index = 0;
    index < itemCount;
    index += 1
  ) {
    const experience =
      await extractExperienceItem(
        items.nth(index),
        experiences.length +
        1
      );

    if (!experience) {
      continue;
    }

    if (
      seenRawTexts.has(
        experience.raw_text
      )
    ) {
      continue;
    }

    seenRawTexts.add(
      experience.raw_text
    );

    experiences.push(
      experience
    );

    console.log(
      `[Experience] ` +
      `${experiences.length}. ` +
      `${experience.job_title ?? "Unknown"} | ` +
      `${experience.company_name ?? "Unknown"}`
    );
  }

  return experiences;
}

async function scanAndUpdateCandidateExperience(
  page: Page,
  candidate: Candidate
): Promise<void> {
  await updateCandidate(
    candidate.profile_url,
    {
      experience_scan_status:
        "scanning",

      experience_scan_error:
        null
    }
  );

  try {
    console.log(
      `[Experience] Đang scan: ` +
      `${candidate.full_name ?? candidate.profile_url}`
    );

    await openExperiencePage(
      page,
      candidate.profile_url
    );

    const experiences =
      await extractExperiences(
        page
      );

    await updateCandidate(
      candidate.profile_url,
      {
        experiences,

        experience_count:
          experiences.length,

        experience_scan_status:
          "completed",

        experience_scanned_at:
          new Date()
            .toISOString(),

        experience_scan_error:
          null
      }
    );

    console.log(
      `[Experience] Đã lưu ${experiences.length} position`
    );
  } catch (
    error: unknown
  ) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await updateCandidate(
      candidate.profile_url,
      {
        experiences: [],

        experience_count:
          0,

        experience_scan_status:
          "failed",

        experience_scanned_at:
          new Date()
            .toISOString(),

        experience_scan_error:
          message
      }
    );

    console.error(
      `[Experience] Lỗi: ${message}`
    );
  }
}

async function scanAndUpdateCandidateEmail(
  candidate: Candidate
): Promise<void> {
  await updateCandidate(
    candidate.profile_url,
    {
      email_scan_status:
        "scanning",

      email_scan_error:
        null
    }
  );

  try {
    console.log(
      `[Email] Đang tìm: ` +
      `${candidate.full_name ?? candidate.profile_url}`
    );

    const result =
      await findEmailsWithApify(
        candidate.profile_url
      );

    const checkedAt =
      new Date()
        .toISOString();

    if (
      result.emails.length ===
      0
    ) {
      await updateCandidate(
        candidate.profile_url,
        {
          emails: [],

          work_email:
            null,

          personal_emails:
            [],

          email_count:
            0,

          email_source:
            null,

          email_scan_status:
            "not_found",

          email_checked_at:
            checkedAt,

          email_scan_error:
            null
        }
      );

      console.log(
        "[Email] Không tìm thấy email"
      );

      return;
    }

    await updateCandidate(
      candidate.profile_url,
      {
        emails:
          result.emails,

        work_email:
          result.workEmail,

        personal_emails:
          result.personalEmails,

        email_count:
          result.emails.length,

        email_source:
          result.source,

        email_scan_status:
          "completed",

        email_checked_at:
          checkedAt,

        email_scan_error:
          null
      }
    );

    console.log(
      `[Email] Đã lưu ${result.emails.length} email`
    );

    result.emails.forEach(
      (
        email,
        index
      ) => {
        console.log(
          `  ${index + 1}. ${email}`
        );
      }
    );
  } catch (
    error: unknown
  ) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await updateCandidate(
      candidate.profile_url,
      {
        emails: [],

        work_email:
          null,

        personal_emails:
          [],

        email_count:
          0,

        email_source:
          null,

        email_scan_status:
          "failed",

        email_checked_at:
          new Date()
            .toISOString(),

        email_scan_error:
          message
      }
    );

    console.error(
      `[Email] Lỗi: ${message}`
    );
  }
}

function buildSearchPageUrl(
  baseUrl: string,
  pageNumber: number
): string {
  const url =
    new URL(
      baseUrl
    );

  url.searchParams.set(
    "page",
    String(pageNumber)
  );

  return url.toString();
}

async function main(): Promise<void> {
  const keyword =
    getArgument(
      "keyword"
    );

  const location =
    getArgument(
      "location"
    );

  const pagesToScan =
    Number(
      getArgument(
        "pages"
      ) || "3"
    );

  const profileLimit =
    Number(
      getArgument(
        "profile-limit"
      ) || "0"
    );

  if (!keyword) {
    throw new Error(
      'Thiếu keyword. Ví dụ: --keyword="AI Automation"'
    );
  }

  if (
    !Number.isInteger(
      pagesToScan
    ) ||
    pagesToScan <
      1 ||
    pagesToScan >
      3
  ) {
    throw new Error(
      "--pages phải là số từ 1 đến 3."
    );
  }

  if (
    !Number.isInteger(
      profileLimit
    ) ||
    profileLimit <
      0
  ) {
    throw new Error(
      "--profile-limit phải là số nguyên từ 0 trở lên."
    );
  }

  let context:
    BrowserContext |
    null = null;

  try {
    context =
      await chromium
        .launchPersistentContext(
          profilePath,
          {
            channel:
              "chrome",

            headless:
              false,

            viewport:
              null,

            args: [
              "--start-maximized",
              "--no-first-run",
              "--no-default-browser-check"
            ]
          }
        );

    const page =
      await getSinglePage(
        context
      );

    await openSearchPage(
      page,
      keyword
    );

    await applyLocationFilter(
      page,
      location
    );

    const filteredSearchUrl =
      page.url();

    let processedProfiles =
      0;

    for (
      let pageNumber = 1;
      pageNumber <= pagesToScan;
      pageNumber += 1
    ) {
      const searchPageUrl =
        buildSearchPageUrl(
          filteredSearchUrl,
          pageNumber
        );

      console.log("");
      console.log(
        `[Navigation] Trang ${pageNumber}`
      );

      await page.goto(
        searchPageUrl,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            60_000
        }
      );

      await page.waitForTimeout(
        3_000
      );

      const candidates =
        await scanCurrentPage(
          page,
          pageNumber
        );

      await saveBasicCandidates(
        candidates
      );

      for (
        const candidate
        of candidates
      ) {
        if (
          profileLimit >
            0 &&
          processedProfiles >=
            profileLimit
        ) {
          break;
        }

        await scanAndUpdateCandidateExperience(
          page,
          candidate
        );

        await scanAndUpdateCandidateEmail(
          candidate
        );

        processedProfiles +=
          1;

        await page.waitForTimeout(
          2_000
        );
      }

      if (
        profileLimit >
          0 &&
        processedProfiles >=
          profileLimit
      ) {
        break;
      }
    }

    console.log("");
    console.log(
      `Hoàn thành ${processedProfiles} profile.`
    );
  } finally {
    await context
      ?.close()
      .catch(
        () => undefined
      );
  }
}

main().catch(
  (
    error: unknown
  ) => {
    console.error(
      "\nLinkedIn sourcing flow thất bại:"
    );

    if (
      error instanceof Error
    ) {
      console.error(
        error.message
      );

      console.error(
        error.stack
      );
    } else {
      console.error(
        error
      );
    }

    process.exit(
      1
    );
  }
);
