import { test, expect } from "./fixtures/product.js";

test("anonymous visitors select a locale and complete the observable OAuth reload", async ({
  page,
  product,
}, testInfo) => {
  const localized = localizedLabels(testInfo.project.name);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", localized.locale);
  await expect(page.getByRole("main", { name: "ActivityPlug" })).toBeVisible();
  await expect(page.getByRole("region", { name: localized.signIn })).toBeVisible();
  await expect(page.getByLabel(localized.language)).toBeVisible();
  await expect(page.getByLabel(localized.origin)).toBeVisible();
  await expect(page.getByRole("button", { name: localized.continue })).toBeVisible();
  await page.getByLabel(localized.language).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Server origin").fill("https://social.example");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/?$/u);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  product.assertBrowserBoundary();
});

test("authenticated users traverse timelines and preserve opaque pagination cursors", async ({
  page,
  product,
}) => {
  await authenticate(page);
  await expect(page.getByText("Fixture post home-primary")).toBeVisible();
  await page.getByRole("button", { name: "Load more posts" }).click();
  await expect(page.getByText("Fixture post home-next")).toBeVisible();
  await page.getByRole("link", { name: "Local" }).first().click();
  await expect(page.getByText("Fixture post local-primary")).toBeVisible();
  await page.getByRole("button", { name: "Load more posts" }).click();
  await expect(page.getByText("Fixture post local-next")).toBeVisible();
  await page.getByRole("link", { name: "Federated" }).first().click();
  await expect(page.getByText("Fixture post federated-primary")).toBeVisible();
  await page.getByRole("button", { name: "Load more posts" }).click();
  await expect(page.getByText("Fixture post federated-next")).toBeVisible();
  product.assertBrowserBoundary();
});

test("search, profile, post, and thread routes use browser DTOs", async ({ page, product }) => {
  await authenticate(page);
  await page.getByRole("link", { name: "Search" }).click();
  await page.getByRole("searchbox").fill("fixture");
  await expect(page.getByRole("link", { exact: true, name: "Alice Fixture" })).toBeVisible();
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(page.getByText("Fixture post search-next")).toBeVisible();
  await page.getByRole("link", { exact: true, name: "Alice Fixture" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "Alice Fixture" })).toBeVisible();
  await page.getByRole("button", { name: "Load more posts" }).click();
  await expect(page.getByText("Fixture post profile-next")).toBeVisible();
  await page.getByRole("button", { name: "Follow" }).click();
  await expect(page.getByRole("button", { name: "Unfollow" })).toBeVisible();
  await page.getByRole("link", { name: "ActivityPlug" }).click();
  await expect(page.getByText("Fixture post home-primary")).toBeVisible();
  await page.getByLabel("Post content").fill("A draft survives internal navigation");
  const permalink = page.getByRole("link", { name: "View post" }).first();
  await expect(permalink).toHaveAttribute("href", `/post?id=${encodeURIComponent(opaquePostId)}`);
  await permalink.click();
  await expect(page).toHaveURL(`/post?id=${encodeURIComponent(opaquePostId)}`);
  await expect(page.getByLabel("Post content")).toHaveValue("A draft survives internal navigation");
  await page.getByRole("button", { name: "Show conversation" }).click();
  await expect(page.getByText("Fixture post thread-ancestor")).toBeVisible();
  await expect(page.getByText("Fixture post thread-descendant")).toBeVisible();
  product.assertBrowserBoundary();
});

test("post actions target the composer and send only valid CSRF unsafe requests", async ({
  page,
  product,
}) => {
  await authenticate(page);
  await page.getByRole("button", { name: "Reply" }).first().click();
  await expect(page.getByLabel("Reply to post")).toHaveValue(opaquePostId);
  await page.getByRole("button", { name: "Quote" }).first().click();
  await expect(page.getByLabel("Quote post")).toHaveValue(opaquePostId);
  await page.getByRole("button", { name: "Favourite" }).first().click();
  await expect(page.getByRole("button", { name: "Remove favourite" }).first()).toBeVisible();
  product.assertBrowserBoundary();
});

test("an uncertain 503 outcome retains the image draft before a deliberate retry", async ({
  page,
  product,
}) => {
  await authenticate(page);
  await page.getByLabel("Post content").fill("Retry me with an image");
  await page.locator('.composer input[type="file"]').setInputFiles({
    buffer: Buffer.from(tinyPngBase64, "base64"),
    mimeType: "image/png",
    name: "alt-image.png",
  });
  const preview = page.getByRole("img", { name: "alt-image.png" });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
      ),
    )
    .toBe(true);
  await page.getByLabel("Alt text for alt-image.png").fill("Fixture mountain at dawn");
  await page.getByRole("button", { name: "Upload alt-image.png" }).click();
  await expect(page.getByText("Uploaded alt-image.png")).toBeVisible();
  await product.assertUploadDescription("Fixture mountain at dawn");
  await page.getByRole("button", { exact: true, name: "Post" }).click();
  await expect(page.getByRole("alert")).toContainText("may have been accepted");
  await expect(page.getByLabel("Post content")).toHaveValue("Retry me with an image");
  await expect(page.getByText("Uploaded alt-image.png")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Post" }).click();
  await expect(page.getByLabel("Post content")).toHaveValue("");
  await expect(page.getByText("Created after retry")).toBeVisible();
  product.assertBrowserBoundary();
});

test("keyboard focus, landmarks, responsive shell, unknown routes, and logout remain usable", async ({
  page,
  product,
}, testInfo) => {
  await authenticate(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Account and composer" })).toBeVisible();
  if (testInfo.project.name === "mobile-en") {
    await expect(
      page
        .locator(".product-shell__grid")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
    ).resolves.toBe(1);
    const [context, main] = await Promise.all([
      page.locator('[data-layout-slot="context"]').boundingBox(),
      page.locator('[data-layout-slot="main"]').boundingBox(),
    ]);
    if (context === null || main === null) throw new Error("Product shell layout is unavailable.");
    expect(context.y).toBeLessThan(main.y);
    const widths = await page.locator(".product-shell").evaluate((shell) => {
      const composer = shell.querySelector<HTMLElement>(".composer");
      if (composer === null) throw new Error("Composer layout is unavailable.");
      const fieldset = composer.querySelector<HTMLElement>("fieldset");
      if (fieldset === null) throw new Error("Composer fieldset is unavailable.");
      return {
        shellClientWidth: shell.clientWidth,
        shellScrollWidth: shell.scrollWidth,
        composerClientWidth: composer.clientWidth,
        composerScrollWidth: composer.scrollWidth,
        fieldsetClientWidth: fieldset.clientWidth,
        fieldsetScrollWidth: fieldset.scrollWidth,
      };
    });
    expect(widths.shellScrollWidth).toBeLessThanOrEqual(widths.shellClientWidth);
    expect(widths.composerScrollWidth).toBeLessThanOrEqual(widths.composerClientWidth);
    expect(widths.fieldsetScrollWidth).toBeLessThanOrEqual(widths.fieldsetClientWidth);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
  ).resolves.toBe(true);
  const unlisted = await page.evaluate(async () => {
    const response = await fetch("/v1/browser/api/not-listed");
    return { body: await response.json(), status: response.status };
  });
  expect(unlisted).toEqual({
    body: {
      error: {
        code: "NOT_FOUND",
        message: "The browser route does not exist.",
        requestId: "fixture-request",
      },
    },
    status: 404,
  });
  await page.goto("/not-a-product-route");
  await expect(page.getByRole("alert")).toHaveText("This page does not exist.");
  await page.getByRole("link", { name: "ActivityPlug" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("region", { name: "Sign in" })).toBeVisible();
  product.assertBrowserBoundary();
});

async function authenticate(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.locator(".locale-control select").selectOption("en");
  await page.getByLabel("Server origin").fill("https://social.example");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

const opaquePostId = "post/opaque+/=%25?&한글";
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8XQAAAABJRU5ErkJggg==";

function localizedLabels(projectName: string): {
  readonly continue: string;
  readonly language: string;
  readonly locale: string;
  readonly origin: string;
  readonly signIn: string;
} {
  switch (projectName) {
    case "desktop-ko":
      return {
        continue: "계속",
        language: "언어",
        locale: "ko",
        origin: "서버 원본",
        signIn: "로그인",
      };
    case "desktop-ja":
      return {
        continue: "続行",
        language: "言語",
        locale: "ja",
        origin: "サーバーオリジン",
        signIn: "ログイン",
      };
    default:
      return {
        continue: "Continue",
        language: "Language",
        locale: "en",
        origin: "Server origin",
        signIn: "Sign in",
      };
  }
}
