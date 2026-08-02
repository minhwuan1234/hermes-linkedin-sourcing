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
  const url = new URL(
    value,
    "https://www.linkedin.com"
  );

  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
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

  /*
   * Chọn suggestion bằng bàn phím.
   * Không tìm text location trên toàn trang để tránh
   * click nhầm profile ứng viên.
   */
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

  const uniqueLines = [
    ...new Set(
      rawLines
        .map((line) =>
          normalizeText(line)
        )
        .filter(
          (line): line is string =>
            Boolean(line)
        )
    )
  ];

  const cleanLines = uniqueLines.filter(
    (line) => {
      if (!line) {
        return false;
      }

      if (
        fullName &&
        line === fullName
      ) {
        return false;
      }

      if (
        fullName &&
        line.startsWith(
          `${fullName} ·`
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
    cleanLines.find((line) =>
      /Hanoi|Vietnam|Region|Ho Chi Minh|Da Nang/i.test(
        line
      )
    ) ?? null;

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

      if (
        /connections?$/i.test(line)
      ) {
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
      new Date().toISOString()
  };
}

async function scrollSearchResults(
  page: Page
): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await page.evaluate(() => {
      window.scrollBy(
        0,
        Math.floor(window.innerHeight * 0.75)
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

    const visible = await link
      .isVisible()
      .catch(() => false);

    if (!visible) {
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

async function goToSearchPage(
  page: Page,
  pageNumber: number
): Promise<void> {
  const url = new URL(page.url());

  url.searchParams.set(
    "page",
    String(pageNumber)
  );

  console.log(
    `[Navigation] Đang mở trang ${pageNumber}...`
  );

  await page.goto(url.toString(), {
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

async function saveCandidates(
  candidates: Candidate[]
): Promise<void> {
  if (candidates.length === 0) {
    console.log(
      "[Supabase] Không có ứng viên để lưu."
    );

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
  const keyword =
    getArgument("keyword");

  const location =
    getArgument("location");

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
    throw new Error(
      "--pages phải là số từ 1 đến 3."
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

    for (
      let pageNumber = 1;
      pageNumber <= pagesToScan;
      pageNumber += 1
    ) {
      if (pageNumber === 1) {
        const firstPageUrl =
          new URL(
            filteredSearchUrl
          );

        firstPageUrl.searchParams.set(
          "page",
          "1"
        );

        await page.goto(
          firstPageUrl.toString(),
          {
            waitUntil:
              "domcontentloaded",
            timeout: 60_000
          }
        );

        await page.waitForTimeout(
          3_000
        );
      } else {
        await goToSearchPage(
          page,
          pageNumber
        );
      }

      console.log(
        `\nĐang scan trang ${pageNumber}...`
      );

      const candidates =
        await scanCurrentPage(
          page,
          pageNumber
        );

      allCandidates.push(
        ...candidates
      );
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
      `Tổng card hợp lệ đọc được: ${allCandidates.length}`
    );

    console.log(
      `Tổng profile không trùng: ${uniqueCandidates.length}`
    );

    await saveCandidates(
      uniqueCandidates
    );

    console.log(
      "Hoàn thành scan và lưu Supabase."
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
      "\nScan LinkedIn thất bại:"
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
