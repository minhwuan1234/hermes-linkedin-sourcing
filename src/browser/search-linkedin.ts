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

  console.log("[3] Đã chọn location suggestion");

  const showResultsButton = page
    .getByRole("button", { name: /^Show results$/i })
    .last();

  await showResultsButton.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await showResultsButton.click();

  console.log("[4] Đã bấm Show results");

  await page.waitForTimeout(3_000);

  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    {
      timeout: 30_000
    }
  );

  console.log(`[5] Trang kết quả: ${page.url()}`);
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
