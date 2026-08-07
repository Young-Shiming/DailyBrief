/**
 * Full-text extraction module for RSS articles whose excerpt is too short
 * (typically 1–2 sentences). Fetches the original web page and uses Mozilla's
 * Readability to extract the main article body, replacing the thin excerpt
 * so downstream AI enrichment has enough material to work with.
 *
 * Design: best-effort, non-blocking. Every failure (timeout, DNS, parse error)
 * returns null so callers can fall back to the original excerpt.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

/**
 * Truncate text at the last sentence boundary before `maxLen`, so we
 * never cut a word (or a sentence) in half. Falls back to hard truncation
 * if no boundary is found in the last 20% of the string.
 */
function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Search backwards from maxLen for a sentence-ending character
  // followed by a space (or end of string).
  const searchStart = Math.floor(maxLen * 0.8);
  const slice = text.slice(0, maxLen);
  const boundary = slice.search(/[.。!！?？](?:\s|$)(?!\w)/);

  // Find the LAST sentence boundary in our range
  let lastIdx = -1;
  const re = /[.。!！?？](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    if (m.index >= searchStart || lastIdx >= searchStart) {
      lastIdx = m.index + 1; // include the punctuation
    } else {
      lastIdx = m.index + 1;
    }
  }

  if (lastIdx > 0) return text.slice(0, lastIdx).trim();
  // Fallback: hard truncation at last space before maxLen
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "DailyBrief/1.0 (news aggregator bot; +https://github.com/SiliconOP/DailyBrief)";

/**
 * Domains with hard paywalls — their article body is behind a login, so
 * fulltext extraction would only grab a teaser or a subscribe banner.
 * Skip them and let downstream enrichment fall back to the RSS excerpt.
 */
const PAYWALL_DOMAINS = new Set([
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "economist.com",
]);

function isPaywalled(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return PAYWALL_DOMAINS.has(host) || [...PAYWALL_DOMAINS].some(
      (d) => host.endsWith("." + d),
    );
  } catch {
    return false;
  }
}

/**
 * Paywall / subscription-nag patterns per language. After Readability
 * extracts the article body, we check the first 500 chars against these
 * patterns. If we match, the "article" is actually a paywall blocker and
 * we fall back to the original RSS excerpt.
 *
 * Patterns are kept short (2-4 words) so translations / rewordings still
 * hit. We check only the first 500 chars because a real article won't
 * lead with "subscribe now" — that's always a paywall.
 */
const PAYWALL_CONTENT_PATTERNS: [string, RegExp][] = [
  // German — Spiegel+, Zeit+, FAZ+, etc.
  ["de", /SPIEGEL\+|(?:Jetzt|kostenlos)\s+(?:weiterlesen|anmelden)|Abo\s+(?:abschließen|testen)|kostenpflichtig(?:er|e|es)?\s+Inhalt|exklusiv\s+(?:für|nur)\s+(?:Abonnent|Digital)|(?:Digital|Print)[- ]?Abo|Zugang\s+zu\s+allen\s+Artikeln/i],
  // English — Bloomberg, WSJ, etc. (domain-level skip normally catches these,
  // but pattern is a safety net for paywall pages that get through)
  ["en", /(?:subscribe|sign\s*up)\s+(?:now|today|to\s+(?:continue|read))|(?:paid|premium)\s+(?:content|article)|create\s+(?:a|your|free)\s+account\s+to\s+(?:continue|read|access)|this\s+(?:content|article)\s+is\s+(?:for|reserved\s+for)\s+subscriber/i],
  // French — Le Monde, Le Figaro, etc.
  ["fr", /(?:abonnez|inscrivez)[- ]vous|réservé\s+(?:aux|à)\s+(?:abonnés|nos)|(?:article|contenu)\s+réservé|poursuivez\s+(?:votre|la)\s+lecture|(?:abonnement|Premium)\s+(?:à|dès)/i],
  // Japanese — Nikkei, Asahi, etc.
  ["ja", /(?:有料|会員|購読)(?:記事|限定|登録)|(?:続き|全文)\s*(?:を|は)\s*(?:読む|ご覧).*(?:登録|会員|ログイン)/i],
  // Spanish — El País, etc.
  ["es", /(?:suscr[íi]b|reg[íi]str|inicie\s+sesión)\s+(?:ahora|para|y)|(?:contenido|artículo)\s+(?:exclusivo|reservado|solo\s+para)|hazte\s+(?:socio|suscriptor|premium)/i],
];

function isPaywallContent(text: string, url: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 500);
  for (const [, re] of PAYWALL_CONTENT_PATTERNS) {
    if (re.test(head)) return true;
  }
  return false;
}

export interface FullTextResult {
  url: string;
  text: string | null;
}

/**
 * Fetch and extract the main article text from a URL.
 * Returns null on any failure (timeout, HTTP error, parse failure).
 */
export async function fetchFullText(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  // Paywalled sources — don't waste a request on a login wall.
  if (isPaywalled(url)) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    clearTimeout(timer);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null; // skip non-HTML responses (PDFs, images, etc.)
    }

    const html = await response.text();
    if (html.length < 500) return null; // too short to be a real article

    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article?.textContent) return null;

    // Trim to a reasonable max at a sentence boundary so we never cut
    // mid-word. 2000 chars is ~10x the original 280-char excerpt cap.
    const cleaned = article.textContent.replace(/\s+/g, " ").trim();

    // Reject paywall / login-wall / "subscribe to continue" placeholder
    // text masquerading as article body (e.g. Spiegel+ premium articles).
    if (isPaywallContent(cleaned, url)) return null;

    return truncateAtSentence(cleaned, 2000);
  } catch {
    return null;
  }
}

/**
 * Run fetchFullText on multiple URLs with concurrency control.
 * Never throws — individual failures return null in the result.
 */
export async function fetchFullTextBatch(
  urls: string[],
  concurrency: number = 5,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FullTextResult[]> {
  const results: FullTextResult[] = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      const text = await fetchFullText(url, timeoutMs);
      results.push({ url, text });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  return results;
}
