import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright";
import path from "node:path";
import { supabase } from "./database/supabase.js";

const profilePath = path.resolve("data", "chrome-profile");

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

  experiences?: Experience[];
  experience_count?: number;
  experience_scan_status?: "pending" | "scanning" | "completed" | "failed";
  experience_scanned_at?: string | null;
  experience_scan_error?: string | null;
};

function getArgument(name: string): string {
  const prefix = `--${name}=`;

  const argument = process.argv.find((item) =>
    item.startsWith(prefix)
  );

  return argument?.slice(prefix.length).trim() ?? "";
}

function normalizeText(
  value: string | null | undefined
): string | null {
  const normalized = value
    ?.replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || null;
}

function normalizeProfileUrl(value: string): string {
  const url = new URL(
    value,
    "https://www.linkedin.com"
  );

  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function normalizeLinkedInUrl(
  value: string | null
): string | null {
  if (!value) {
    return null;
  }

  return normalizeProfileUrl(value);
}

function uniqueLines(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
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

  for (const pattern of patterns) {
    const match = headline.match(pattern);
    const company = normalizeText(match?.[1]);

    if (company) {
      return company;
    }
  }

  return null;
}

function looksLikeDateRange(value: string): boolean {
  return (
    /\b(19|20)\d{2}\b/.test(value) ||
    /\bPresent\b/i.test(value) ||
    /\bHiện tại\b/i.test(value)
  );
}

function looksLikeDuration(value: string): boolean {
  return (
    /\b\d+\s+(yr|yrs|year|years|mo|mos|month|months)\b/i.test(
      value
    ) ||
    /\b\d+\s+(năm|tháng)\b/i.test(value)
  );
}

function looksLikeLocation(value: string): boolean {
  return (
    /Hanoi|Vietnam|Region|Ho Chi Minh|Da Nang/i.test(
      value
    ) ||
    /Remote|Hybrid|On-site/i.test(value)
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

  const parts = companyLine
    .split("·")
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part));

  return {
    companyName: parts[0] ?? null,
    employmentType: parts[1] ?? null
  };
}

async function getSinglePage(
  context: BrowserContext
): Promise<Page> {
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();

  for (const extraPage of pages.slice(1)) {
    await extraPage.close().catch(() => undefined);
  }

  return page;
}

async function openSearchPage(
  page: Page,
  keyword: string
): Promise<void> {
  const searchUrl = new URL(
    "https://www.linkedin.com/search/results/people/"
  );

  searchUrl.searchParams.set("keywords", keyword);
  searchUrl.searchParams.set(
    "origin",
    "GLOBAL_SEARCH_HEADER"
  );

  console.log("[Search] Đang mở danh sách ứng viên...");

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    {
      timeout: 30_000
    }
  );

  console.log(`[Search] Keyword: ${keyword}`);
  console.log(`[Search] URL: ${page.url()}`);
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) {
    console.log(
      "[Location] Không sử dụng location filter."
    );

    return;
  }

  console.log("[Location] Đang mở Locations...");

  const locationsButton = page
    .getByRole("button", {
      name: /locations/i
    })
    .first();

  await locationsButton.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await locationsButton.click();

  const locationInput = page
    .getByPlaceholder(/add a location/i)
    .first();

  await locationInput.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await locationInput.fill(location);

  console.log(`[Location] Đã nhập: ${location}`);

  await page.waitForTimeout(2_000);

  await locationInput.press("ArrowDown");
  await page.waitForTimeout(300);
  await locationInput.press("Enter");

  console.log("[Location] Đã chọn suggestion.");

  await page.waitForTimeout(1_000);

  const showResults = page
    .getByText(/^Show results$/i, {
      exact: true
    })
    .last();

  await showResults.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await showResults.click({
    force: true,
    timeout: 20_000
  });

  console.log("[Location] Đã bấm Show results.");

  await page.waitForTimeout(3_000);

  if (
    !page
      .url()
      .includes("/search/results/people")
  ) {
    throw new Error(
      `Location filter chuyển sai trang: ${page.url()}`
    );
  }

  console.log(
    `[Location] URL sau filter: ${page.url()}`
  );
}

async function getCardAction(
  card: Locator
): Promise<string | null> {
  const supportedActions = [
    "Connect",
    "Message",
    "Follow",
    "View"
  ];

  const texts = await card
    .locator("button, a")
    .allTextContents();

  for (const action of supportedActions) {
    const found = texts.some(
      (text) => normalizeText(text) === action
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
  const spanText = normalizeText(
    await profileLink
      .locator("span[aria-hidden='true']")
      .first()
      .textContent()
      .catch(() => null)
  );

  const ariaLabel = normalizeText(
    await profileLink
      .getAttribute("aria-label")
      .catch(() => null)
  );

  const linkText = normalizeText(
    await profileLink
      .textContent()
      .catch(() => null)
  );

  const rawName =
    spanText ??
    ariaLabel ??
    linkText;

  if (!rawName) {
    return null;
  }

  const cleanedName = rawName
    .replace(/^View\s+/i, "")
    .replace(/['’]s profile$/i, "")
    .replace(
      /\s*[·•]\s*(1st|2nd|3rd\+?).*$/i,
      ""
    )
    .trim();

  return cleanedName || null;
}

async function getResultContainer(
  profileLink: Locator
): Promise<Locator> {
  const knownContainer = profileLink.locator(
    [
      "xpath=ancestor::*[",
      "self::li",
      " or @data-chameleon-result-urn",
      " or contains(@class, 'reusable-search__result-container')",
      " or contains(@class, 'entity-result')",
      "][1]"
    ].join("")
  );

  if ((await knownContainer.count()) > 0) {
    return knownContainer.first();
  }

  return profileLink.locator(
    [
      "xpath=ancestor::div[",
      ".//a[contains(@href, '/in/')]",
      " and (",
      ".//button",
      " or .//span",
      ")",
      "][1]"
    ].join("")
  );
}

async function extractCandidateFromProfileLink(
  profileLink: Locator
): Promise<Candidate | null> {
  const href = await profileLink.getAttribute("href");

  if (!href) {
    return null;
  }

  const profileUrl = normalizeProfileUrl(href);

  if (
    !profileUrl.includes(
      "linkedin.com/in/"
    )
  ) {
    return null;
  }

  const card = await getResultContainer(profileLink);

  if ((await card.count()) === 0) {
    console.log(
      `[Skip] Không tìm thấy card cho ${profileUrl}`
    );

    return null;
  }

  const fullName =
    await getFullName(profileLink);

  const rawLines = await card
    .locator(
      "span[aria-hidden='true'], p, div"
    )
    .allTextContents();

  const cleanLines = uniqueLines(rawLines).filter(
    (line) => {
      if (fullName && line === fullName) {
        return false;
      }

      if (
        fullName &&
        line.startsWith(`${fullName} ·`)
      ) {
        return false;
      }

      if (
        /^(1st|2nd|3rd\+?)$/i.test(line)
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
        /mutual connection/i.test(line)
      ) {
        return false;
      }

      if (
        /^\d+\s+connections?$/i.test(line)
      ) {
        return false;
      }

      return true;
    }
  );

  const location =
    cleanLines.find(looksLikeLocation) ?? null;

  const headline =
    cleanLines.find((line) => {
      if (line === location) {
        return false;
      }

      if (/^Skills:/i.test(line)) {
        return false;
      }

      if (/^Summary:/i.test(line)) {
        return false;
      }

      if (/^Past:/i.test(line)) {
        return false;
      }

      if (/^Current:/i.test(line)) {
        return false;
      }

      if (/^Education:/i.test(line)) {
        return false;
      }

      if (/connections?$/i.test(line)) {
        return false;
      }

      if (line.length < 3) {
        return false;
      }

      return true;
    }) ?? null;

  const normalizedHeadline =
    normalizeText(headline);

  return {
    full_name: fullName,
    profile_url: profileUrl,
    headline: normalizedHeadline,
    location: normalizeText(location),
    current_company_hint:
      extractCompanyHint(
        normalizedHeadline
      ),
    action_type:
      await getCardAction(card),
    scanned_at:
      new Date().toISOString(),

    experiences: [],
    experience_count: 0,
    experience_scan_status: "pending",
    experience_scanned_at: null,
    experience_scan_error: null
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
    await page.evaluate(() => {
      window.scrollBy(
        0,
        Math.floor(
          window.innerHeight * 0.75
        )
      );
    });

    await page.waitForTimeout(500);
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(2_000);
}

async function scanCurrentPage(
  page: Page,
  pageNumber: number
): Promise<Candidate[]> {
  await page.waitForTimeout(3_000);
  await scrollSearchResults(page);

  const allProfileLinks = page.locator(
    [
      'main a[href*="/in/"]',
      'div[role="main"] a[href*="/in/"]',
      'a[href^="https://www.linkedin.com/in/"]'
    ].join(", ")
  );

  const totalLinks =
    await allProfileLinks.count();

  console.log(
    `[Page ${pageNumber}] Tìm thấy ${totalLinks} link /in/.`
  );

  const candidates: Candidate[] = [];
  const seenProfileUrls =
    new Set<string>();

  for (
    let index = 0;
    index < totalLinks;
    index += 1
  ) {
    const link =
      allProfileLinks.nth(index);

    const visible = await link
      .isVisible()
      .catch(() => false);

    if (!visible) {
      continue;
    }

    const href =
      await link.getAttribute("href");

    if (!href) {
      continue;
    }

    const profileUrl =
      normalizeProfileUrl(href);

    if (
      !profileUrl.includes(
        "linkedin.com/in/"
      )
    ) {
      continue;
    }

    if (
      seenProfileUrls.has(
        profileUrl
      )
    ) {
      continue;
    }

    seenProfileUrls.add(profileUrl);

    const candidate =
      await extractCandidateFromProfileLink(
        link
      );

    if (!candidate) {
      continue;
    }

    candidates.push(candidate);

    console.log(
      [
        `[Page ${pageNumber}]`,
        `${candidates.length}.`,
        candidate.full_name ??
          "Không có tên",
        "|",
        candidate.profile_url
      ].join(" ")
    );
  }

  console.log(
    `[Page ${pageNumber}] Đã extract ${candidates.length} ứng viên.`
  );

  return candidates;
}

async function saveBasicCandidates(
  candidates: Candidate[]
): Promise<void> {
  if (candidates.length === 0) {
    console.log(
      "[Supabase] Không có ứng viên cơ bản để lưu."
    );

    return;
  }

  const payload = candidates.map(
    (candidate) => ({
      full_name: candidate.full_name,
      profile_url: candidate.profile_url,
      headline: candidate.headline,
      location: candidate.location,
      current_company_hint:
        candidate.current_company_hint,
      action_type: candidate.action_type,
      scanned_at: candidate.scanned_at
    })
  );

  const { error } = await supabase
    .from("linkedin_candidates")
    .upsert(payload, {
      onConflict: "profile_url"
    });

  if (error) {
    throw new Error(
      `Không lưu được candidate cơ bản: ${error.message}`
    );
  }

  console.log(
    `[Supabase] Đã lưu ${candidates.length} candidate cơ bản.`
  );
}

async function updateExperienceStatus(
  profileUrl: string,
  values: {
    experiences?: Experience[];
    experience_count?: number;
    experience_scan_status?:
      | "pending"
      | "scanning"
      | "completed"
      | "failed";
    experience_scanned_at?: string | null;
    experience_scan_error?: string | null;
  }
): Promise<void> {
  const { error } = await supabase
    .from("linkedin_candidates")
    .update(values)
    .eq("profile_url", profileUrl);

  if (error) {
    throw new Error(
      `Không update được experience status: ${error.message}`
    );
  }
}

async function openExperiencePage(
  page: Page,
  profileUrl: string
): Promise<void> {
  const cleanProfileUrl =
    profileUrl.replace(/\/$/, "");

  const experienceUrl =
    `${cleanProfileUrl}/details/experience/`;

  await page.goto(experienceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForTimeout(3_000);

  if (
    page.url().includes("/login") ||
    page.url().includes("/checkpoint")
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
    await page.evaluate(() => {
      window.scrollBy(
        0,
        Math.floor(
          window.innerHeight * 0.8
        )
      );
    });

    await page.waitForTimeout(500);
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(1_500);
}

async function getExperienceItems(
  page: Page
): Promise<Locator> {
  const selectors = [
    "main li:has(span[aria-hidden='true'])",
    "main div[data-view-name*='profile-component-entity']",
    "main section li"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    if (count > 0) {
      return locator;
    }
  }

  return page.locator(
    "main __no_experience_items__"
  );
}

async function findCompanyLink(
  item: Locator
): Promise<{
  companyName: string | null;
  companyUrl: string | null;
}> {
  const companyLink = item
    .locator('a[href*="/company/"]')
    .first();

  if ((await companyLink.count()) > 0) {
    return {
      companyName: normalizeText(
        await companyLink
          .textContent()
          .catch(() => null)
      ),
      companyUrl: normalizeLinkedInUrl(
        await companyLink
          .getAttribute("href")
          .catch(() => null)
      )
    };
  }

  return {
    companyName: null,
    companyUrl: null
  };
}

async function extractExperienceItem(
  item: Locator,
  positionOrder: number
): Promise<Experience | null> {
  const visible = await item
    .isVisible()
    .catch(() => false);

  if (!visible) {
    return null;
  }

  const rawValues = await item
    .locator(
      "span[aria-hidden='true'], p"
    )
    .allTextContents();

  const lines = uniqueLines(rawValues);

  if (lines.length < 2) {
    return null;
  }

  const dateRangeText =
    lines.find(looksLikeDateRange) ?? null;

  if (!dateRangeText) {
    return null;
  }

  const durationText =
    lines.find(looksLikeDuration) ?? null;

  const dateIndex =
    lines.indexOf(dateRangeText);

  const preDateLines =
    lines.slice(0, dateIndex);

  const jobTitle =
    preDateLines.find((line) => {
      if (/^Experience$/i.test(line)) {
        return false;
      }

      if (/^Skills?:/i.test(line)) {
        return false;
      }

      if (looksLikeDuration(line)) {
        return false;
      }

      return true;
    }) ?? null;

  if (!jobTitle) {
    return null;
  }

  const jobTitleIndex =
    preDateLines.indexOf(jobTitle);

  const companyLine =
    preDateLines
      .slice(jobTitleIndex + 1)
      .find((line) => {
        if (line === dateRangeText) {
          return false;
        }

        if (looksLikeDateRange(line)) {
          return false;
        }

        if (looksLikeDuration(line)) {
          return false;
        }

        return true;
      }) ?? null;

  const parsedCompany =
    parseCompanyLine(companyLine);

  const linkedCompany =
    await findCompanyLink(item);

  const experienceLocation =
    lines
      .slice(dateIndex + 1)
      .find((line) => {
        if (line === durationText) {
          return false;
        }

        if (/^Skills?:/i.test(line)) {
          return false;
        }

        return looksLikeLocation(line);
      }) ?? null;

  const excludedLines = new Set(
    [
      jobTitle,
      companyLine,
      dateRangeText,
      durationText,
      experienceLocation
    ].filter(
      (value): value is string =>
        Boolean(value)
    )
  );

  const descriptionLines =
    lines.filter((line) => {
      if (excludedLines.has(line)) {
        return false;
      }

      if (/^Experience$/i.test(line)) {
        return false;
      }

      if (/^Skills?:/i.test(line)) {
        return false;
      }

      return true;
    });

  return {
    position_order: positionOrder,
    job_title: jobTitle,
    company_name:
      linkedCompany.companyName ??
      parsedCompany.companyName,
    company_url:
      linkedCompany.companyUrl,
    employment_type:
      parsedCompany.employmentType,
    location:
      experienceLocation,
    date_range_text:
      dateRangeText,
    duration_text:
      durationText,
    description:
      descriptionLines.length > 0
        ? descriptionLines.join("\n")
        : null,
    raw_text:
      lines.join("\n")
  };
}

async function extractExperiences(
  page: Page
): Promise<Experience[]> {
  await scrollExperiencePage(page);

  const items =
    await getExperienceItems(page);

  const itemCount =
    await items.count();

  console.log(
    `[Experience] Tìm thấy ${itemCount} item tiềm năng.`
  );

  const experiences: Experience[] = [];
  const seenRawTexts = new Set<string>();

  for (
    let index = 0;
    index < itemCount;
    index += 1
  ) {
    const experience =
      await extractExperienceItem(
        items.nth(index),
        experiences.length + 1
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

    experiences.push(experience);

    console.log(
      [
        "[Experience]",
        `${experiences.length}.`,
        experience.job_title ??
          "Không có title",
        "|",
        experience.company_name ??
          "Không có company"
      ].join(" ")
    );
  }

  return experiences;
}

async function scanAndUpdateCandidateExperience(
  page: Page,
  candidate: Candidate
): Promise<void> {
  console.log("");
  console.log(
    `[Profile] Đang vào: ${
      candidate.full_name ??
      candidate.profile_url
    }`
  );

  await updateExperienceStatus(
    candidate.profile_url,
    {
      experience_scan_status:
        "scanning",
      experience_scan_error: null
    }
  );

  try {
    await openExperiencePage(
      page,
      candidate.profile_url
    );

    const experiences =
      await extractExperiences(page);

    await updateExperienceStatus(
      candidate.profile_url,
      {
        experiences,
        experience_count:
          experiences.length,
        experience_scan_status:
          "completed",
        experience_scanned_at:
          new Date().toISOString(),
        experience_scan_error: null
      }
    );

    console.log(
      `[Profile] Đã lưu ${experiences.length} experience.`
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await updateExperienceStatus(
      candidate.profile_url,
      {
        experiences: [],
        experience_count: 0,
        experience_scan_status:
          "failed",
        experience_scanned_at:
          new Date().toISOString(),
        experience_scan_error:
          message
      }
    );

    console.error(
      `[Profile] Scan lỗi: ${message}`
    );
  }
}

function buildSearchPageUrl(
  filteredSearchUrl: string,
  pageNumber: number
): string {
  const url =
    new URL(filteredSearchUrl);

  url.searchParams.set(
    "page",
    String(pageNumber)
  );

  return url.toString();
}

async function openSearchPageNumber(
  page: Page,
  filteredSearchUrl: string,
  pageNumber: number
): Promise<void> {
  const targetUrl =
    buildSearchPageUrl(
      filteredSearchUrl,
      pageNumber
    );

  console.log(
    `[Navigation] Đang mở search page ${pageNumber}...`
  );

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForURL(
    (currentUrl) =>
      currentUrl.pathname.includes(
        "/search/results/people"
      ) &&
      currentUrl.searchParams.get(
        "page"
      ) === String(pageNumber),
    {
      timeout: 30_000
    }
  );

  await page.waitForTimeout(3_000);
}

async function main(): Promise<void> {
  const keyword =
    getArgument("keyword");

  const location =
    getArgument("location");

  const pagesToScan = Number(
    getArgument("pages") || "3"
  );

  const profileLimit = Number(
    getArgument("profile-limit") || "0"
  );

  if (!keyword) {
    throw new Error(
      'Thiếu keyword. Ví dụ: --keyword="AI Automation"'
    );
  }

  if (
    !Number.isInteger(pagesToScan) ||
    pagesToScan < 1 ||
    pagesToScan > 3
  ) {
    throw new Error(
      "--pages phải là số từ 1 đến 3."
    );
  }

  if (
    !Number.isInteger(profileLimit) ||
    profileLimit < 0
  ) {
    throw new Error(
      "--profile-limit phải là số nguyên từ 0 trở lên."
    );
  }

  let context: BrowserContext | null =
    null;

  try {
    context =
      await chromium.launchPersistentContext(
        profilePath,
        {
          channel: "chrome",
          headless: false,
          viewport: null,
          args: [
            "--start-maximized",
            "--no-first-run",
            "--no-default-browser-check"
          ]
        }
      );

    const page =
      await getSinglePage(context);

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

    const allCandidates:
      Candidate[] = [];

    let processedProfiles = 0;

    for (
      let pageNumber = 1;
      pageNumber <= pagesToScan;
      pageNumber += 1
    ) {
      await openSearchPageNumber(
        page,
        filteredSearchUrl,
        pageNumber
      );

      console.log("");
      console.log(
        `Đang scan danh sách trang ${pageNumber}...`
      );

      const candidates =
        await scanCurrentPage(
          page,
          pageNumber
        );

      allCandidates.push(
        ...candidates
      );

      await saveBasicCandidates(
        candidates
      );

      for (const candidate of candidates) {
        if (
          profileLimit > 0 &&
          processedProfiles >= profileLimit
        ) {
          console.log(
            `[Limit] Đã đạt profile-limit=${profileLimit}.`
          );

          break;
        }

        await scanAndUpdateCandidateExperience(
          page,
          candidate
        );

        processedProfiles += 1;

        await page.waitForTimeout(
          2_000
        );
      }

      if (
        profileLimit > 0 &&
        processedProfiles >= profileLimit
      ) {
        break;
      }
    }

    const uniqueCandidates =
      Array.from(
        new Map(
          allCandidates.map(
            (candidate) => [
              candidate.profile_url,
              candidate
            ]
          )
        ).values()
      );

    console.log("");
    console.log(
      `Tổng candidate card đọc được: ${allCandidates.length}`
    );

    console.log(
      `Tổng profile không trùng: ${uniqueCandidates.length}`
    );

    console.log(
      `Tổng profile đã scan experience: ${processedProfiles}`
    );

    console.log(
      "Hoàn thành toàn bộ flow."
    );
  } finally {
    await context
      ?.close()
      .catch(() => undefined);
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "\nLinkedIn sourcing flow thất bại:"
    );

    if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(error);
    }

    process.exit(1);
  }
);
