import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright";
import path from "node:path";
import { supabase } from "./database/supabase.js";

const profilePath = path.resolve("data", "chrome-profile");

type Candidate = {
  full_name: string | null;
  profile_url: string;
  headline: string | null;
  location: string | null;
  current_company_hint: string | null;
  action_type: string | null;
  scanned_at: string;
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
  const url = new URL(value, "https://www.linkedin.com");

  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function extractCompanyHint(
  headline: string | null
): string | null {
  if (!headline) return null;

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
    console.log("[Location] Không sử dụng location filter.");
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

  // Chọn suggestion đầu tiên bằng bàn phím.
  // Không click theo text toàn trang để tránh mở nhầm profile.
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

  if (!page.url().includes("/search/results/people")) {
    throw new Error(
      `Location filter chuyển sai trang: ${page.url()}`
    );
  }

  console.log(`[Location] URL sau filter: ${page.url()}`);
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
  profileLink: Locator,
  card: Locator
): Promise<string | null> {
  const nameFromLink = normalizeText(
    await profileLink
      .locator("span[aria-hidden='true']")
      .first()
      .textContent()
      .catch(() => null)
  );

  if (nameFromLink) {
    return nameFromLink
      .replace(/\s*[·•]\s*(1st|2nd|3rd\+?).*$/i, "")
      .trim();
  }

  const linkText = normalizeText(
    await profileLink.textContent().catch(() => null)
  );

  if (linkText) {
    return linkText
      .replace(/\s*[·•]\s*(1st|2nd|3rd\+?).*$/i, "")
      .trim();
  }

  return normalizeText(
    await card
      .locator("span[aria-hidden='true']")
      .first()
      .textContent()
      .catch(() => null)
  );
}

async function extractCandidateFromCard(
  card: Locator
): Promise<Candidate | null> {
  const profileLink = card
    .locator('a[href*="/in/"]')
    .first();

  if ((await profileLink.count()) === 0) {
    return null;
  }

  const href = await profileLink.getAttribute("href");

  if (!href) {
    return null;
  }

  const profileUrl = normalizeProfileUrl(href);
  const fullName = await getFullName(profileLink, card);

  const rawLines = await card
    .locator("span[aria-hidden='true'], p")
    .allTextContents();

  const uniqueLines = [
    ...new Set(
      rawLines
        .map((line) => normalizeText(line))
        .filter((line): line is string => Boolean(line))
    )
  ];

  const cleanLines = uniqueLines.filter((line) => {
    if (fullName && line === fullName) return false;

    if (
      fullName &&
      line.startsWith(`${fullName} ·`)
    ) {
      return false;
    }

    if (/^(1st|2nd|3rd\+?)$/i.test(line)) return false;
    if (/^(Connect|Message|Follow|View)$/i.test(line)) return false;
    if (/^(Past|Current|Education):/i.test(line)) return false;
    if (/mutual connection/i.test(line)) return false;

    return true;
  });

  const location =
    cleanLines.find((line) =>
      /Hanoi|Vietnam|Region|Ho Chi Minh|Da Nang/i.test(
        line
      )
    ) ?? null;

  const headline =
    cleanLines.find(
      (line) =>
        line !== location &&
        !/^Skills:/i.test(line) &&
        !/^Summary:/i.test(line)
    ) ?? null;

  return {
    full_name: fullName,
    profile_url: profileUrl,
    headline: normalizeText(headline),
    location: normalizeText(location),
    current_company_hint: extractCompanyHint(
      normalizeText(headline)
    ),
    action_type: await getCardAction(card),
    scanned_at: new Date().toISOString()
  };
}

async function scanCurrentPage(
  page: Page,
  pageNumber: number
): Promise<Candidate[]> {
  await page.waitForTimeout(3_000);

  const cards = page.locator(
    'main li:has(a[href*="/in/"])'
  );

  const cardCount = await cards.count();

  console.log(
    `[Page ${pageNumber}] Tìm thấy ${cardCount} card có profile URL.`
  );

  const candidates: Candidate[] = [];
  const seenOnPage = new Set<string>();

  for (
    let index = 0;
    index < cardCount;
    index += 1
  ) {
    const candidate = await extractCandidateFromCard(
      cards.nth(index)
    );

    if (!candidate) continue;

    if (seenOnPage.has(candidate.profile_url)) {
      continue;
    }

    seenOnPage.add(candidate.profile_url);
    candidates.push(candidate);

    console.log(
      `[Page ${pageNumber}] ${candidates.length}. ` +
      `${candidate.full_name ?? "Không có tên"}`
    );
  }

  return candidates;
}

async function goToSearchPage(
  page: Page,
  pageNumber: number
): Promise<void> {
  const url = new URL(page.url());

  url.searchParams.set("page", String(pageNumber));

  console.log(`[Navigation] Đang mở trang ${pageNumber}...`);

  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForURL(
    (currentUrl) =>
      currentUrl.pathname.includes(
        "/search/results/people"
      ) &&
      currentUrl.searchParams.get("page") ===
        String(pageNumber),
    {
      timeout: 30_000
    }
  );

  await page.waitForTimeout(3_000);
}

async function saveCandidates(
  candidates: Candidate[]
): Promise<void> {
  if (candidates.length === 0) {
    console.log("[Supabase] Không có ứng viên để lưu.");
    return;
  }

  const { error } = await supabase
    .from("linkedin_candidates")
    .upsert(candidates, {
      onConflict: "profile_url"
    });

  if (error) {
    throw new Error(
      `Supabase upsert thất bại: ${error.message}`
    );
  }

  console.log(
    `[Supabase] Đã upsert ${candidates.length} ứng viên.`
  );
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");
  const location = getArgument("location");
  const pagesToScan = Number(
    getArgument("pages") || "3"
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
    throw new Error("--pages phải là số từ 1 đến 3.");
  }

  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(
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

    const page = await getSinglePage(context);

    await openSearchPage(page, keyword);
    await applyLocationFilter(page, location);

    const filteredSearchUrl = page.url();
    const allCandidates: Candidate[] = [];

    for (
      let pageNumber = 1;
      pageNumber <= pagesToScan;
      pageNumber += 1
    ) {
      if (pageNumber === 1) {
        const firstPageUrl = new URL(filteredSearchUrl);
        firstPageUrl.searchParams.set("page", "1");

        await page.goto(firstPageUrl.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });

        await page.waitForTimeout(3_000);
      } else {
        await goToSearchPage(page, pageNumber);
      }

      console.log(`\nĐang scan trang ${pageNumber}...`);

      const candidates = await scanCurrentPage(
        page,
        pageNumber
      );

      allCandidates.push(...candidates);
    }

    const uniqueCandidates = Array.from(
      new Map(
        allCandidates.map((candidate) => [
          candidate.profile_url,
          candidate
        ])
      ).values()
    );

    console.log("");
    console.log(
      `Tổng card hợp lệ đọc được: ${allCandidates.length}`
    );
    console.log(
      `Tổng profile không trùng: ${uniqueCandidates.length}`
    );

    await saveCandidates(uniqueCandidates);

    console.log("Hoàn thành scan và lưu Supabase.");
  } finally {
    await context?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("\nScan LinkedIn thất bại:");

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exit(1);
});
