import {expect, type Page} from '@playwright/test';

export async function selectFunctionView(page: Page, scopeId: string) {
  const trigger = page.locator('.function-view__trigger');
  await trigger.click();
  await page.getByRole('menuitemradio')
    .and(page.locator(`[data-scope-id=${JSON.stringify(scopeId)}]`)).click();
  await expect(trigger).toHaveAttribute('data-scope-id', scopeId);
}
