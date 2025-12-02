import { escape } from "html-escaper";

export interface Env {
  AI: Ai;
  SITE_NAME: string;
  SITE_TAGLINE: string;
  PRIMARY_COLOR: string;
  ACCENT_COLOR: string;
}

type AiModel = "@cf/meta/llama-3.1-8b-instruct" | "@cf/meta/llama-3.1-70b-instruct";

interface Article {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
}

interface CachedNews {
  generatedAt: string;
  ttlSeconds: number;
  articles: Article[];
}

// Simple in-memory cache per isolate to avoid calling AI on every request
let cachedNews: CachedNews | null = null;

const RSS_SOURCES = [
  {
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
  },
  {
    name: "Reuters World",
    url: "https://feeds.reuters.com/Reuters/worldNews",
  },
  {
    name: "AP Top Stories",
    url: "https://rss.apnews.com/apf-topnews",
  },
  {
    name: "CNN Top Stories",
    url: "http://rss.cnn.com/rss/edition.rss",
  },
  {
    name: "The Guardian World",
    url: "https://www.theguardian.com/world/rss",
  },
  {
    name: "Al Jazeera Top Stories",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
  },
  {
    name: "NPR World",
    url: "https://feeds.npr.org/1004/rss.xml",
  },
];

const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes
const MAX_ARTICLES_PER_SOURCE = 6;
const FINAL_ARTICLE_COUNT = 15;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/robots.txt") {
      return new Response("user-agent: *\nallow: /\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/api/news") {
      const news = await getOrGenerateNews(env, ctx);
      return Response.json(news);
    }

    const news = await getOrGenerateNews(env, ctx);
    const html = renderPage(env, news);

    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  },

  // Optional: scheduled cron trigger defined in wrangler.toml
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    cachedNews = await generateNews(env);
  },
} satisfies ExportedHandler<Env>;

async function getOrGenerateNews(env: Env, ctx: ExecutionContext): Promise<CachedNews> {
  const now = Date.now();

  if (cachedNews) {
    const generatedAt = Date.parse(cachedNews.generatedAt);
    if (!Number.isNaN(generatedAt) && now - generatedAt < cachedNews.ttlSeconds * 1000) {
      return cachedNews;
    }
  }

  const promise = generateNews(env)
    .then((news) => {
      cachedNews = news;
      return news;
    })
    .catch((err) => {
      console.error("Error generating news", err);
      if (cachedNews) {
        return cachedNews;
      }
      return {
        generatedAt: new Date().toISOString(),
        ttlSeconds: CACHE_TTL_SECONDS,
        articles: [],
      };
    });

  // Allow scheduled or background refresh
  ctx.waitUntil(promise.then(() => undefined).catch(() => undefined));

  return promise;
}

async function generateNews(env: Env): Promise<CachedNews> {
  const rssResults = await Promise.all(
    RSS_SOURCES.map(async (source) => {
      try {
        const res = await fetch(source.url, { cf: { cacheEverything: true, cacheTtl: 300 } });
        if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
        const xml = await res.text();
        return parseRss(xml, source.name);
      } catch (err) {
        console.error(`Error fetching RSS from ${source.name}`, err);
        return [];
      }
    }),
  );

  const flatArticles = rssResults.flat().slice(0, MAX_ARTICLES_PER_SOURCE * RSS_SOURCES.length);

  const uniqueArticles = dedupeAndInterleaveBySource(flatArticles).slice(0, FINAL_ARTICLE_COUNT);

  const summarized = await summarizeArticles(env, uniqueArticles);

  return {
    generatedAt: new Date().toISOString(),
    ttlSeconds: CACHE_TTL_SECONDS,
    articles: summarized,
  };
}

function dedupeAndInterleaveBySource(articles: Article[]): Article[] {
  // Deduplicate by normalized title
  const dedupedMap: { [key: string]: Article } = {};
  for (const a of articles) {
    const key = a.title.toLowerCase();
    if (!dedupedMap[key]) dedupedMap[key] = a;
  }

  const deduped = Object.values(dedupedMap);

  // Group by source
  const bySource = new Map<string, Article[]>();
  for (const a of deduped) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }

  // Round-robin across sources for better diversity
  const result: Article[] = [];
  const sourceKeys = Array.from(bySource.keys());
  let added = true;

  while (added && result.length < deduped.length) {
    added = false;
    for (const key of sourceKeys) {
      const list = bySource.get(key);
      if (list && list.length > 0) {
        const item = list.shift()!;
        result.push(item);
        added = true;
        if (result.length >= deduped.length) break;
      }
    }
  }

  return result;
}

function parseRss(xml: string, source: string): Article[] {
  const items: Article[] = [];

  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const titleRegex = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i;
  const linkRegex = /<link>([\s\S]*?)<\/link>/i;
  const pubDateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/i;
  const descRegex =
    /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i;

  const matches = xml.match(itemRegex) ?? [];
  for (const raw of matches.slice(0, MAX_ARTICLES_PER_SOURCE)) {
    const titleMatch = raw.match(titleRegex);
    const linkMatch = raw.match(linkRegex);
    const pubDateMatch = raw.match(pubDateRegex);
    const descMatch = raw.match(descRegex);

    const rawTitle = (titleMatch?.[1] || titleMatch?.[2] || "").trim();
    const title = cleanRssText(rawTitle);
    const url = (linkMatch?.[1] || "").trim();
    const publishedAt = (pubDateMatch?.[1] || "").trim();
    const rawDescription = (descMatch?.[1] || descMatch?.[2] || "").trim();
    const description = truncate(cleanRssText(rawDescription), 320);

    if (!title || !url) continue;

    items.push({
      title,
      url,
      source,
      publishedAt,
      summary: description,
    });
  }

  return items;
}

async function summarizeArticles(env: Env, articles: Article[]): Promise<Article[]> {
  if (articles.length === 0) return articles;

  const model: AiModel = "@cf/meta/llama-3.1-8b-instruct";

  const prompt = [
    "You are an editorial assistant for a professional market research firm.",
    "You are given a list of news headlines with short descriptions.",
    "For each item, produce a 2–3 sentence summary written for an informed general audience.",
    "Avoid sensational language; focus on what happened and why it matters.",
    "",
    "Return your answer as JSON with the following shape:",
    '{ "items": [ { "title": string, "summary": string } ] }',
    "",
    "Items:",
    ...articles.map(
      (a, i) =>
        `${i + 1}. Title: ${a.title}\nSource: ${a.source}\nPublished: ${a.publishedAt}\nExisting summary: ${truncate(
          a.summary,
          400,
        )}`,
    ),
  ].join("\n");

  try {
    // @ts-ignore - Workers AI type may not be available locally
    const response = await env.AI.run(model, {
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 800,
      temperature: 0.4,
    });

    const rawText =
      typeof response === "string"
        ? response
        : (response as any)?.response || (response as any)?.output || JSON.stringify(response);

    const parsed = safeJsonFromText(rawText) as { items?: { title?: string; summary?: string }[] };
    if (!parsed) {
      throw new Error("AI did not return valid JSON");
    }

    const summaries = parsed.items ?? [];

    return articles.map((article, index) => {
      const s = summaries[index];
      return {
        ...article,
        title: s?.title?.trim() || article.title,
        summary: s?.summary?.trim() || article.summary,
      };
    });
  } catch (err) {
    console.error("AI summarization failed", err);
    return articles;
  }
}

function safeJsonFromText(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract the first JSON object-like block from the text
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function cleanRssText(html: string): string {
  if (!html) return "";

  // Normalize common block-level tags to spaces, then strip remaining tags
  let text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<\/div>/gi, " ")
    .replace(/<[^>]+>/g, "");

  // Decode a few common HTML entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'");

  // Collapse whitespace
  return text.replace(/\s+/g, " ").trim();
}

function renderPage(env: Env, news: CachedNews): string {
  const { SITE_NAME, SITE_TAGLINE, PRIMARY_COLOR, ACCENT_COLOR } = env;

  const articlesHtml =
    news.articles.length === 0
      ? `<p class="empty">Live updates are currently unavailable. Please check back shortly.</p>`
      : news.articles
          .map((a) => {
            const date = a.publishedAt ? new Date(a.publishedAt).toLocaleString("en-GB", {
              timeZone: "UTC",
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }) : "";

            return `
          <article class="card">
            <header class="card-header">
              <span class="card-source">${escape(a.source)}</span>
              ${
                date
                  ? `<time class="card-date" datetime="${escape(a.publishedAt)}">${escape(date)}</time>`
                  : ""
              }
            </header>
            <h2 class="card-title">
              <a href="${escape(a.url)}" target="_blank" rel="noopener noreferrer">
                ${escape(a.title)}
              </a>
            </h2>
            <p class="card-summary">${escape(a.summary || "")}</p>
          </article>
        `;
          })
          .join("\n");

  const generatedText = news.generatedAt
    ? new Date(news.generatedAt).toLocaleString("en-GB", {
        timeZone: "UTC",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(SITE_NAME)} – ${escape(SITE_TAGLINE)}</title>
  <meta name="description" content="AI-curated global news briefs by HHeuristics, updated throughout the day.">
  <link rel="preconnect" href="https://rsms.me/">
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css">
  <style>
    :root {
      --bg: #020617;
      --bg-alt: #020b1f;
      --card-bg: #020617;
      --border-subtle: rgba(148, 163, 184, 0.35);
      --text-main: #e5e7eb;
      --text-muted: #9ca3af;
      --accent: ${ACCENT_COLOR};
      --accent-soft: rgba(31, 111, 235, 0.18);
      --primary: ${PRIMARY_COLOR};
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #020617 0, #000 45%, #020617 100%);
      color: var(--text-main);
      min-height: 100%;
    }
    body {
      display: flex;
      flex-direction: column;
    }
    .page {
      max-width: 1120px;
      margin: 0 auto;
      padding: 1.75rem 1.25rem 3rem;
    }
    header.site-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.9rem;
    }
    .brand-mark {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: radial-gradient(circle at 20% 20%, var(--accent) 0, var(--primary) 40%, #020617 100%);
      border: 1px solid rgba(148, 163, 184, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e5e7eb;
      font-weight: 600;
      font-size: 1.3rem;
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.8);
    }
    .brand-text h1 {
      font-size: 1.4rem;
      letter-spacing: 0.04em;
      margin: 0;
    }
    .brand-text span {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--text-muted);
    }
    .meta {
      text-align: right;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.18rem 0.7rem;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.4);
      background: rgba(15, 23, 42, 0.8);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 0.4rem;
    }
    .pill-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.25);
    }
    .hero {
      margin-bottom: 2.5rem;
    }
    .hero-title {
      font-size: clamp(1.9rem, 3.2vw, 2.3rem);
      line-height: 1.25;
      margin: 0 0 0.45rem;
    }
    .hero-subtitle {
      margin: 0;
      color: var(--text-muted);
      max-width: 40rem;
      font-size: 0.98rem;
    }
    .hero-subtitle strong {
      color: #e5e7eb;
      font-weight: 500;
    }
    .hero-meta {
      margin-top: 0.85rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .hero-meta span {
      opacity: 0.9;
    }
    @media (max-width: 900px) {
      header.site-header {
        flex-direction: column;
        align-items: flex-start;
      }
      .meta {
        text-align: left;
      }
    }
    section.main-column {
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.98));
      border-radius: 18px;
      padding: 1.25rem 1.25rem 1.35rem;
      border: 1px solid var(--border-subtle);
      box-shadow:
        0 16px 40px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(15, 23, 42, 0.4);
      backdrop-filter: blur(28px);
      border-image: linear-gradient(135deg, rgba(148, 163, 184, 0.6), rgba(31, 111, 235, 0.8)) 1;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 0.9rem;
    }
    .section-title h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--text-muted);
      margin: 0;
    }
    .section-title span {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1rem;
    }
    @media (max-width: 1024px) {
      .cards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 700px) {
      .cards {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .card {
      background: radial-gradient(circle at top left, var(--accent-soft), var(--card-bg));
      border-radius: 14px;
      padding: 0.95rem 0.95rem 0.95rem;
      border: 1px solid rgba(148, 163, 184, 0.4);
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      transition:
        transform 150ms ease-out,
        box-shadow 150ms ease-out,
        border-color 150ms ease-out,
        background 150ms ease-out;
    }
    .card:hover {
      transform: translateY(-2px);
      border-color: rgba(56, 189, 248, 0.75);
      box-shadow:
        0 18px 40px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(15, 23, 42, 0.6);
      background: radial-gradient(circle at top left, rgba(56, 189, 248, 0.12), var(--card-bg));
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.74rem;
      color: var(--text-muted);
    }
    .card-source {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-weight: 500;
      font-size: 0.7rem;
    }
    .card-date {
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }
    .card-title {
      font-size: 0.98rem;
      margin: 0;
    }
    .card-title a {
      color: inherit;
      text-decoration: none;
    }
    .card-title a:hover {
      color: #e5e7eb;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .card-summary {
      margin: 0;
      font-size: 0.86rem;
      line-height: 1.5;
      color: #cbd5f5;
    }
    .empty {
      margin: 0;
      padding: 0.5rem 0;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    .about {
      max-width: 1120px;
      margin: 0 auto 1.5rem;
      padding: 0 1.25rem;
    }
    .about-inner {
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(15, 23, 42, 0.98));
      border-radius: 18px;
      padding: 1.25rem 1.25rem 1.35rem;
      border: 1px solid var(--border-subtle);
      box-shadow:
        0 16px 40px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(15, 23, 42, 0.4);
      backdrop-filter: blur(28px);
    }
    .about-inner h3 {
      margin: 0 0 0.35rem;
      font-size: 0.95rem;
      font-weight: 500;
    }
    .about-inner p {
      margin: 0 0 0.75rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-bottom: 0.9rem;
    }
    .badge {
      font-size: 0.72rem;
      padding: 0.12rem 0.55rem;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.4);
      color: var(--text-muted);
    }
    footer.site-footer {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 1.25rem 2rem;
      font-size: 0.78rem;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-top: 1px solid rgba(15, 23, 42, 0.85);
    }
    footer.site-footer a {
      color: var(--text-muted);
      text-decoration: none;
    }
    footer.site-footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 700px) {
      footer.site-footer {
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="site-header">
      <div class="brand">
        <div class="brand-mark">H</div>
        <div class="brand-text">
          <h1>${escape(SITE_NAME)}</h1>
          <span>Real-time briefs by HHeuristics</span>
        </div>
      </div>
      <div class="meta">
        <div class="pill">
          <span class="pill-dot"></span>
          <span>AI Worker</span>
          <span>Live Feed</span>
        </div>
        <div>Updated approximately every ${(CACHE_TTL_SECONDS / 60).toFixed(0)} minutes</div>
        ${
          generatedText
            ? `<div>Last refresh (UTC): <span>${escape(generatedText)}</span></div>`
            : ""
        }
      </div>
    </header>

    <section class="hero">
      <h2 class="hero-title">Global news distilled for decision-makers.</h2>
      <p class="hero-subtitle">
        <strong>${escape(
          SITE_NAME,
        )}</strong> continuously scans trusted international outlets and uses AI to surface concise,
        context-rich summaries you can read in a few minutes.
      </p>
      <div class="hero-meta">
        <span>Sources may include BBC, Reuters, AP, CNN and other major publishers.</span>
      </div>
    </section>

    <section class="main-column">
      <div class="section-title">
        <h2>Top stories</h2>
        <span>${news.articles.length || "No"} stories in this snapshot</span>
      </div>
      <div class="cards">
        ${articlesHtml}
      </div>
    </section>
  </div>

  <section class="about">
    <div class="about-inner">
      <div class="section-title">
        <h2>About this feed</h2>
      </div>
      <h3>AI-assisted, human-centered</h3>
      <p>
        This page is generated by Cloudflare Workers, which fetch live headlines from multiple
        global outlets and uses large language models to create short, neutral summaries.
      </p>
      <p>
        It is designed as a quick situational awareness layer, not a replacement for full
        articles or primary reporting.
      </p>
      <div class="badge-row">
        <span class="badge">Cloudflare Workers</span>
        <span class="badge">Workers AI</span>
        <span class="badge">RSS Aggregation</span>
        <span class="badge">Automatic updates</span>
      </div>
      <p>
        For deeper sector research and strategic analysis, visit the main HHeuristics site at
        <a href="https://hheuristics.com" target="_blank" rel="noopener noreferrer">hheuristics.com</a>.
      </p>
    </div>
  </section>

  <footer class="site-footer">
    <span>© ${new Date().getFullYear()} HHeuristics. All rights reserved.</span>
    <span>Built with Cloudflare Workers &amp; AI. Content sourced from third‑party news outlets.</span>
  </footer>
</body>
</html>`;
}


