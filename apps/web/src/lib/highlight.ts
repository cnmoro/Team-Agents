import { createHighlighter, type Highlighter } from 'shiki';

/**
 * Lazily-created Shiki highlighter shared by every code block.
 *
 * Loading the engine costs a few hundred kilobytes, so it is created on first
 * use rather than at startup, and languages are loaded on demand — a chat that
 * only ever shows SQL should not pay for thirty grammars.
 */

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();

/** Languages bundled up front because they are the most common in chat. */
const INITIAL_LANGUAGES = ['bash', 'json', 'python', 'sql', 'typescript', 'markdown'];

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: INITIAL_LANGUAGES,
    });
    for (const language of INITIAL_LANGUAGES) loadedLanguages.add(language);
  }
  return highlighterPromise;
}

/** Normalizes the aliases people actually type into Shiki language ids. */
function normalizeLanguage(language: string): string {
  const alias: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    py: 'python',
    rb: 'ruby',
    cs: 'csharp',
    'c++': 'cpp',
    text: 'plaintext',
    txt: 'plaintext',
    plain: 'plaintext',
    '': 'plaintext',
  };
  const normalized = language.trim().toLowerCase();
  return alias[normalized] ?? normalized;
}

/**
 * Renders code to highlighted HTML. Returns null when highlighting is not
 * possible, so the caller can fall back to plain text rather than showing
 * nothing.
 */
export async function highlightCode(
  code: string,
  language: string,
  mode: 'light' | 'dark',
): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    const lang = normalizeLanguage(language);

    if (lang !== 'plaintext' && !loadedLanguages.has(lang)) {
      try {
        await highlighter.loadLanguage(lang as never);
        loadedLanguages.add(lang);
      } catch {
        // An unknown language is not an error: render it as plain text.
        return highlighter.codeToHtml(code, {
          lang: 'plaintext',
          theme: mode === 'dark' ? DARK_THEME : LIGHT_THEME,
        });
      }
    }

    return highlighter.codeToHtml(code, {
      lang: loadedLanguages.has(lang) ? lang : 'plaintext',
      theme: mode === 'dark' ? DARK_THEME : LIGHT_THEME,
    });
  } catch {
    return null;
  }
}
