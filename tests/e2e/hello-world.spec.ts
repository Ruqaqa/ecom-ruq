import { test, expect } from "@playwright/test";
import { expectAxeClean } from "./helpers/axe";

const expectedByLocale = {
  en: { title: "ecom-ruq", switcher: "العربية", tenantLabel: "Tenant" },
  ar: { title: "إيكوم-رقاقة", switcher: "English", tenantLabel: "المستأجر" },
} as const;

for (const locale of ["en", "ar"] as const) {
  test(`hello-world renders in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);

    await expect(page).toHaveURL(new RegExp(`/${locale}(/|$)`));
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    const expected = expectedByLocale[locale];
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.title);
    await expect(page.getByText(expected.tenantLabel, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: expected.switcher })).toBeVisible();

    await expectAxeClean(page);
  });
}

test("locale switcher navigates to the other locale", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("link", { name: expectedByLocale.en.switcher }).click();
  await expect(page).toHaveURL(/\/ar(\/|$)/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
