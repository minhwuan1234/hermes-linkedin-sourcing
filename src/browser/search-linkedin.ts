import { chromium, type Locator, type Page } from "playwright";
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
  const argument = process.argv.find((item) => item.startsWith(prefix));
  return argument?.slice(prefix.length).trim() ?? "";
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeProfileUrl(value: string): string {
  const url = new URL(value, "https://www.linkedin.com");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function extractCompanyHint(headline: string | null): string | null {
  if (!headline) return null;

  const patterns = [
    /\s+at\s+([^|•]+)/i,
    /\s+@\s*([^|•]+)/i
  ];

  for (const pattern of patterns) {
    const match = headline.match(pattern);
    const company = normalizeText(match?.[1]);

    if (company) return company;
  }

  return null;
}

async function getSinglePage(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>): Promise<Page> {
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();

  for (const extraPage of pages.slice(1)) {
    await extraPage.close().catch(() => undefined);
  }

  return page;
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) return;

  const locationsButton = page
    .getByRole("button", { name: /locations/i })
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
  await page.waitForTimeout(2_000);

  await locationInput.press("ArrowDown");
  await locationInput.press("Enter");

  await page.waitForTimeout(1_000);

  const showResultsText = page
    .getByText(/^Show results$/i, { exact: true })
    .last();

  await showResultsText.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await showResultsText.click({
    force: true,
    timeout: 20_000
  });

  await page.waitForTimeout(3_000);

  if (!page.url().includes("/search/results/people")) {
    throw new Error(`Location filter chuyển sai trang: ${page.url()}`);
  }
}

async function getActionType(card: Locator): Promise<string | null> {
  const texts = await card.locator("button, a").allTextContents();
  const actions = ["Connect", "Message", "Follow", "View"];

  for (const action of actions) {
    const found = texts.some(
      (text) => normalizeText(text) === action
    );

    if (found) return action;
  }

  return null;
}

async function extractCandidate(
  card: Locator
): Promise<Candidate | null> {
  const profileLink = card
    .locator('a[href*="/in/"]')
    .first();

  if ((await profileLink.count()) === 0) return null;

  const href = await profileLink.getAttribute("href");
  if (!href) return null;

  const profileUrl = normalizeProfileUrl(href);

  const fullName = normalizeText(
    await profileLink.locator("span[aria-hidden='true']").first().textContent()
      .catch(() => profileLink.textContent())
  );

  const lines = (
    await card.locator("span[aria-hidden='true'], p, div").allTextContents()
  )
    .map((text) => normalizeText(text))
    .filter((text): text is string => Boolean(text));

  const uniqueLines = [...new Set(lines)];

  const filteredLines = uniqueLines.filter((line) => {
    if (fullName && line.includes(fullName)) return false;
    if (/^(1st|2nd|3rd\+?)$/i.test(line)) return false;
    if (/^(Connect|Message|Follow|View)$/i.test(line)) return false;
    if (/^(Past|Current|Education):/i.test(line)) return false;
    return true;
  });

  const headline = filteredLines[0] ?? null;

  const location =
    filteredLines.find((line) =>
      /Hanoi|Vietnam|Region|Ho Chi Minh|Da Nang/i.test(line)
    ) ?? null;

  return {
    full_name: fullName,
    profile_url: profileUrl,
    headline,
    location,
    current_company_hint: extractCompanyHint(headline),
    action_type: await getActionType(card),
    scanned_at: new Date().toISOString()
  };
}

async function scanCurrentPage(page: Page): Promise<Candidate[]> {
  await page.waitForTimeout(2_000);

  const cards = page.locator(
    'main li:has(a[href*="/in/"])'
  );

  const count = await cards.count();
  const candidates: Candidate[] = [];

  console.log(`Tìm thấy ${count} card trên trang.`);

  for (let index = 0; index < count; index += 1) {
    const candidate = await extractCandidate(cards.nth(index));

    if (!candidate) continue;

    candidates.push(candidate);

    console.log(
      `${index + 1}. ${candidate.full_name ?? "Không có tên"}`
    );
  }

  return candidates;
}

async function goToPage(
  page: Page,
  pageNumber: number
): Promise<void> {
  const url = new URL(page.url());
  url.searchParams.set("page", String(pageNumber));

  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForTimeout(3_000);
}

async function saveCandidates(
  candidates: Candidate[]
): Promise<void> {
  if (candidates.length === 0) {
    console.log("Không có ứng viên để lưu.");
    return;
  }

  const { error } = await supabase
    .from("linkedin_candidates")
    .upsert(candidates, {
      onConflict: "profile_url"
    });

  if (error) throw error;

  console.log(`Đã lưu ${candidates.length} ứng viên vào Supabase.`);
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");
  const location = getArgument("location");
  const pagesToScan = Number(getArgument("pages") || "3");

  if (!keyword) {
    throw new Error('Thiếu --keyword="..."');
  }

  if (
    !Number.isInteger(pagesToScan) ||
    pagesToScan < 1 ||
    pagesToScan > 3
  ) {
    throw new Error("--pages phải từ 1 đến 3.");
  }

  const context = await chromium.launchPersistentContext(
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

  const searchUrl = new URL(
    "https://www.linkedin.com/search/results/people/"
  );

  searchUrl.searchParams.set("keywords", keyword);
  searchUrl.searchParams.set("origin", "GLOBAL_SEARCH_HEADER");

  console.log("Đang mở danh sách ứng viên...");

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await applyLocationFilter(page, location);

  const allCandidates: Candidate[] = [];

  for (
    let pageNumber = 1;
    pageNumber <= pagesToScan;
    pageNumber += 1
  ) {
    console.log(`\nĐang scan trang ${pageNumber}...`);

    if (pageNumber > 1) {
      await goToPage(page, pageNumber);
    }

    const candidates = await scanCurrentPage(page);
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

  console.log(`\nTổng card: ${allCandidates.length}`);
  console.log(`Profile không trùng: ${uniqueCandidates.length}`);

  await saveCandidates(uniqueCandidates);

  console.log("Hoàn thành.");
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", () => resolve());
  });
}

main().catch((error: unknown) => {
  console.error("Scan LinkedIn thất bại:");

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exit(1);
});
