import { chromium, type Page } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

function getArgument(name: string): string {
  const prefix = `--${name}=`;

  const argument = process.argv.find((item) =>
    item.startsWith(prefix)
  );

  return argument?.slice(prefix.length).trim() ?? "";
}

async function clickShowResults(page: Page): Promise<void> {
  const showResultsText = page
    .getByText(/^Show results$/i, { exact: true })
    .last();

  await showResultsText.waitFor({
    state: "visible",
    timeout: 20_000
  });

  console.log(
    `[4] Số phần tử Show results tìm thấy: ${await showResultsText.count()}`
  );

  await showResultsText.scrollIntoViewIfNeeded();

  await showResultsText.click({
    force: true,
    timeout: 20_000
  });

  console.log("[5] Đã bấm Show results");

  await page.waitForTimeout(3_000);
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) {
    console.log("[Location] Không có location filter.");
    return;
  }

  console.log("[1] Mở Locations filter");

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

  console.log("[2] Đã mở Locations filter");

  const locationInput = page
    .getByPlaceholder(/add a location/i)
    .first();

  await locationInput.waitFor({
    state: "visible",
    timeout: 20_000
  });

  await locationInput.fill(location);

  console.log(`[3] Đã nhập location: ${location}`);

  await page.waitForTimeout(2_000);

  // Chọn suggestion đầu tiên bằng keyboard.
  // Không click theo text để tránh mở nhầm profile ứng viên.
  await locationInput.press("ArrowDown");
  await page.waitForTimeout(300);
  await locationInput.press("Enter");

  console.log("[3.1] Đã chọn location suggestion");

  await page.waitForTimeout(1_000);

  await clickShowResults(page);

  await page.waitForTimeout(3_000);

  const currentUrl = page.url();

  if (!currentUrl.includes("/search/results/people")) {
    throw new Error(
      `Sau khi áp dụng location, trang bị chuyển sai URL: ${currentUrl}`
    );
  }

  console.log(`[6] URL sau filter: ${currentUrl}`);
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
  searchUrl.searchParams.set(
    "origin",
    "GLOBAL_SEARCH_HEADER"
  );

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

  // Luôn mở tab mới để không tiếp tục từ profile cũ.
  const page = await context.newPage();

  console.log("[Search] Đang mở danh sách ứng viên...");
  console.log(`[Search] Keyword: ${keyword}`);

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

  console.log("[Search] Đã mở danh sách ứng viên.");
  console.log(`[Search] URL: ${page.url()}`);

  await applyLocationFilter(page, location);

  console.log("");
  console.log("Hoàn thành.");
  console.log(`Keyword: ${keyword}`);
  console.log(
    `Location: ${location || "Không sử dụng"}`
  );
  console.log(`URL cuối: ${page.url()}`);
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
  });
}

main().catch((error: unknown) => {
  console.error("LinkedIn search error:");

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exit(1);
});
