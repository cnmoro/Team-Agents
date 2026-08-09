/**
 * Regenerates the screenshots used in README.md.
 *
 * Seeds a self-contained demo conversation, runs a real agent in it, and
 * captures the app from a browser. Point it at any running deployment:
 *
 *   node scripts/screenshots.mjs                       # dev stack on :5173
 *   BASE=http://127.0.0.1:4000 node scripts/screenshots.mjs   # docker stack
 *
 * Requires the seeded demo users (`npm run seed`) and, for the agent shots, at
 * least one harness installed.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API ?? BASE;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/screenshots');
const PASSWORD = 'password123';

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? ''}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  return response.json();
}

const signIn = (identifier) =>
  api(null, 'POST', '/api/auth/login', { identifier, password: PASSWORD });

/** A small gradient PNG, so the attachment shot shows something recognisable. */
function gradientPng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      raw[offset++] = Math.round(40 + 120 * u);
      raw[offset++] = Math.round(70 + 90 * v);
      raw[offset++] = Math.round(160 + 70 * (1 - u));
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function seedDemo() {
  const ada = await signIn('ada@teamagents.dev');
  const grace = await signIn('grace');
  const alan = await signIn('alan');

  const name = 'Platform Team';
  const conversations = await api(ada.token, 'GET', '/api/conversations?limit=50');
  let conversation = conversations.items.find((entry) => entry.title === name);
  if (!conversation) {
    conversation = await api(ada.token, 'POST', '/api/conversations', {
      type: 'group',
      memberIds: [grace.user.id, alan.user.id],
      name,
    });
  }
  const id = conversation.id;

  // Re-running must not duplicate the demo, which would push the agent card in
  // among a second copy of the messages and ruin the framing.
  const existing = await api(ada.token, 'GET', `/api/conversations/${id}/messages?limit=50`);
  const alreadySeeded = existing.items.some((message) =>
    message.blocks.some((block) => block.type === 'text' && block.text.includes('Release checklist')),
  );
  if (alreadySeeded) {
    const agents = await api(ada.token, 'GET', `/api/conversations/${id}/agents`);
    return { conversationName: name, hasHarness: agents.some((a) => a.status !== 'closed') };
  }

  await api(grace.token, 'POST', `/api/conversations/${id}/messages`, {
    blocks: [
      {
        type: 'text',
        text:
          '**Release checklist** for Thursday — `--dry-run` first, always:\n\n' +
          '1. Migration reviewed by @[Ada Lovelace](' + ada.user.id + ')\n' +
          '2. Rollback plan written down\n' +
          '3. [Runbook](https://example.com/runbook) linked in the ticket\n\n' +
          '> Blocking on the first one.',
      },
    ],
    mentions: [ada.user.id],
  });

  await api(alan.token, 'POST', `/api/conversations/${id}/messages`, {
    blocks: [
      { type: 'text', text: 'Here is the migration as it stands:' },
      {
        type: 'code',
        language: 'sql',
        code:
          'ALTER TABLE users\n' +
          '  ADD COLUMN last_seen_at TIMESTAMPTZ;\n\n' +
          'CREATE INDEX CONCURRENTLY idx_users_last_seen\n' +
          '  ON users (last_seen_at DESC);',
      },
    ],
  });

  const png = gradientPng(960, 540);
  const form = new FormData();
  form.append('conversationId', id);
  form.append('file', new Blob([png], { type: 'image/png' }), 'dashboard.png');
  const uploaded = await (
    await fetch(`${API}/api/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ada.token}` },
      body: form,
    })
  ).json();

  await api(ada.token, 'POST', `/api/conversations/${id}/messages`, {
    blocks: [
      { type: 'text', text: 'Reviewed — and the dashboard already shows the new column:' },
      {
        type: 'image',
        fileId: uploaded.id,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        size: uploaded.size,
        width: uploaded.width,
        height: uploaded.height,
      },
    ],
  });

  // A real agent run, so the card and trace show genuine output.
  const status = await api(ada.token, 'GET', '/api/system/status');
  const harness = status.harnesses.find((entry) => entry.available);
  if (harness) {
    const agents = await api(ada.token, 'GET', `/api/conversations/${id}/agents`);
    if (!agents.some((agent) => agent.status !== 'closed')) {
      await api(ada.token, 'POST', '/api/agents', {
        conversationId: id,
        harness: harness.id,
        repositoryIds: [],
        prompt:
          'Without using any tools: in one sentence, say you will add the index concurrently, ' +
          'then show the final SQL in a fenced code block.',
        title: 'Add last_seen_at index',
      });
    }
  }

  return { conversationName: name, hasHarness: Boolean(harness) };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { conversationName, hasHarness } = await seedDemo();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  await page.goto(BASE);
  await page.getByLabel('Email or username').fill('ada@teamagents.dev');
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.ta-shell', { timeout: 30_000 });

  await page.getByRole('button', { name: new RegExp(conversationName) }).first().click();

  if (hasHarness) {
    for (let attempt = 0; attempt < 90; attempt++) {
      if ((await page.locator('.ta-agent-card').filter({ hasText: 'Ready' }).count()) > 0) break;
      await page.waitForTimeout(2000);
    }
  }
  await page.waitForTimeout(1500);

  const shot = async (file) => {
    await page.screenshot({ path: path.join(OUT, file) });
    console.log(`wrote ${file}`);
  };

  // 1. The conversation: markdown, mentions, code, attachments.
  await page.locator('.ta-markdown').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot('chat.png');

  // 2. The agent card with its trace open.
  if (hasHarness) {
    const card = page.locator('.ta-agent-card').first();
    await card.scrollIntoViewIfNeeded();
    const trace = card.getByRole('button', { name: 'Show trace' });
    if (await trace.count()) {
      await trace.click();
      await page.waitForTimeout(1500);
      await card.scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(600);
    await shot('agent-card.png');
  }

  // 3. The @Agent flow.
  await page.getByRole('button', { name: 'Run an agent' }).click();
  await page.waitForTimeout(1200);
  await shot('agent-dialog.png');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);

  // 4. Selecting messages to hand an agent as context.
  await page.getByRole('button', { name: 'Select messages' }).click();
  const rows = page.locator('.ta-message-row');
  const count = await rows.count();
  if (count >= 2) {
    await rows.nth(Math.max(0, count - 3)).click();
    await rows.nth(count - 2).click({ modifiers: ['Shift'] });
  }
  await page.waitForTimeout(600);
  await shot('message-selection.png');
  await page.getByRole('button', { name: 'Done selecting' }).click();

  // 5. Repositories and credentials.
  await page.getByRole('button', { name: 'Repositories & credentials' }).click();
  await page.waitForTimeout(1200);
  await shot('settings.png');
  // Escape rather than the close button: the dialog's own backdrop swallows
  // clicks aimed at controls behind it while it is animating out.
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(600);

  // 6. Dark mode.
  await page.getByRole('button', { name: /Switch to dark theme/ }).click();
  await page.waitForTimeout(1000);
  const darkTarget = page.locator('.ta-agent-card').first();
  if (await darkTarget.count()) await darkTarget.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot('dark-mode.png');

  await browser.close();
  console.log(`\nScreenshots written to ${OUT}`);
}

await main();
