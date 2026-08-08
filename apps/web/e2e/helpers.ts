import type { Page } from '@playwright/test';

/**
 * Test helpers.
 *
 * Every spec creates its own users so runs never collide, and logs in through
 * the real UI so the auth path is covered by every test rather than stubbed.
 */

export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:4000';
export const PASSWORD = 'password123';

export interface TestUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  token: string;
}

let counter = 0;

/** Registers a user directly against the API. */
export async function createUser(prefix: string): Promise<TestUser> {
  const stamp = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  const username = `${prefix}${stamp}`;
  const body = {
    email: `${username}@e2e.test`,
    username,
    firstName: prefix.charAt(0).toUpperCase() + prefix.slice(1),
    lastName: `Tester${stamp.slice(-3)}`,
    password: PASSWORD,
  };

  const response = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);

  const result = (await response.json()) as { user: { id: string }; token: string };
  return {
    id: result.user.id,
    email: body.email,
    username: body.username,
    firstName: body.firstName,
    lastName: body.lastName,
    displayName: `${body.firstName} ${body.lastName}`,
    token: result.token,
  };
}

/** Calls the API as a given user. */
export async function apiAs<T>(
  user: TestUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Signs in through the UI and waits for the app shell. */
export async function login(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email or username').fill(user.email);
  // Astryx appends " ∙ Required" to labels, so exact matches will not work.
  await page.getByLabel(/^Password/).fill(PASSWORD);
  // The tab control shares its accessible name with the submit button; the
  // form's submit element is the unambiguous target.
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.ta-shell', { timeout: 30_000 });
}

/** Opens a conversation from the sidebar by its visible title. */
export async function openConversation(page: Page, title: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: title }).first().click();
  await page.waitForTimeout(600);
}

/** Types a message into the composer and sends it. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The sidebar row for a conversation, used to assert unread state. */
export function conversationRow(page: Page, title: string | RegExp) {
  return page.locator('.ta-conversation-row').filter({ hasText: title }).first();
}

/**
 * A message body in the conversation (markdown-rendered).
 *
 * Scoped deliberately: the same text also appears in the sidebar preview, in a
 * toast, and in the ARIA live region, so a bare `getByText` matches four
 * elements and fails Playwright's strict mode.
 */
export function messageText(page: Page, text: string | RegExp) {
  return page.locator('.ta-markdown').filter({ hasText: text });
}
