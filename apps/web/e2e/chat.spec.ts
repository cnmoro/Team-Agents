import { expect, test } from '@playwright/test';
import {
  apiAs,
  conversationRow,
  createUser,
  login,
  openConversation,
  messageText,
  sendMessage,
  type TestUser,
} from './helpers.js';

test.describe('chat', () => {
  let ada: TestUser;
  let alan: TestUser;

  test.beforeAll(async () => {
    ada = await createUser('ada');
    alan = await createUser('alan');
  });

  test('starts a direct message from the user directory', async ({ page }) => {
    await login(page, ada);

    await page.getByRole('button', { name: 'New direct message' }).click();
    await page.getByLabel(/^Search people/).fill(alan.lastName);

    const result = page.locator('.ta-autocomplete-item').filter({ hasText: alan.displayName });
    await expect(result).toBeVisible();
    await result.click();

    // The conversation opens with the other person's name as its title.
    await expect(page.getByText(alan.displayName).first()).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  });

  test('searches the directory by email, username, and full name', async ({ page }) => {
    await login(page, ada);
    await page.getByRole('button', { name: 'New direct message' }).click();

    for (const query of [alan.email, alan.username, `${alan.firstName} ${alan.lastName}`]) {
      await page.getByLabel(/^Search people/).fill(query);
      await expect(
        page.locator('.ta-autocomplete-item').filter({ hasText: alan.displayName }),
      ).toBeVisible();
    }
  });

  test('delivers a message live and marks the other side unread', async ({ browser }) => {
    const conversation = await apiAs<{ id: string; title: string }>(ada, 'POST', '/api/conversations', {
      type: 'dm',
      memberIds: [alan.id],
    });

    const adaContext = await browser.newContext();
    const alanContext = await browser.newContext();
    const adaPage = await adaContext.newPage();
    const alanPage = await alanContext.newPage();

    await login(adaPage, ada);
    await login(alanPage, alan);

    // Alan is signed in but looking elsewhere, so the message must arrive as unread.
    await openConversation(adaPage, alan.displayName);
    await sendMessage(adaPage, 'ping from ada');

    const alanRow = conversationRow(alanPage, ada.displayName);
    await expect(alanRow).toHaveAttribute('data-unread', 'true', { timeout: 20_000 });

    // Opening it clears the highlight.
    await alanRow.click();
    await expect(messageText(alanPage, 'ping from ada').first()).toBeVisible();
    await expect(conversationRow(alanPage, ada.displayName)).toHaveAttribute(
      'data-unread',
      'false',
      { timeout: 20_000 },
    );

    // And the sender never sees their own message as unread.
    await expect(conversationRow(adaPage, alan.displayName)).toHaveAttribute('data-unread', 'false');

    expect(conversation.id).toBeTruthy();
    await adaContext.close();
    await alanContext.close();
  });

  test('renders a code block with a copy button', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.getByLabel('Message', { exact: true }).fill('the migration:');
    await page.getByRole('button', { name: 'Insert code block' }).click();
    await page.getByRole('textbox', { name: /code block$/ }).fill('SELECT 1;');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const block = page.locator('.ta-code').last();
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(block.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(block).toContainText('SELECT 1;');
  });

  test('offers people and the agent when typing @', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    const composer = page.getByLabel('Message', { exact: true });
    await composer.click();
    await composer.pressSequentially('@');
    // The agent entry is always offered, alongside matching members.
    await expect(page.locator('.ta-autocomplete-item').filter({ hasText: 'Agent' })).toBeVisible();

    await composer.pressSequentially(alan.firstName.slice(0, 3).toLowerCase());
    await expect(
      page.locator('.ta-autocomplete-item').filter({ hasText: alan.displayName }),
    ).toBeVisible();
  });

  test('mentioning someone marks their sidebar row', async ({ browser }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });

    const adaContext = await browser.newContext();
    const alanContext = await browser.newContext();
    const adaPage = await adaContext.newPage();
    const alanPage = await alanContext.newPage();
    await login(adaPage, ada);
    await login(alanPage, alan);

    await openConversation(adaPage, alan.displayName);
    const composer = adaPage.getByLabel('Message', { exact: true });
    await composer.click();
    await composer.pressSequentially(`@${alan.firstName.slice(0, 3).toLowerCase()}`);
    await adaPage.locator('.ta-autocomplete-item').filter({ hasText: alan.displayName }).click();
    await composer.pressSequentially(' please look');
    await adaPage.getByRole('button', { name: 'Send', exact: true }).click();

    const row = conversationRow(alanPage, ada.displayName);
    await expect(row).toHaveAttribute('data-unread', 'true', { timeout: 20_000 });
    await row.click();
    // The mention renders as a chip rather than raw markup.
    await expect(alanPage.locator('.ta-mention')).toBeVisible();

    await adaContext.close();
    await alanContext.close();
  });

  test('loads the last 20 messages and pages back on scroll', async ({ page }) => {
    const conversation = await apiAs<{ id: string }>(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name: `History ${Date.now()}`,
    });

    for (let index = 0; index < 26; index++) {
      await apiAs(ada, 'POST', `/api/conversations/${conversation.id}/messages`, {
        blocks: [{ type: 'text', text: `history message ${index}` }],
      });
    }

    await login(page, ada);
    await openConversation(page, /History /);

    // The newest message is on screen; the oldest is still a page away.
    await expect(messageText(page, 'history message 25')).toBeVisible({ timeout: 20_000 });
    await expect(messageText(page, /^history message 0$/)).toHaveCount(0);

    // Scrolling to the top triggers the next page.
    await page.mouse.move(700, 400);
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.mouse.wheel(0, -1400);
      await page.waitForTimeout(500);
      if ((await messageText(page, /^history message 0$/).count()) > 0) break;
    }
    await expect(messageText(page, /^history message 0$/)).toBeVisible({ timeout: 20_000 });
  });

  test('creates a group chat with several members', async ({ page }) => {
    const grace = await createUser('grace');
    await login(page, ada);

    await page.getByRole('button', { name: 'New group' }).click();
    const name = `Platform ${Date.now()}`;
    await page.getByLabel(/^Group name/).fill(name);

    for (const member of [alan, grace]) {
      await page.getByLabel(/^Search people/).fill(member.lastName);
      await page.locator('.ta-autocomplete-item').filter({ hasText: member.displayName }).click();
    }

    await page.getByRole('button', { name: /^Create group/ }).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/3 members/)).toBeVisible();
  });

  test('supports ctrl-click and shift-click message selection', async ({ page }) => {
    const conversation = await apiAs<{ id: string }>(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name: `Select ${Date.now()}`,
    });
    for (let index = 0; index < 5; index++) {
      await apiAs(ada, 'POST', `/api/conversations/${conversation.id}/messages`, {
        blocks: [{ type: 'text', text: `selectable ${index}` }],
      });
    }

    await login(page, ada);
    await openConversation(page, /Select /);
    await expect(messageText(page, 'selectable 4')).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Select messages' }).click();

    const rowFor = (text: string) =>
      page.locator('.ta-message-row').filter({ hasText: text }).first();

    // Plain click selects exactly one.
    await rowFor('selectable 0').click();
    await expect(page.locator('.ta-message-row[data-selected="true"]')).toHaveCount(1);

    // Shift-click extends the range from the anchor.
    await rowFor('selectable 3').click({ modifiers: ['Shift'] });
    await expect(page.locator('.ta-message-row[data-selected="true"]')).toHaveCount(4);

    // Ctrl-click toggles a single row without clearing the rest.
    await rowFor('selectable 1').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.ta-message-row[data-selected="true"]')).toHaveCount(3);

    await expect(page.getByText(/3 messages selected as agent context/)).toBeVisible();
  });

  test('rejects a file over the 25 MB limit', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'too-big.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(26 * 1024 * 1024),
    });

    await expect(page.getByText(/the limit is 25 MB/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('uploads and renders an image attachment', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABirU3bAAAAFElEQVR42mNk+M9QzzCKQTEIAgAmAgMBSKcvVwAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'dot.png',
      mimeType: 'image/png',
      buffer: png,
    });

    await expect(page.getByText(/dot\.png/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('img.ta-image')).toBeVisible({ timeout: 20_000 });
  });

  test('renders markdown but leaves code blocks alone', async ({ page }) => {
    const conversation = await apiAs<{ id: string }>(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name: `Markdown ${Date.now()}`,
    });
    await apiAs(ada, 'POST', `/api/conversations/${conversation.id}/messages`, {
      blocks: [
        {
          type: 'text',
          text: '**bold bit** and *italic bit*\n\n- first item\n- second item\n\n[a link](https://example.com)',
        },
        { type: 'code', language: 'sql', code: 'SELECT 1;' },
      ],
    });

    await login(page, ada);
    await openConversation(page, /^Markdown /);

    const body = messageText(page, 'bold bit').first();
    await expect(body.locator('strong')).toHaveText('bold bit');
    await expect(body.locator('em')).toHaveText('italic bit');
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('a[href="https://example.com"]')).toBeVisible();

    // A code block stays a code block, with its own copy affordance.
    await expect(page.locator('.ta-code').last().getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  test('an author can delete their own message but not someone else’s', async ({ browser }) => {
    const conversation = await apiAs<{ id: string }>(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name: `Delete ${Date.now()}`,
    });

    const adaContext = await browser.newContext();
    const alanContext = await browser.newContext();
    const adaPage = await adaContext.newPage();
    const alanPage = await alanContext.newPage();
    await login(adaPage, ada);
    await login(alanPage, alan);
    await openConversation(adaPage, /^Delete /);
    await openConversation(alanPage, /^Delete /);

    await sendMessage(adaPage, 'this one goes away');
    await expect(messageText(alanPage, 'this one goes away').first()).toBeVisible({ timeout: 20_000 });

    // Alan is not the author, so he gets no delete affordance.
    const alanRow = alanPage.locator('.ta-message-row').filter({ hasText: 'this one goes away' });
    await alanRow.hover();
    await expect(alanRow.getByRole('button', { name: 'Message actions' })).toHaveCount(0);

    const adaRow = adaPage.locator('.ta-message-row').filter({ hasText: 'this one goes away' });
    await adaRow.hover();
    await adaRow.getByRole('button', { name: 'Message actions' }).click();
    await adaPage.getByText('Delete message').click();

    // It disappears for the author and for everyone else.
    await expect(messageText(adaPage, 'this one goes away')).toHaveCount(0, { timeout: 20_000 });
    await expect(messageText(alanPage, 'this one goes away')).toHaveCount(0, { timeout: 20_000 });

    await adaContext.close();
    await alanContext.close();
  });

  test('dialogs can be closed with the close button', async ({ page }) => {
    await login(page, ada);

    await page.getByRole('button', { name: 'New group' }).click();
    await expect(page.getByLabel(/^Group name/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByLabel(/^Group name/)).toHaveCount(0);
  });

  test('switches between light and dark themes', async ({ page }) => {
    await login(page, ada);

    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(before);
  });
});
