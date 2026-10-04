import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { themes } from "../src/lib/themes";

const alice = "a".repeat(32);
const itemId = "1".repeat(32);
const seriesId = "2".repeat(32);
const media = {
  item_id: itemId,
  series_id: seriesId,
  item_name: "Mortynight Run",
  series_name: "Rick and Morty",
  item_type: "Episode",
  year: 2015,
  season: 2,
  episode: 2,
};
const users = [
  {
    user_id: alice,
    user_name: "Alessandro",
    seconds: 87480,
    peak_day_seconds: 13920,
    peak_day: "2026-10-03",
    consecutive_seconds: 12600,
    episodes: 26,
    movies: 6,
    active_days: 4,
  },
  {
    user_id: "bob",
    user_name: "Sarah",
    seconds: 66240,
    peak_day_seconds: 10260,
    peak_day: "2026-10-02",
    consecutive_seconds: 9000,
    episodes: 19,
    movies: 5,
    active_days: 4,
  },
  {
    user_id: "charlie",
    user_name: "James",
    seconds: 52560,
    peak_day_seconds: 8640,
    peak_day: "2026-10-02",
    consecutive_seconds: 7200,
    episodes: 14,
    movies: 4,
    active_days: 3,
  },
  {
    user_id: "dana",
    user_name: "Mia",
    seconds: 34560,
    peak_day_seconds: 7200,
    peak_day: "2026-10-01",
    consecutive_seconds: 5400,
    episodes: 11,
    movies: 2,
    active_days: 3,
  },
];
function analytics(url: string) {
  const params = new URL(url).searchParams;
  const start = params.get("start") || "2026-10-01";
  const end = params.get("end") || "2026-10-04";
  const dates: string[] = [];
  const date = new Date(start + "T12:00:00Z");
  while (date.toISOString().slice(0, 10) <= end) {
    dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return {
    range: { start, end, timezone: params.get("tz") || "UTC" },
    tracking: {
      since: "2026-10-01T00:00:00Z",
      last_sample: "2026-10-04T18:00:00Z",
      sample_seconds: 5,
      completion_coverage: 0.9,
      consecutive_gap_seconds: 15,
    },
    users,
    leaders: {
      seconds: [alice],
      peak_day_seconds: [alice],
      consecutive_seconds: [alice],
      episodes: [alice],
      movies: [alice],
    },
    totals: { seconds: 240840, episodes: 70, movies: 17, viewers: 4 },
    daily: dates.map((date, i) => ({
      date,
      seconds: [48600, 72000, 81000, 39240][i % 4],
      episodes: 12,
      movies: 3,
      users: { [alice]: [18000, 26000, 29000, 14480][i % 4], bob: 12000 },
    })),
    breakdown: { Episode: 150840, Movie: 90000 },
    top_titles: [
      {
        ...media,
        item_name: "Rick and Morty",
        item_type: "Series",
        seconds: 24000,
      },
      {
        item_id: "3".repeat(32),
        item_name: "Severance",
        item_type: "Series",
        seconds: 20000,
      },
      {
        item_id: "4".repeat(32),
        item_name: "The Bear",
        item_type: "Series",
        seconds: 12000,
      },
      {
        item_id: "5".repeat(32),
        item_name: "Interstellar",
        item_type: "Movie",
        seconds: 10000,
      },
    ],
    recent: [
      {
        ...media,
        id: "run1",
        user_id: alice,
        user_name: "Alessandro",
        at: "2026-10-04T17:15:00Z",
      },
      {
        ...media,
        id: "run2",
        user_id: "bob",
        user_name: "Sarah",
        series_name: "Severance",
        at: "2026-10-04T15:10:00Z",
      },
      {
        ...media,
        id: "run3",
        user_id: "charlie",
        user_name: "James",
        series_name: "",
        item_name: "Interstellar",
        item_type: "Movie",
        at: "2026-10-03T20:10:00Z",
      },
    ],
  };
}
async function fixture(page: Page, authenticated = true) {
  await page.clock.setFixedTime(new Date("2026-10-04T18:00:00Z"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = { ok: true };
    let status = 200;
    if (path === "/api/me") {
      body = authenticated
        ? { id: alice, name: "Alessandro", admin: true }
        : { detail: "Unauthorized" };
      status = authenticated ? 200 : 401;
    } else if (path === "/api/login")
      body = { id: alice, name: "Alessandro", admin: true };
    else if (path === "/api/users")
      body = users.map((user) => ({
        id: user.user_id,
        name: user.user_name,
        image_tag: null,
        can_edit_image: user.user_id === alice,
      }));
    else if (path === "/api/analytics") body = analytics(request.url());
    else if (path === "/api/now")
      body = [
        {
          ...media,
          user: "Alessandro",
          device: "Living room TV",
          client: "Jellyfin",
          paused: false,
          progress: 43,
          method: "DirectPlay",
          transcode_reasons: [],
        },
      ];
    else if (
      path === "/api/up-next" ||
      path === "/api/latest" ||
      path === "/api/search" ||
      path === "/api/to-rate"
    )
      body = [media];
    else if (path === "/api/watchlist" && request.method() === "GET")
      body = [
        {
          ...media,
          item_id: seriesId,
          item_name: "Rick and Morty",
          item_type: "Series",
          added_by_name: "Sarah",
          note: "For Sunday night",
          in: ["Sarah"],
          progress: {
            Alessandro: { watched: 2, total: 26, done: false },
            Sarah: { watched: 0, total: 26, done: false },
          },
          done: false,
          missing: false,
          can_remove: true,
        },
      ];
    else if (path === "/api/ratings" && request.method() === "GET")
      body = [
        {
          ...media,
          avg: 8,
          reviews: [
            {
              user_id: alice,
              user_name: "Alessandro",
              score: 8,
              note: "A great episode",
              updated_at: "2026-10-04T15:00:00Z",
            },
          ],
        },
      ];
    else if (path === "/api/taste")
      body = [
        { a: "Alessandro", b: "Sarah", match: 89, shared: 7, fights: [] },
      ];
    else if (path === "/api/activity")
      body = [
        {
          id: "run1",
          user_id: alice,
          user: "Alessandro",
          ...media,
          name: media.item_name,
          type: "Episode",
          at: "2026-10-04T15:00:00Z",
          seconds: 1200,
          completed: true,
          device: "TV",
          client: "Jellyfin",
        },
      ];
    else if (path === "/api/history") body = [];
    else if (path === "/api/system")
      body = {
        disks: [
          {
            label: "Media",
            total: 4e12,
            used: 2e12,
            free: 2e12,
            days_to_full: null,
          },
        ],
        cpu: 12,
        cores: 8,
        load: [0.3, 0.2, 0.1],
        memory: { total: 16e9, available: 10e9 },
        uptime: 864000,
        temps: { CPU: 40 },
        containers: [
          { name: "jellyfin", state: "running", status: "Up 10 days" },
        ],
        queue: [],
        library: { MovieCount: 210, SeriesCount: 45, EpisodeCount: 1900 },
      };
    else if (path.startsWith("/api/img")) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ status, json: body });
  });
}
async function navigate(page: Page, name: string) {
  if ((page.viewportSize()?.width || 1440) <= 960)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}

test("leaderboard metric, range, timezone and theme selections work", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /A little friendly/ }),
  ).toBeVisible();
  await expect(page.getByText("24.3h", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Movies completed/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Ranking metric" }),
  ).toContainText("Movies completed");
  await page.getByRole("button", { name: /1 Oct – 4 Oct 2026/ }).click();
  await page.getByRole("button", { name: "Last month", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /1 Sep – 30 Sep 2026/ }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Timezone" }).click();
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("monitor:timezone")))
    .toBe("UTC");
  await page.getByRole("combobox", { name: "Chart viewer" }).click();
  await page.getByRole("option", { name: "Alessandro", exact: true }).click();
  if ((page.viewportSize()?.width || 1440) <= 960)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Set the mood", exact: true })
    .first()
    .click();
  for (const theme of themes) {
    await page.getByRole("button", { name: theme.name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme.value,
    );
    await expect(
      page.getByRole("button", { name: theme.name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page
        .locator("html")
        .evaluate((el) => el.classList.contains("dark")),
    ).toBe(!theme.light);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      await page
        .locator("html")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--background").trim(),
        ),
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme.value,
    );
    if ((page.viewportSize()?.width || 1440) <= 960)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Set the mood", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeInViewport();
  }
  await page.getByRole("combobox", { name: "Theme", exact: true }).click();
  await page
    .getByRole("option", { name: "System preference", exact: true })
    .click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "daylight");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
});

test("custom calendar range can be applied", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: /1 Oct – 4 Oct 2026/ }).click();
  await page.getByRole("button", { name: /Friday, October 2nd, 2026/ }).click();
  await page
    .getByRole("button", { name: /Saturday, October 3rd, 2026/ })
    .click();
  await page.getByRole("button", { name: "Apply range", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /2 Oct – 3 Oct 2026/ }),
  ).toBeVisible();
});

const profilePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function openProfile(page: Page) {
  if ((page.viewportSize()?.width || 1440) <= 960)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "Edit profile picture" }).click();
}

test("Jellyfin profile pictures sync, upload and remove across the app", async ({
  page,
}) => {
  await fixture(page);
  let tag: string | null = "original";
  let rejectUpload = true;
  await page.route("**/api/users", (route) =>
    route.fulfill({
      json: [
        {
          id: alice,
          name: "Alessandro",
          image_tag: tag,
          can_edit_image: true,
        },
      ],
    }),
  );
  await page.route("**/api/users/*/image?*", (route) =>
    route.fulfill({ contentType: "image/png", body: profilePng }),
  );
  await page.route("**/api/me/image", (route) => {
    if (rejectUpload && route.request().method() === "POST")
      return route.fulfill({
        status: 403,
        json: { detail: "Jellyfin does not allow this profile picture change" },
      });
    tag = route.request().method() === "DELETE" ? null : "updated";
    return route.fulfill({
      json: {
        id: alice,
        name: "Alessandro",
        image_tag: tag,
        can_edit_image: true,
      },
    });
  });
  await page.goto("/");
  await expect(
    page.locator('.viewer-avatar img[src*="tag=original"]').first(),
  ).toBeAttached();
  await expect
    .poll(() => page.locator('.viewer-avatar img[src*="tag=original"]').count())
    .toBeGreaterThanOrEqual(3);
  await openProfile(page);
  await page.getByLabel("Choose a picture").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: profilePng,
  });
  await expect(page.getByAltText("New profile picture preview")).toBeVisible();
  await page.getByRole("button", { name: "Save picture", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Jellyfin does not allow",
  );
  await expect(
    page.locator('.viewer-avatar img[src*="tag=original"]').first(),
  ).toBeAttached();
  rejectUpload = false;
  const upload = page.waitForRequest(
    (r) => r.url().endsWith("/api/me/image") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Save picture", exact: true }).click();
  expect((await upload).postDataBuffer()).toEqual(profilePng);
  await expect(page.getByRole("status")).toContainText("saved to Jellyfin");
  await expect
    .poll(() => page.locator('.viewer-avatar img[src*="tag=updated"]').count())
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await navigate(page, "Now playing");
  await expect(
    page.locator('.playing-person img[src*="tag=updated"]'),
  ).toBeVisible();
  await navigate(page, "Ratings");
  await expect(
    page.locator('.user-review img[src*="tag=updated"]'),
  ).toBeVisible();
  await navigate(page, "History");
  await expect(
    page.locator('.table-viewer img[src*="tag=updated"]'),
  ).toBeVisible();
  await openProfile(page);
  await page
    .getByRole("button", { name: "Remove picture", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("removed from Jellyfin");
  await expect(page.locator(".viewer-avatar img")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove picture", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".viewer-avatar img")).toHaveCount(0);
});

test("profile picture failures fall back to initials and invalid uploads stay local", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/users", (route) =>
    route.fulfill({
      json: [
        {
          id: alice,
          name: "Alessandro",
          image_tag: "missing",
          can_edit_image: true,
        },
      ],
    }),
  );
  await page.route("**/api/users/*/image?*", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto("/");
  await openProfile(page);
  await expect(
    page.locator(".profile-picture-preview .viewer-avatar"),
  ).toHaveText("A");
  await page.getByLabel("Choose a picture").setInputFiles({
    name: "avatar.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg />"),
  });
  await expect(page.getByRole("alert")).toContainText("JPEG, PNG or WebP");
  await page.getByLabel("Choose a picture").setInputFiles({
    name: "large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("smaller than 5 MB");
  await expect(
    page.getByRole("button", { name: "Save picture", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Choose a picture").setInputFiles({
    name: "corrupt.png",
    mimeType: "image/png",
    buffer: Buffer.from("broken"),
  });
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  await expect(
    page.getByRole("button", { name: "Save picture", exact: true }),
  ).toBeDisabled();
});

test("profile editor respects Jellyfin restrictions and meets accessibility checks", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.route("**/api/users", (route) =>
    route.fulfill({
      json: [
        {
          id: alice,
          name: "Alessandro",
          image_tag: null,
          can_edit_image: false,
        },
      ],
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openProfile(page);
  await expect(
    page.getByText(
      "Your Jellyfin administrator has disabled profile picture changes.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Choose a picture")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save picture", exact: true }),
  ).toBeDisabled();
  for (const theme of themes) {
    await page.evaluate(({ value, light }) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("dark", !light);
    }, theme);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-profile.png`,
  });
});

test("login and expired authentication", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByLabel("Username").fill("Alessandro");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /A little friendly/ }),
  ).toBeVisible();
  await page.route("**/api/activity?**", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unauthorized" } }),
  );
  await navigate(page, "History");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
});

test("existing workflows render and persist ratings and watchlist actions", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await navigate(page, "Now playing");
  await expect(page.getByText("Living room TV")).toBeVisible();
  await navigate(page, "Watchlist");
  const join = page.waitForRequest(
    (r) =>
      r.url().includes(`/api/watchlist/${seriesId}/in`) &&
      r.method() === "POST",
  );
  await page.getByRole("button", { name: "I'm in", exact: true }).click();
  await join;
  await page.getByRole("button", { name: "Pick for us", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tonight's pick" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Let's watch it", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Find a movie or series to add…" })
    .fill("Rick");
  await page
    .getByRole("button", { name: /Rick and Morty Mortynight Run/ })
    .click();
  await page.getByLabel("A note for everyone").fill("Movie night");
  const add = page.waitForRequest(
    (r) =>
      new URL(r.url()).pathname === "/api/watchlist" && r.method() === "POST",
  );
  await page
    .getByRole("button", { name: "Add to watchlist", exact: true })
    .click();
  expect((await add).postDataJSON()).toEqual({
    item_id: itemId,
    note: "Movie night",
  });
  await navigate(page, "Ratings");
  await page.getByRole("button", { name: "Edit my rating" }).click();
  await page.getByRole("button", { name: "9", exact: true }).click();
  await page.getByLabel("Your take").fill("Excellent");
  const rating = page.waitForRequest(
    (r) =>
      new URL(r.url()).pathname === "/api/ratings" && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Save rating", exact: true }).click();
  expect((await rating).postDataJSON()).toEqual({
    item_id: seriesId,
    score: 9,
    note: "Excellent",
  });
  await navigate(page, "History");
  await expect(page.getByText("20m", { exact: true })).toBeVisible();
  await expect(page.getByText("17:00", { exact: false })).toBeVisible();
  await navigate(page, "System");
  await expect(page.getByText("12%", { exact: true })).toBeVisible();
});

test("network error recovers and empty analytics have useful states", async ({
  page,
}) => {
  await fixture(page);
  let fail = true;
  await page.route("**/api/analytics?**", (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: { detail: "Jellyfin is offline" },
      });
    const body = analytics(route.request().url());
    return route.fulfill({
      json: {
        ...body,
        users: [],
        recent: [],
        top_titles: [],
        breakdown: { Movie: 0, Episode: 0 },
        totals: { seconds: 0, episodes: 0, movies: 0, viewers: 0 },
        leaders: {
          seconds: [],
          peak_day_seconds: [],
          consecutive_seconds: [],
          episodes: [],
          movies: [],
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Jellyfin is offline");
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The crown is up for grabs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No completions yet" }),
  ).toBeVisible();
});

test("desktop and mobile previews have no overflow or runtime errors", async ({
  page,
}, testInfo) => {
  await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /A little friendly/ }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  for (const theme of themes) {
    await page.evaluate(({ value, light }) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("dark", !light);
    }, theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/${testInfo.project.name}-${theme.value}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("dashboard themes meet accessibility checks", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /A little friendly/ }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of themes) {
    await page.evaluate(({ value, light }) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("dark", !light);
    }, theme);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const chartLabels = await page
      .locator('[data-slot="chart"] .recharts-cartesian-axis-tick-value')
      .evaluateAll((labels) => {
        const sample = document.createElement("span");
        sample.style.color = "var(--muted-foreground)";
        document.body.append(sample);
        const expected = getComputedStyle(sample).color;
        sample.remove();
        return labels.map((label) => ({
          fill: getComputedStyle(label).fill,
          expected,
        }));
      });
    expect(chartLabels.length).toBeGreaterThan(0);
    for (const label of chartLabels) expect(label.fill).toBe(label.expected);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  }
});
