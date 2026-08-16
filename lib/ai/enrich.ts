import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";

interface EnrichInput {
  url: string;
  title: string;
  excerpt?: string;
  source?: string;
  /** Source content language (en/fr/de/ja/zh). Helps the LLM translate accurately. */
  lang?: string;
}

/**
 * Normalize a URL for reliable matching between input and LLM output.
 * LLMs sometimes strip tracking params, add/remove trailing slashes,
 * or switch http↔https — any mismatch causes the summary to be silently
 * dropped. Normalizing both sides closes the gap.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip tracking / analytics params that LLMs routinely drop
    const STRIP_PARAMS = new Set([
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "ref_src", "ref_url", "source", "fbclid", "gclid",
      "mc_cid", "mc_eid", "_ga", "_gl",
    ]);
    for (const p of STRIP_PARAMS) u.searchParams.delete(p);
    // Normalize: trailing slash, lowercase host
    let normalized = u.toString();
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const GH_SYSTEM_PROMPT_ZH = `你是一名技术编辑，负责为 GitHub Trending 项目写中文介绍。

输入：每个项目有 owner/repo 名 + 一行英文 description（可能没有）。

任务：根据 repo 名和 description，写一段 60-120 字的**通顺中文介绍**，要说清：
  1. 这个项目是做什么的，解决了什么问题
  2. 用了什么技术 / 方法（能从 repo 名 + description 推断的话）
  3. 谁会用它，典型场景是什么

写作风格：
  - 信息密度高，不写"这是一个…"这种废话开头
  - 中文术语优先，技术名词保留英文
  - 不要标题党，事实陈述为主
  - 如果信息不足，宁可短不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-120 字中文介绍>" },
    ...
  ]
}`;

const GH_SYSTEM_PROMPT_EN = `You are a technical editor writing English summaries for GitHub Trending repositories.

Input: each repo has owner/repo name + a one-line description (may be missing).

Task: write a 60-120 word **fluent English summary** covering:
  1. What the project does and what problem it solves
  2. What technology / approach (inferable from repo name + description)
  3. Who uses it, typical use case

Style:
  - High information density; avoid "This is a..." filler openings
  - Concrete; if info is insufficient, prefer shorter over fabrication
  - Factual statements only, no hype

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-120 word English summary>" },
    ...
  ]
}`;

const FINANCE_SYSTEM_PROMPT_ZH = `你是一名中文编辑，为短篇外语新闻生成**中文摘要**。

输入：每条新闻有 url、title、excerpt（RSS 简介，仅一两句话）、source（来源媒体名）和 lang（原文语言代码）。

任务：根据 title + excerpt，生成 50-100 字中文摘要：
  - 原文非中文 → 翻译关键信息为中文（不是逐字翻译，而是抽出要点）
  - 原文是中文 → 凝练为信息密度更高的中文
  - 必须保留：关键数字（涨跌幅、金额、利率）、机构/公司/人名、地区
  - 中性事实陈述，不带情绪、不标题党
  - 信息不足时宁可短，不要编造或扩展

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<50-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const FINANCE_TRANSLATE_PROMPT_ZH = `你是一名中文翻译编辑。你的唯一任务是将外语新闻**完整翻译**为中文。

输入：每条新闻有 url、title、excerpt（外语文章完整正文）、source（来源媒体名）和 lang（原文语言代码：en=英文、fr=法文、de=德文、ja=日文）。

任务：根据 lang 字段识别原文语言，将 excerpt 中的全文**完整翻译**为流畅中文，200-400字。
  - 保留原文所有关键信息：数字、百分比、金额、日期、机构名、人名、地名
  - 保留原文的引述和态度（said/dit/sagte/〜と述べた → 表示，claimed → 声称，warned → 警告）
  - 保留原文的事实逻辑链——谁做了什么、为什么、影响是什么
  - 不添加原文中没有的信息，不遗漏原文中的事实细节
  - 中文表达自然流畅，专业术语可保留原文缩写（GDP、CPI、ETF、Fed、AI）
  - 不要写成摘要——这是完整翻译，不是概括

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<完整中文翻译>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 " —— 否则会导致 JSON 解析失败。`;

const FINANCE_SYSTEM_PROMPT_EN = `You are an English-language financial / world-news editor producing **factual summaries**.

Input: each news item has url, title, excerpt, and source (publisher name).

Task: from title + excerpt, write a 50-100 word **English summary**:
  - If the source text is non-English, translate the key information (not word-for-word; extract the points)
  - If already English, condense to higher information density
  - Preserve: key numbers (% moves, amounts, rates), institutions / companies / people / regions
  - Neutral factual tone — no emotion, no clickbait
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<50-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const XVIRAL_SYSTEM_PROMPT_ZH = `你是一名中文 AI 圈编辑，为 X（Twitter）上的爆款 AI 帖子生成**中文摘要**。

输入：每条帖子有 url、title、author（@handle 形式）、previewText（推文开头几句）。

注意 X 帖子的特点：
  - title 经常是博主自己起的标题党，**摘要不要照搬标题**
  - previewText 是推文实际内容开头，**信息源以它为准**
  - 内容多是 prompt 工程 / 工作流 / 工具对比 / 案例分享 / 教程

任务：生成 60-100 字中文摘要，说清楚：
  1. **博主在分享什么**（教程？工作流？踩坑？产品发布？）
  2. **关键数字/工具/概念**（如果有）：如 \"用 Claude Code 月入 4 万美元\"、\"40 条 prompt 模板\"、\"3 个 sub-agent 协作\"
  3. **价值/角度**（如果能推断）：是新发现还是老话题？

写作风格：
  - 信息密度高，不写 \"博主分享了…\" 这种废话开头
  - 中文术语优先，工具名/平台名保留英文（Claude、GPT、Codex、Cursor 等）
  - 不带营销腔，不要 "震惊！" "必看！" 这种标题党
  - 信息不足宁可短，不要硬扩

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const XVIRAL_SYSTEM_PROMPT_EN = `You are an editor producing **English summaries** of viral AI-related X (Twitter) posts.

Input: each post has url, title, author (@handle), and previewText (first lines of the tweet).

X-post patterns:
  - title is often the author's clickbait headline — **do not just rephrase the title**
  - previewText is the actual tweet opening — **treat it as the source of truth**
  - typical content: prompt engineering / workflows / tool comparisons / case studies / tutorials

Task: write a 60-100 word English summary covering:
  1. **What the author is sharing** (tutorial? workflow? gotcha? product launch?)
  2. **Key numbers / tools / concepts** (if present): e.g. "\$40k/month with Claude Code", "40 prompt templates", "3 sub-agents collaborating"
  3. **Angle / value** (if inferable): novel finding or established take?

Style:
  - High information density; avoid "The author shares..." filler
  - Keep tool / platform names in original case (Claude, GPT, Codex, Cursor, etc.)
  - No marketing tone; no "Mind-blowing!" / "Must-read!" hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const PAPERS_SYSTEM_PROMPT_ZH = `你是一名 AI 研究方向的中文编辑，为 HuggingFace 上的热门论文写**中文摘要**。

输入：每篇论文有 url、title（英文标题）、excerpt（英文摘要开头）。

任务：根据 title + excerpt，写一段 60-110 字的**中文摘要**，说清：
  1. 这篇论文解决什么问题 / 提出什么方法
  2. 核心技术思路（模型、训练方式、数据等，能从摘要推断的话）
  3. 关键结果或贡献（有量化指标就保留，如准确率、加速比）

写作风格：
  - 信息密度高，不写"这篇论文…"这种废话开头
  - 中文表达，专业术语 / 模型名 / 方法名保留英文（Transformer、RLHF、CoT、MoE 等）
  - 事实陈述，不夸大、不标题党
  - 信息不足宁可短，不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-110 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const PAPERS_SYSTEM_PROMPT_EN = `You are an AI-research editor writing **English summaries** of trending HuggingFace papers.

Input: each paper has url, title, and excerpt (start of the English abstract).

Task: from title + excerpt, write a 60-110 word **English summary** covering:
  1. What problem the paper tackles / what method it proposes
  2. The core technical approach (model, training method, data — if inferable)
  3. Key result or contribution (keep quantitative metrics if present)

Style:
  - High information density; avoid "This paper..." filler openings
  - Keep model / method names in original form (Transformer, RLHF, CoT, MoE, etc.)
  - Factual, no hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-110 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

// Pick the right localized prompt set at module init. Each enricher reaches
// in via PROMPTS.<key> so the call sites stay locale-agnostic.
const PROMPTS =
  REPORT_LOCALE === "en"
    ? { gh: GH_SYSTEM_PROMPT_EN, finance: FINANCE_SYSTEM_PROMPT_EN, translate: FINANCE_SYSTEM_PROMPT_EN, xViral: XVIRAL_SYSTEM_PROMPT_EN, papers: PAPERS_SYSTEM_PROMPT_EN }
    : { gh: GH_SYSTEM_PROMPT_ZH, finance: FINANCE_SYSTEM_PROMPT_ZH, translate: FINANCE_TRANSLATE_PROMPT_ZH, xViral: XVIRAL_SYSTEM_PROMPT_ZH, papers: PAPERS_SYSTEM_PROMPT_ZH };

const USER_PROMPT_HEADER =
  REPORT_LOCALE === "en"
    ? (n: number) => `Candidate items (${n} entries, JSON array):`
    : (n: number) => `候选条目（共 ${n} 条，JSON 数组）：`;
const USER_PROMPT_FOOTER =
  REPORT_LOCALE === "en"
    ? `Output \`{"summaries": [{"url": ..., "summary": ...}, ...]}\` — url must be copied exactly from input.`
    : `请输出 {"summaries": [{"url": ..., "summary": ...}, ...]}，url 必须精确回填输入值。`;

async function runEnrichment(
  payload: unknown[],
  systemPrompt: string,
  scope: string,
): Promise<Map<string, string>> {
  // Sonnet has a strong "match input language" reflex — when items contain
  // English titles + Chinese-tinted source names (or just a Chinese-leaning
  // RLHF default), system-prompt-only language constraints get ignored. Pin
  // the output language as the first line of the *user* prompt for recency.
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every summary string must be written entirely in English, even if the input title or description contains Chinese."
      : "**输出语言：仅中文。** 每个 summary 字段必须全部是中文，即使输入条目是英文。";
  const userPrompt = [
    langHeader,
    "",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_PROMPT_FOOTER,
  ].join("\n");

  const result = new Map<string, string>();

  try {
    const { text } = await runLlm({
      systemPrompt,
      userPrompt,
      // 120s matches the digest call. The old 240s meant a single hung
      // DeepSeek request cost 4 minutes, and the progressive retry loop
      // (pairs → singles) re-paid the full 240s on every leg — a handful of
      // slow chunks could push the enrichment stage past 10 minutes.
      timeoutMs: 120_000,
    });
    const cleaned = extractJson(text);

    let parsed: { summaries?: Array<{ url?: string; summary?: string }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const s of parsed.summaries ?? []) {
      if (s.url && s.summary) result.set(normalizeUrl(s.url), s.summary.trim());
    }

    console.log(
      `[enrich] ${scope}: ${result.size}/${payload.length} items enriched`,
    );

    // Diagnostic: if we got back substantially fewer entries than asked for,
    // dump the raw LLM output so the cause is visible without re-running.
    // Common reasons: provider max_tokens too low → truncated JSON, model
    // refused some items, URL field altered so the upstream URL-match drops
    // entries downstream. Without this dump the failure is silent.
    if (result.size < payload.length / 2 && payload.length >= 3) {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const tag = scope.replace(/[^a-z0-9]/gi, "-");
        fs.writeFileSync(
          `logs/enrich-undercount-${tag}-${ts}.txt`,
          `scope=${scope}\nrequested=${payload.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
          "utf8",
        );
        console.warn(
          `[enrich] ${scope}: undercount ${result.size}/${payload.length} — raw dumped to logs/enrich-undercount-${tag}-${ts}.txt`,
        );
      } catch {
        // Can't write log (read-only fs?) — non-fatal, just skip.
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} failed: ${msg}`);
  }

  return result;
}

/**
 * Generate Chinese summaries for a batch of GitHub Trending repos in
 * a single Claude CLI call. Failures are non-fatal — caller gets an
 * empty map and the rendering simply omits summaries.
 */
export async function enrichGithubTrendingSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    repo: it.title,
    description: (it.excerpt ?? "").slice(0, 200),
  }));
  return runEnrichment(payload, PROMPTS.gh, "GH summaries");
}

/**
 * Generate Chinese factual summaries for the (up to ~50) finance news
 * items that will be shown in the raw panel. One Sonnet call covers
 * the whole batch.
 */
export async function enrichFinanceNewsSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();

  // Split by excerpt length: full articles get translated, short RSS
  // blurbs get summarized. This is more reliable than asking the LLM
  // to self-classify within a single prompt.
  const LONG_THRESHOLD = 200; // chars — below this it's an RSS snippet, not an article
  const longItems = items.filter((it) => (it.excerpt ?? "").length > LONG_THRESHOLD);
  const shortItems = items.filter((it) => (it.excerpt ?? "").length <= LONG_THRESHOLD);

  const result = new Map<string, string>();

  // Full articles → complete Chinese translation with progressive retry.
  // DeepSeek can be slow with large payloads (>40 KB); a single timeout
  // would silently kill an entire chunk of 4-6 articles. When a chunk
  // returns fewer results than requested, we retry the missing items in
  // progressively smaller batches (2 → 1) to isolate the problematic
  // article and let the rest through.
  if (longItems.length > 0) {
    await enrichTranslationWithRetry(longItems, result);
  }

  // Short blurbs → summary (paywalled sources, or fulltext fetch failed)
  if (shortItems.length > 0) {
    console.log(
      `[enrich] summarizing ${shortItems.length} short-excerpt articles…`,
    );
    const payload = shortItems.map((it) => ({
      url: it.url,
      title: it.title,
      source: it.source ?? "",
      lang: it.lang ?? "en",
      excerpt: (it.excerpt ?? "").slice(0, 280),
    }));
    const summarized = await runEnrichment(payload, PROMPTS.finance, "finance summaries");
    for (const [k, v] of summarized) result.set(k, v);
  }

  return result;
}

/**
 * Translate `items` in batches, with progressive size reduction on undercount.
 *
 * Strategy:
 *   1. First pass: chunk size 4 (smaller = less timeout risk, fewer items lost on failure)
 *   2. If a chunk comes back with fewer results than sent: collect the missing
 *      URLs (by comparing normalized input URLs against output keys) and retry
 *      them in pairs (size 2).
 *   3. If size-2 retry still undercounts: retry the remainders individually.
 *
 * This is self-healing — a single slow article no longer poisons its neighbors.
 */
async function enrichTranslationWithRetry(
  items: EnrichInput[],
  result: Map<string, string>,
): Promise<void> {
  const CHUNK_SIZE = 4; // was 6; reduced to lower timeout risk with large payloads
  const RETRY_CHUNK_SIZE = 2;
  const MAX_RETRY_ROUNDS = 2; // safety valve — avoid infinite loops on systemic failures

  // First pass: chunked translation
  const missed: EnrichInput[] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const chunkIdx = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(items.length / CHUNK_SIZE);
    console.log(
      `[enrich] translating chunk ${chunkIdx}/${totalChunks} (${chunk.length} articles)…`,
    );
    const payload = chunk.map((it) => ({
      url: it.url,
      title: it.title,
      source: it.source ?? "",
      lang: it.lang ?? "en",
      excerpt: (it.excerpt ?? "").slice(0, 2000),
    }));
    const translated = await runEnrichment(payload, PROMPTS.translate, "finance translation");

    // Merge results and track which input items didn't get a translation back
    for (const [k, v] of translated) result.set(k, v);

    const missingInChunk = chunk.filter(
      (it) => !translated.has(normalizeUrl(it.url)),
    );
    if (missingInChunk.length > 0) {
      console.warn(
        `[enrich] chunk ${chunkIdx}: ${missingInChunk.length}/${chunk.length} items missing from LLM output — queued for retry`,
      );
      missed.push(...missingInChunk);
    }
  }

  // Progressive retry: pairs → singles
  let round = 0;
  while (missed.length > 0 && round < MAX_RETRY_ROUNDS) {
    round++;
    const retrySize = round === 1 ? RETRY_CHUNK_SIZE : 1;
    const nextMissed: EnrichInput[] = [];

    for (let i = 0; i < missed.length; i += retrySize) {
      const batch = missed.slice(i, i + retrySize);
      console.log(
        `[enrich] retry round ${round} (size=${retrySize}): ${batch.length} article(s)…`,
      );
      const payload = batch.map((it) => ({
        url: it.url,
        title: it.title,
        source: it.source ?? "",
        lang: it.lang ?? "en",
        excerpt: (it.excerpt ?? "").slice(0, 2000),
      }));
      const retried = await runEnrichment(payload, PROMPTS.translate, "finance translation retry");
      for (const [k, v] of retried) result.set(k, v);

      const stillMissing = batch.filter(
        (it) => !retried.has(normalizeUrl(it.url)),
      );
      if (stillMissing.length > 0) {
        nextMissed.push(...stillMissing);
      }
    }
    missed.length = 0;
    missed.push(...nextMissed);
  }

  if (missed.length > 0) {
    console.warn(
      `[enrich] ${missed.length} article(s) still missing after ${MAX_RETRY_ROUNDS} retry rounds — giving up. URLs:`,
      missed.map((it) => it.url),
    );
  }
}

/**
 * Generate Chinese summaries for viral X posts. Different prompt from
 * finance because X tweets are usually clickbait titles + first-person
 * tutorial / case-study text — the model needs to dig past the headline.
 */
export async function enrichXViralSummaries(
  items: Array<EnrichInput & { author?: string }>,
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    author: it.author ?? "",
    previewText: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.xViral, "X-viral summaries");
}

/**
 * Generate summaries for trending HuggingFace papers. Separate prompt
 * from finance/GH because papers need a problem/method/result framing
 * and the excerpt is an English research abstract.
 */
export async function enrichTrendingPapersSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
  }));
  return runEnrichment(payload, PROMPTS.papers, "papers summaries");
}
