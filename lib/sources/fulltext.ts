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

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "DailyBrief/1.0 (news aggregator bot; +https://github.com/SiliconOP/DailyBrief)";

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

    // Trim to a reasonable max — enough for the LLM to work with, but
    // not so long that it blows up the prompt payload. 2000 chars is ~10x
    // the current 280-char excerpt cap.
    return article.textContent.replace(/\s+/g, " ").trim().slice(0, 2000);
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
