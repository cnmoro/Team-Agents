import { expect, test } from '@playwright/test';
import { apiAs, createUser, login, messageText, openConversation, type TestUser } from './helpers.js';

/**
 * These exercise the real agent stack: a bubblewrap sandbox is provisioned, a
 * harness CLI is spawned, and a model provider is called. They need the
 * harnesses installed and authenticated on the host, so they are skipped
 * automatically when none is available.
 */
test.describe('agents', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  let ada: TestUser;
  let alan: TestUser;
  let hasHarness = false;

  test.beforeAll(async () => {
    ada = await createUser('ada');
    alan = await createUser('alan');
    const status = await apiAs<{ harnesses: Array<{ available: boolean }> }>(
      ada,
      'GET',
      '/api/system/status',
    );
    hasHarness = status.harnesses.some((harness) => harness.available);
  });

  /**
   * A conversation of its own per test. Creating a DM between the same two
   * people is idempotent, so reusing one would leave the previous test's agent
   * cards in the thread and make `.first()` ambiguous.
   */
  async function freshConversation(prefix: string): Promise<string> {
    const name = `${prefix} ${Date.now()}`;
    await apiAs(ada, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [alan.id],
      name,
    });
    return name;
  }

  test('the agent dialog lists harnesses and repositories', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.getByRole('button', { name: 'Run an agent' }).click();

    await expect(page.getByText('Run an agent')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claude Code' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Codex' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'OpenCode' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Agent prompt' })).toBeVisible();
  });

  test('the repository list in the agent dialog does not clip its badges on a narrow phone width', async ({
    page,
  }) => {
    // Regression guard: on a real 390px viewport the repository row's
    // protocol/credential badges (an HStack laid out `hAlign="between"`
    // against the checkbox label+description) used to get pushed past the
    // card's right edge and clipped by the card's `overflow: clip`, hiding
    // the "no credential" warning badge entirely — a real trust-signal, not
    // just cosmetic. Fixed by adding `wrap="wrap"` to that HStack (the same
    // pattern already used for the identical shape in AgentCard.tsx), so on
    // narrow widths the badges drop to their own line instead of vanishing.
    const repoName = `mobile-badge-repo-${Date.now()}`;
    await apiAs(ada, 'POST', '/api/repositories', {
      name: repoName,
      url: 'https://example.invalid/mobile-badge-repo.git',
    });
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });

    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    const checkbox = page.getByRole('checkbox', { name: new RegExp(repoName) });
    await expect(checkbox).toBeVisible();

    // Scope to this repository's own card — other repositories left over from
    // other tests/runs may also show a "no credential" badge.
    const repoCard = page.locator('.astryx-card', { has: checkbox });
    const badge = repoCard.getByText('no credential', { exact: true });
    await expect(badge).toBeVisible();

    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test('typing @Agent opens the agent dialog', async ({ page }) => {
    await apiAs(ada, 'POST', '/api/conversations', { type: 'dm', memberIds: [alan.id] });
    await login(page, ada);
    await openConversation(page, alan.displayName);

    const composer = page.getByLabel('Message', { exact: true });
    await composer.click();
    await composer.pressSequentially('@Agent');
    await page.locator('.ta-autocomplete-item').filter({ hasText: 'Agent' }).click();

    await expect(page.getByRole('textbox', { name: 'Agent prompt' })).toBeVisible();
  });

  test('runs an agent, streams its trace, and erases the sandbox on close', async ({ page }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    const name = await freshConversation('Trace');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: E2E-AGENT-OK');
    await page.getByRole('button', { name: 'Start agent' }).click();

    // The card appears immediately, before the sandbox is even ready.
    const card = page.locator('.ta-agent-card').first();
    await expect(card).toBeVisible({ timeout: 60_000 });

    // The agent's answer arrives as a real message. Scoping to the message body
    // matters: the prompt is echoed in the card title, so a bare text match would
    // pass before the agent had done anything at all.
    await expect(messageText(page, 'E2E-AGENT-OK').first()).toBeVisible({ timeout: 300_000 });
    await expect(card.getByText('Ready')).toBeVisible({ timeout: 60_000 });

    // The trace is off by default and lists typed events when opened.
    await expect(page.locator('.ta-trace-row')).toHaveCount(0);
    await card.getByRole('button', { name: 'Show trace' }).click();
    await expect(page.locator('.ta-trace-row').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ta-trace-row')).not.toHaveCount(0);
    await expect(card.getByText('turn_complete')).toBeVisible();

    // Closing asks for confirmation, then wipes the sandbox.
    await card.getByRole('button', { name: 'Close & erase sandbox' }).click();
    await expect(page.getByText(/Close this agent and erase its sandbox\?/)).toBeVisible();
    await page.getByRole('button', { name: 'Erase sandbox', exact: true }).click();

    await expect(card.getByText('Closed', { exact: true })).toBeVisible({ timeout: 60_000 });
    // History survives the close: the trace is still readable afterwards.
    await expect(messageText(page, 'E2E-AGENT-OK').first()).toBeVisible();
  });

  test('agent output renders inside the agent card, not as a chat message', async ({ page }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    const name = await freshConversation('Inside');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: INSIDE-THE-CARD');
    await page.getByRole('button', { name: 'Start agent' }).click();

    const card = page.locator('.ta-agent-card').first();
    const reply = messageText(page, 'INSIDE-THE-CARD').first();
    await expect(reply).toBeVisible({ timeout: 300_000 });

    // The reply lives inside the card's own thread rather than beside it.
    await expect(card.locator('.ta-agent-thread-body')).toContainText('INSIDE-THE-CARD');
    const insideCard = await reply.evaluate((element) =>
      Boolean(element.closest('.ta-agent-card')),
    );
    expect(insideCard).toBe(true);

    // And it is not rendered as a chat bubble from another member.
    const asBubble = await reply.evaluate((element) =>
      Boolean(element.closest('[data-sender][data-variant][data-density]')),
    );
    expect(asBubble).toBe(false);
  });

  test('an open session can be closed from the settings screen', async ({ page }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    const name = await freshConversation('Settings');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: OK');
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(page.locator('.ta-agent-card').first()).toBeVisible({ timeout: 60_000 });

    // Every session is reachable from settings, which is how a session holding
    // a repository open can be found and released.
    await page.getByRole('button', { name: 'Repositories & credentials' }).click();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();

    const row = page.locator('[data-session-row]').filter({ hasText: /in Settings \d+/ }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Close & erase' }).first().click();
    await page.getByRole('button', { name: 'Erase', exact: true }).click();

    await expect(page.getByText(/No open agent sessions|in Settings/)).toBeVisible({
      timeout: 60_000,
    });
  });

  test('the Agents settings panel does not clip the "Close & erase" button on a narrow phone width', async ({
    page,
  }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    // Regression guard: the Agents panel's session row was
    // `<HStack hAlign="between">` with no `wrap`, same shape as the repo-badge
    // bug fixed earlier. At 390px the title/badges didn't shrink, pushing the
    // destructive "Close & erase" button off the card's right edge and past
    // the dialog's own `overflow: hidden` — invisible and unreachable, so a
    // user on a narrow phone had no way to close a stuck session from
    // settings at all. Fixed by adding `wrap="wrap"` to that HStack (and the
    // nested title/badge HStack), the same pattern used elsewhere.
    const name = await freshConversation('NarrowAgents');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: OK');
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(page.locator('.ta-agent-card').first()).toBeVisible({ timeout: 60_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    // Below the single-pane breakpoint the conversation covers the sidebar
    // (and its settings button) entirely, so the mobile nav has to go back
    // to the chat list first, same as a real thumb would.
    const backButton = page.getByRole('button', { name: 'Back to chats' });
    if (await backButton.isVisible().catch(() => false)) {
      await backButton.click();
    }
    await page.getByRole('button', { name: 'Repositories & credentials' }).click();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();

    const row = page.locator('[data-session-row]').filter({ hasText: new RegExp(`in ${name}`) }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    const closeButton = row.getByRole('button', { name: 'Close & erase' }).first();
    await expect(closeButton).toBeVisible();
    const box = await closeButton.boundingBox();
    expect(box).not.toBeNull();
    // Fully inside the 390px viewport, not clipped off the right edge.
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await closeButton.click();
    await page.getByRole('button', { name: 'Erase', exact: true }).click();
    await expect(page.getByText(/No open agent sessions|in NarrowAgents/)).toBeVisible({
      timeout: 60_000,
    });
  });

  test('a follow-up prompt reuses the same sandbox and session', async ({ page }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    const name = await freshConversation('Resume');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Remember the word PLATYPUS. Reply with exactly: STORED');
    await page.getByRole('button', { name: 'Start agent' }).click();

    const card = page.locator('.ta-agent-card').first();
    await expect(messageText(page, 'STORED').first()).toBeVisible({ timeout: 300_000 });

    const sandboxPathOf = async (): Promise<string | null> =>
      (/Sandbox: (\S+)/.exec(await card.innerText())?.[1] ?? null);

    const firstSandbox = await sandboxPathOf();
    expect(firstSandbox).toBeTruthy();

    // Route the next message to the agent instead of to the conversation.
    await page.getByRole('combobox', { name: /Send to/ }).click();
    await page.getByRole('option', { name: /Remember the word/ }).click();

    await page.getByLabel('Message', { exact: true }).fill('Which word did I ask you to remember?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The agent still remembers, which is only possible if its own session was
    // resumed rather than restarted.
    await expect(messageText(page, /PLATYPUS/).last()).toBeVisible({ timeout: 300_000 });
    await expect(card.getByText(/2 turns/)).toBeVisible({ timeout: 60_000 });
    expect(await sandboxPathOf()).toBe(firstSandbox);
  });

  test('selecting messages and sending to an existing agent carries them as context', async ({
    page,
  }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    const name = await freshConversation('ContextFollowup');
    await login(page, ada);
    await openConversation(page, name);

    // A fact that only exists in the chat history, never in a prompt the agent
    // is sent directly — the only way it can reach the agent is if the
    // selected message is actually wired through as context.
    await page.getByLabel('Message', { exact: true }).fill('The launch codeword is QUOKKA-VELVET.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(messageText(page, 'QUOKKA-VELVET').first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: READY');
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(messageText(page, 'READY').first()).toBeVisible({ timeout: 300_000 });

    // Select the codeword message, then send a follow-up to the existing agent
    // with no mention of the codeword anywhere in the typed text.
    await page.getByRole('button', { name: 'Select messages' }).click();
    await page.locator('.ta-message-row').filter({ hasText: 'QUOKKA-VELVET' }).first().click();
    await expect(page.getByText('1 message selected as agent context')).toBeVisible();

    await page.getByRole('combobox', { name: /Send to/ }).click();
    await page.getByRole('option', { name: /READY/ }).click();
    await expect(page.getByText(/Sending will also hand these to/)).toBeVisible();

    await page
      .getByLabel('Message', { exact: true })
      .fill('What codeword did I mention earlier? Reply with just the word, no tools.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Selection clears itself once it has actually been used.
    await expect(page.getByText('1 message selected as agent context')).toHaveCount(0);

    await expect(messageText(page, /QUOKKA-VELVET/).last()).toBeVisible({ timeout: 300_000 });
  });

  test('the "Send to..." selector shows a different icon for everyone vs. an agent', async ({
    page,
  }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    // Regression guard: the collapsed "Send to..." control used to look
    // identical whether it targeted "Everyone in the chat" (the default) or a
    // specific agent — a user who meant to follow up with an agent but left
    // the default selected would have their message silently posted to the
    // whole chat instead, with no error and no obvious visual cue. The fix
    // gives the trigger a leading icon that swaps with the selected target.
    const name = await freshConversation('TargetIcon');
    await login(page, ada);
    await openConversation(page, name);

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page
      .getByRole('textbox', { name: 'Agent prompt' })
      .fill('Without using any tools, reply with exactly: ICON-OK');
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(messageText(page, 'ICON-OK').first()).toBeVisible({ timeout: 300_000 });

    const combobox = page.getByRole('combobox', { name: /Send to/ });
    const trigger = combobox.locator('xpath=..');

    // Untouched default: targets everyone, shows the "everyone" icon.
    await expect(trigger.locator('svg.lucide-users')).toBeVisible();
    await expect(trigger.locator('svg.lucide-wrench')).toHaveCount(0);

    await combobox.click();
    await page.getByRole('option', { name: /ICON-OK/ }).click();

    // Targeting the agent swaps the icon, so the two states are never
    // visually identical in the collapsed control.
    await expect(trigger.locator('svg.lucide-wrench')).toBeVisible();
    await expect(trigger.locator('svg.lucide-users')).toHaveCount(0);

    // Clearing back to "everyone" swaps the icon back.
    await page.getByRole('button', { name: 'Clear Send to' }).click();
    await expect(trigger.locator('svg.lucide-users')).toBeVisible();
    await expect(trigger.locator('svg.lucide-wrench')).toHaveCount(0);
  });

  test('the "Send to..." selector distinguishes two agents that share the same title', async ({
    page,
  }) => {
    test.skip(!hasHarness, 'No agent harness is installed on this host');

    // Regression guard: an agent's title defaults to a truncation of its
    // starting prompt, and two teammates in the same conversation commonly
    // start agents with the same kind of ask ("check the tests", "run the
    // linter") — sometimes on the same harness. The "Send to..." dropdown
    // used to render `agent.title` verbatim, so two such agents showed up as
    // two literally identical-looking options; selection still worked
    // (keyed by id under the hood), but a user had no way to tell which was
    // which before clicking. The Composer now disambiguates by appending the
    // harness label and, for same-harness/same-title duplicates, an ordinal
    // suffix.
    const name = await freshConversation('DuplicateTitles');
    await login(page, ada);
    await openConversation(page, name);

    const samePrompt = 'Without using any tools, reply with exactly: TWIN-READY';

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page.getByRole('textbox', { name: 'Agent prompt' }).fill(samePrompt);
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(messageText(page, 'TWIN-READY').first()).toBeVisible({ timeout: 300_000 });

    await page.getByRole('button', { name: 'Run an agent' }).click();
    await page.getByRole('textbox', { name: 'Agent prompt' }).fill(samePrompt);
    await page.getByRole('button', { name: 'Start agent' }).click();
    await expect(messageText(page, 'TWIN-READY').last()).toBeVisible({ timeout: 300_000 });

    await page.getByRole('combobox', { name: /Send to/ }).click();
    const options = page.getByRole('option').filter({ hasText: /TWIN-READY/ });
    await expect(options).toHaveCount(2);

    const [first, second] = await options.allInnerTexts();
    expect(first).not.toEqual(second);
    expect(first).toContain('(Claude Code)');
    expect(second).toContain('(Claude Code)');
  });
});
