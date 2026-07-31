import { chromium } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

function getArgument(name: string): string {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));

  return argument?.slice(prefix.length).trim() ?? "";
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");

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

  // Luôn tạo tab mới để không tiếp tục từ profile cũ
  const page = await context.newPage();

  console.log("Đang mở danh sách ứng viên...");
  console.log(`Keyword: ${keyword}`);

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  // Chờ URL xác nhận đang ở trang danh sách People Search
  await page.waitForURL(
    /linkedin\.com\/search\/results\/people/,
    {
      timeout: 30_000
    }
  );

  console.log("Đã mở danh sách ứng viên.");
  console.log(`URL: ${page.url()}`);
  console.log("Chưa áp dụng location filter.");
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
  });
}

main().catch((error: unknown) => {
  console.error("LinkedIn search error:", error);
  process.exit(1);
});
