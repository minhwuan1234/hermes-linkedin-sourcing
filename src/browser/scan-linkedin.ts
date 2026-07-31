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
  const url = new URL(value);
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function extractCompanyHint(headline: string | null): string | null {
  if (!headline) return null;

  const patterns = [
    /\s+at\s+([^|•]+)$/i,
    /\s+@\s*([^|•]+)$/i,
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

async function getCardAction(card: Locator): Promise<string | null> {
  const supportedActions = [
    "Connect",
    "Message",
    "Follow",
    "View"
  ];

  const buttons = card.locator("button, a");
  const texts = await buttons.allTextContents();

  for (const action of supportedActions) {
    const found = texts.some(
      (text) => text.replace(/\s+/g, " ").trim() === action
    );

    if (found) return action;
  }

  return null;
}

async function extractCandidateFromCard(
  card: Locator
): Promise<Candidate | null> {
  const profileLink = card
    .locator('a[href*="linkedin.com/in/"], a[href^="/in/"]')
    .first();

  if ((await profileLink.count()) === 0) {
    return null;
  }

  const href = await profileLink.getAttribute("href");

  if (!href) return null;

  const profileUrl = normalizeProfileUrl(
    new URL(href, "https://www.linkedin.com").toString()
  );

  const fullName =
    normalizeText(await profileLink.textContent()) ??
    normalizeText(
      await card.locator("span[aria-hidden='true']").first().textContent()
    );

  const cardLines = (
    await card.locator("div, span, p").allTextContents()
  )
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const uniqueLines = [...new Set(cardLines)];

  const fullNameIndex = fullName
    ? uniqueLines.findIndex((line) => line.includes(fullName))
    : -1;

  const possibleHeadline =
    fullNameIndex >= 0
      ? uniqueLines
          .slice(fullNameIndex + 1)
          .find(
            (line) =>
              line !== fullName &&
              !/^(1st|2nd|3rd\+?)$/i.test(line) &&
              !/^(connect|message|follow|view)$/i.test(line) &&
              !/^past:/i.test(line) &&
              !/^current:/i.test(line) &&
              !/^education:/i.test(line)
          )
      : null;

  const possibleLocation = uniqueLines.find(
    (line) =>
      /Vietnam|Region|Hanoi|Ho Chi Minh|Da Nang/i.test(line) &&
      line !== possibleHeadline
  );

  const headline = normalizeText(possibleHeadline);
  const location = normalizeText(possibleLocation);
  const actionType = await getCardAction(card);

  return {
    full_name: fullName,
    profile_url: profileUrl,
    headline,
    location,
    current_company_hint: extractCompanyHint(headline),
    action_type: actionType,
    scanned_at: new Date().toISOString()
  };
}

async function scanCurrentPage(page: Page): Promise<Candidate[]> {
  await page.waitForTimeout(2_000);

  const cards = page.locator(
    'main li:has(a[href*="/in/"]), ' +
      'main div[data-view-name*="search"]:has(a[href*="/in/"])'
  );

  const cardCount = await cards.count();

  console.log(`Tìm thấy ${cardCount} card có profile URL.`);

  const candidates: Candidate[] = [];

  for (let index = 0; index < cardCount; index += 1) {
    const candidate = await extractCandidateFromCard(cards.nth(index));

    if (!candidate) continue;

    candidates.push(candidate);

    console.log(
      `  ${index + 1}. ${candidate.full_name ?? "Không có tên"}`
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

  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForURL(
    new RegExp(
      `linkedin\\.com/search/results/people/.*page=${pageNumber}`
    ),
    {
      timeout: 30_000
    }
  );

  await page.waitForTimeout(2_000);
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

  if (error) {
    throw error;
  }

  console.log(
    `Đã upsert ${candidates.length} ứng viên vào Supabase.`
  );
}

async function main(): Promise<void> {
  const pagesToScan = Number(getArgument("pages") || "3");

  if (
    !Number.isInteger(pagesToScan) ||
    pagesToScan < 1 ||
    pagesToScan > 3
  ) {
    throw new Error("--pages phải là số từ 1 đến 3.");
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

  const page = context.pages()[0] ?? await context.newPage();

  if (!page.url().includes("/search/results/people")) {
    throw new Error(
      "Hãy mở trang danh sách LinkedIn Search trước khi chạy scan."
    );
  }

  const allCandidates: Candidate[] = [];

  for (
    let pageNumber = 1;
    pageNumber <= pagesToScan;
    pageNumber += 1
  ) {
    console.log(`\nĐang scan trang ${pageNumber}...`);

    await goToSearchPage(page, pageNumber);

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

  console.log("");
  console.log(`Tổng card đọc được: ${allCandidates.length}`);
  console.log(
    `Tổng profile không trùng: ${uniqueCandidates.length}`
  );

  await saveCandidates(uniqueCandidates);

  console.log("Hoàn thành scan 3 trang.");
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
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
