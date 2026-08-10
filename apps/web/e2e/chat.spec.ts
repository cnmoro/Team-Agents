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
    // The sidebar preview has no markdown renderer, so a mention must show as
    // plain "@Name" there rather than leaking the composer's wire syntax
    // (`@[Display Name](userId)`) straight into the row. Ada is the author
    // here, so her sidebar prefix ("Ada: ...") wraps the mention of Alan.
    await expect(row).toContainText(`@${alan.displayName} please look`);
    await expect(row).not.toContainText('@[');

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

    // Clicking the sent thumbnail opens a full-view lightbox.
    await page.locator('img.ta-image').last().click();
    await expect(page.locator('.ta-lightbox')).toBeVisible({ timeout: 5_000 });
    await page.locator('.ta-lightbox').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.ta-lightbox')).toHaveCount(0);
  });

  test('uploads several files at once and sends them all as one message', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.locator('input[type="file"]').setInputFiles([
      { name: 'multi-a.txt', mimeType: 'text/plain', buffer: Buffer.from('file a') },
      { name: 'multi-b.txt', mimeType: 'text/plain', buffer: Buffer.from('file b') },
      { name: 'multi-c.py', mimeType: 'text/x-python', buffer: Buffer.from('print("c")') },
    ]);
    await expect(page.getByText(/multi-a\.txt/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/multi-b\.txt/)).toBeVisible();
    await expect(page.getByText(/multi-c\.py/)).toBeVisible();

    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/multi-a\.txt/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/multi-b\.txt/).first()).toBeVisible();
    await expect(page.getByText(/multi-c\.py/).first()).toBeVisible();
  });

  test('a non-image attachment renders as a download card, not an inline preview', async ({ page }) => {
    // A conversation of its own: the shared ada/alan DM accumulates messages
    // (including images) across earlier tests in this file, which would make
    // the "no img.ta-image on the page" assertion below unreliable.
    await apiAs(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name: `NonImage ${Date.now()}`,
    });
    await login(page, ada);
    await openConversation(page, /^NonImage /);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake pdf content for e2e testing'),
    });
    await expect(page.getByText(/report\.pdf/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/report\.pdf/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Download/ }).first()).toBeVisible();
    // It must not be mistaken for an image and rendered inline.
    await expect(page.locator('img.ta-image')).toHaveCount(0);
  });

  test('a filename with HTML-like content renders as inert text, no XSS', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    // No path separators here on purpose — `path.basename` sanitization
    // (tested separately below) would otherwise strip everything before the
    // last slash, hiding this test's actual XSS check.
    await page.locator('input[type="file"]').setInputFiles({
      name: '<img src=x onerror=alert(1)>.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('xss filename content'),
    });
    await expect(page.getByText(/onerror/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/onerror/).first()).toBeVisible({ timeout: 20_000 });

    // No literal <img onerror> tag should have made it into the DOM, and no
    // alert() should have fired — the filename must render as inert text.
    const html = await page.content();
    expect(/<img[^>]*onerror=alert/i.test(html)).toBe(false);
    expect(dialogFired).toBe(false);
    // The app must still be alive, not crashed by the weird name.
    await expect(page.locator('.ta-shell')).toBeVisible();
  });

  test('a path-traversal-style filename is reduced to its basename, no crash', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.locator('input[type="file"]').setInputFiles({
      name: '../../etc/passed.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('path traversal attempt content'),
    });
    // The server's sanitizeFilename() takes path.basename(), so only the
    // final path segment should ever be shown or stored.
    await expect(page.getByText('passed.txt', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/\.\.\//)).toHaveCount(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('passed.txt', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ta-shell')).toBeVisible();
  });

  test('a very long filename (200+ chars) and unicode/emoji filenames upload and send without breaking the layout', async ({
    page,
  }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    const longName = `${'a'.repeat(220)}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: longName,
      mimeType: 'text/plain',
      buffer: Buffer.from('long filename content'),
    });
    await expect(page.getByText(/a{20,}/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/a{20,}/).first()).toBeVisible({ timeout: 20_000 });

    const unicodeName = '😀🎉_résumé_文件.txt';
    await page.locator('input[type="file"]').setInputFiles({
      name: unicodeName,
      mimeType: 'text/plain',
      buffer: Buffer.from('unicode filename content'),
    });
    await expect(page.getByText(unicodeName, { exact: false })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(unicodeName, { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    // Neither weird filename should have blown out the page horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
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

  test('signing out asks for confirmation first', async ({ page }) => {
    await login(page, ada);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText('Sign out of TeamAgents?')).toBeVisible();

    // Backing out leaves the session alone.
    await page.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(page.locator('.ta-shell')).toBeVisible();

    // Confirming returns to the sign-in screen.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
    await expect(page.getByLabel('Email or username')).toBeVisible({ timeout: 20_000 });
  });

  test('switches between light and dark themes', async ({ page }) => {
    await login(page, ada);

    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(before);
  });

  test('the sidebar does not overflow the viewport on a narrow phone width', async ({ page }) => {
    // Below the shell's 900px breakpoint the layout collapses to a single
    // pane. Without an explicit min-width on the grid item, the sidebar's
    // header rows (avatar/name plus three icon buttons, "Chats" plus two
    // more icon buttons) refuse to shrink below their intrinsic content
    // width and blow out the whole page into horizontal scroll — the kind
    // of thing that only shows up by actually measuring a real narrow
    // viewport, not by eyeballing a desktop window.
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ada);

    const overflowPx = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowPx).toBeLessThanOrEqual(0);
  });

  test('the Settings dialog tab bar is reachable (not clipped) on a narrow phone width', async ({
    page,
  }) => {
    // The "Repositories | Credentials | Agents | System" tab strip needs
    // more width than a 390px dialog can give it without shrinking below
    // any single tab's content width. Without a scrollable wrapper, the
    // last tab ("System") was silently clipped by the Dialog's own
    // `overflow: hidden` — invisible and unreachable, with no scrollbar or
    // affordance hinting it was there. This proves the strip is now
    // horizontally scrollable and "System" can actually be reached and
    // clicked, not just that the page as a whole avoids overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ada);

    await page.getByRole('button', { name: 'Repositories & credentials' }).click();
    await expect(page.getByRole('heading', { name: 'Repositories & credentials' })).toBeVisible();

    const systemTab = page.getByRole('button', { name: 'System', exact: true });
    const wrapper = page.locator('.ta-tab-scroll');
    await expect(wrapper).toBeVisible();

    // Scroll the strip fully into view, the way a real thumb-swipe would.
    await wrapper.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });

    await expect(systemTab).toBeVisible();
    const box = await systemTab.boundingBox();
    expect(box).not.toBeNull();
    // Fully inside the dialog's own bounds (and the 390px viewport), not
    // clipped off the right edge like before the fix.
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await systemTab.click();
    await expect(page.getByText('Agent harnesses')).toBeVisible();

    const overflowPx = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowPx).toBeLessThanOrEqual(0);
  });
});
