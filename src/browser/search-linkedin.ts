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

  console.log("[1] Tìm nút Locations...");

  const locationsButton = page
    .getByRole("button", { name: /locations/i })
    .first();

  console.log(
    `[1] Số nút Locations tìm thấy: ${await locationsButton.count()}`
  );

  await locationsButton.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await locationsButton.click();

  console.log("[2] Đã mở Locations.");

  const input = page.getByPlaceholder(/add a location/i).first();

  console.log(
    `[2] Số ô Add a location tìm thấy: ${await input.count()}`
  );

  await input.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await input.fill(location);

  console.log(`[3] Đã nhập: ${location}`);

  await page.waitForTimeout(2_000);

  const possibleOptions = page.locator(
    '[role="option"], [role="listbox"] li, li'
  );

  const optionTexts = await possibleOptions.allTextContents();

  console.log("[4] Các option/li đang thấy:");
  console.log(
    optionTexts
      .map((text) => text.trim())
      .filter(Boolean)
      .slice(0, 30)
  );

  const suggestion = page
    .getByText(location, { exact: true })
    .filter({ visible: true })
    .last();

  console.log(
    `[5] Số suggestion chính xác tìm thấy: ${await suggestion.count()}`
  );

  await suggestion.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await suggestion.click();

  console.log("[6] Đã chọn location.");

  const showResultsButton = page
    .getByRole("button", { name: /show results/i })
    .filter({ visible: true })
    .last();

  console.log(
    `[7] Số nút Show results: ${await showResultsButton.count()}`
  );

  await showResultsButton.click();

  console.log("[8] Đã click Show results.");

  await page.waitForTimeout(3_000);
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
