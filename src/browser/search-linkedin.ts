import { chromium, type Page } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

function getArgument(name: string): string {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));

  return argument?.slice(prefix.length).trim() ?? "";
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) return;

  const locationsButton = page.getByRole("button", {
    name: /^Locations$/i
  });

  await locationsButton.click();

  const popup = page.locator(
    '.artdeco-hoverable-content, [role="dialog"]'
  ).last();

  await popup.waitFor({
    state: "visible",
    timeout: 15_000
  });

  const input = popup.getByPlaceholder(/add a location/i);

  await input.fill(location);

  const suggestion = popup
    .locator('[role="option"], li')
    .filter({ hasText: location })
    .first();

  await suggestion.waitFor({
    state: "visible",
    timeout: 15_000
  });

  await suggestion.click();

  const showResultsButton = popup.getByRole("button", {
    name: /show results/i
  });

  await showResultsButton.click();

  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    { timeout: 30_000 }
  );
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");
  const location = getArgument("location");

  if (!keyword) {
    throw new Error(
      'Thiếu keyword. Ví dụ: --keyword="AI Automation"'
    );
  }

  const searchUrl = new URL(
    "https://www.linkedin.com/search/results/people/"
  );

  searchUrl.searchParams.set("keywords", keyword);
  searchUrl.searchParams.set("origin", "GLOBAL_SEARCH_HEADER");

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const page = await context.newPage();

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    { timeout: 30_000 }
  );

  await applyLocationFilter(page, location);

  console.log("Đã mở danh sách ứng viên.");
  console.log(`Keyword: ${keyword}`);
  console.log(`Location: ${location || "Không sử dụng"}`);
  console.log(`URL: ${page.url()}`);

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
  });
}

main().catch((error: unknown) => {
  console.error("LinkedIn search error:", error);
  process.exit(1);
});
