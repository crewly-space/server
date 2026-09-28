import type { RegistryItem } from './service.js';

/**
 * The Crewly catalog: skills and MCP presets that ship with the server, so an
 * owner can give agents GitHub, Linear or docs search without first finding
 * and trusting a registry. It needs no network to browse. Presets only ever
 * reference vault secrets; the owner adds the secret and grants it to the
 * installed MCP server, then grants its tools to each agent.
 */
const PUBLISHER = 'Crewly';
const PREFIX = 'crewly/';

export function isCatalogId(id: string): boolean { return id.startsWith(PREFIX); }

interface PresetSpec {
  id: string; name: string; description: string; url: string;
  /** The vault secret sent as a bearer token; omitted for servers that need none. */
  secret?: string;
  /** Additional vault secrets used by a URL or non-standard header. */
  secrets?: string[];
  headers?: Record<string, string>;
}

function preset(spec: PresetSpec): RegistryItem {
  return {
    id: `${PREFIX}${spec.id}`, type: 'mcp_preset', name: spec.name, description: spec.description,
    publisher: PUBLISHER, verified: true, compatibility: '*', requiredCapabilities: ['network.access'],
    requiredSecrets: [...new Set([...(spec.secret ? [spec.secret] : []), ...(spec.secrets ?? [])])],
    versions: [{ version: '1', manifest: {
      name: spec.name, transport: 'http', url: spec.url, capabilities: ['network'],
      headers: { ...(spec.secret ? { authorization: `Bearer {{secret:${spec.secret}}}` } : {}), ...(spec.headers ?? {}) },
    } }],
  };
}

function skill(id: string, manifest: string): RegistryItem {
  const meta = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(manifest)?.[1]?.trim() ?? '';
  return {
    id: `${PREFIX}${id}`, type: 'skill', name: meta('name'), description: meta('description'),
    publisher: PUBLISHER, verified: true, compatibility: '*', requiredCapabilities: [], requiredSecrets: [],
    versions: [{ version: meta('version') || '1', manifest: manifest.trim() }],
  };
}

const PRESETS: RegistryItem[] = [
  preset({ id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', secret: 'GITHUB_TOKEN',
    description: "GitHub's official MCP server: repositories, code search, issues, pull requests and Actions. Uses a personal access token." }),
  preset({ id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', secret: 'LINEAR_API_KEY',
    description: "Linear's official MCP server: find, create and update issues, projects and comments. Uses a Linear API key." }),
  preset({ id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', secret: 'NEON_API_KEY',
    description: 'Neon Postgres: list projects and branches, run SQL, and prepare migrations. Uses a Neon API key.' }),
  preset({ id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', secret: 'SUPABASE_ACCESS_TOKEN',
    description: 'Supabase projects: database, edge functions, logs and docs. Uses a personal access token.' }),
  preset({ id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', secret: 'STRIPE_SECRET_KEY',
    description: "Stripe's MCP server: customers, payments, invoices and docs search. Use a restricted key." }),
  preset({ id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com', secret: 'PAYPAL_ACCESS_TOKEN',
    description: 'Finance · PayPal production: invoices, payments, disputes and merchant operations. Uses a short-lived PayPal access token.' }),
  preset({ id: 'paypal-sandbox', name: 'PayPal · Sandbox', url: 'https://mcp.sandbox.paypal.com', secret: 'PAYPAL_SANDBOX_ACCESS_TOKEN',
    description: 'Finance · Test PayPal invoices and payment workflows without touching production money.' }),
  preset({ id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp',
    description: 'Finance & commerce · Square customers, orders, catalog and payments through the official OAuth-enabled endpoint.' }),
  preset({ id: 'mercury', name: 'Mercury', url: 'https://mcp.mercury.com/mcp',
    description: 'Finance · Read-only access to Mercury balances, transactions, cards, recipients and statements through OAuth.' }),
  preset({ id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com',
    description: 'Deploy & hosting · Search Vercel docs and, after OAuth, inspect projects, deployments, logs and analytics.' }),
  preset({ id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp',
    description: 'Deploy & hosting · Create, deploy and manage Netlify projects with the official remote MCP server.' }),
  preset({ id: 'cloudflare-api', name: 'Cloudflare API', url: 'https://mcp.cloudflare.com/mcp', secret: 'CLOUDFLARE_API_TOKEN',
    description: 'Cloud & infrastructure · Search and execute across DNS, Workers, R2, Zero Trust and the full Cloudflare API. Use a scoped API token.' }),
  preset({ id: 'cloudflare-observability', name: 'Cloudflare Observability', url: 'https://observability.mcp.cloudflare.com/mcp', secret: 'CLOUDFLARE_API_TOKEN',
    description: 'Observability · Investigate Cloudflare application logs and analytics with a scoped API token.' }),
  preset({ id: 'cloudflare-radar', name: 'Cloudflare Radar', url: 'https://radar.mcp.cloudflare.com/mcp',
    description: 'Research · Global Internet traffic, trends, URL scans and other Cloudflare Radar utilities.' }),
  preset({ id: 'cloudflare-browser', name: 'Cloudflare Browser', url: 'https://browser.mcp.cloudflare.com/mcp',
    description: 'Browser · Fetch web pages, convert them to Markdown and capture screenshots in Cloudflare Browser Rendering.' }),
  preset({ id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp',
    description: 'Observability · Search errors, analyze performance, triage issues and manage Sentry projects through OAuth.' }),
  preset({ id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v2/mcp',
    description: 'Project management · Jira and Confluence issues, pages, search and workflows through Atlassian OAuth.' }),
  preset({ id: 'microsoft-learn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp',
    description: 'Documentation · Search current official Microsoft and Azure technical documentation. No key needed.' }),
  preset({ id: 'hugging-face', name: 'Hugging Face', url: 'https://huggingface.co/mcp', secret: 'HF_TOKEN',
    description: 'Search Hugging Face models, datasets, Spaces and papers. Uses a Hugging Face access token.' }),
  preset({ id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp',
    description: 'Up-to-date, version-specific library documentation and code examples. No key needed.' }),
  preset({ id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp',
    description: 'Ask questions about any public GitHub repository and read its generated docs. No key needed.' }),
  preset({ id: 'cloudflare-docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp',
    description: 'Search the Cloudflare developer documentation. No key needed.' }),
  preset({ id: 'exa', name: 'Exa Search', url: 'https://mcp.exa.ai/mcp',
    description: 'Web search and page contents for research, from Exa. No key needed on the free tier.' }),
  preset({ id: 'tavily', name: 'Tavily Search', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey={{secret:TAVILY_API_KEY}}', secrets: ['TAVILY_API_KEY'],
    description: 'Search, extract, map and crawl the web with Tavily. Uses a Tavily API key.' }),
  preset({ id: 'firecrawl-keyless', name: 'Firecrawl · Search & scrape', url: 'https://mcp.firecrawl.dev/v2/mcp',
    description: 'Keyless Firecrawl tools for web search, scraping and document parsing.' }),
  preset({ id: 'firecrawl', name: 'Firecrawl · Full', url: 'https://mcp.firecrawl.dev/v2/mcp', secret: 'FIRECRAWL_API_KEY',
    description: 'Firecrawl search, scrape, crawl, map and extraction tools. Uses a Firecrawl API key for the full tool set.' }),
  preset({ id: 'postman-minimal', name: 'Postman · Minimal', url: 'https://mcp.postman.com/minimal', secret: 'POSTMAN_API_KEY',
    description: 'Essential Postman workspace and collection tools with a smaller agent context. Uses a Postman API key.' }),
  preset({ id: 'postman-code', name: 'Postman · Code', url: 'https://mcp.postman.com/code', secret: 'POSTMAN_API_KEY',
    description: 'Postman tools for generating and synchronizing API client code. Uses a Postman API key.' }),
  preset({ id: 'postman-full', name: 'Postman · Full', url: 'https://mcp.postman.com/mcp', secret: 'POSTMAN_API_KEY',
    description: 'The full Postman MCP tool set for APIs, workspaces, collections and collaboration. Uses a Postman API key.' }),
  preset({ id: 'postman-learn', name: 'Postman · Learn', url: 'https://mcp.postman.com/learn', secret: 'POSTMAN_API_KEY',
    description: 'Search Postman documentation, tutorials and API reference content. Uses a Postman API key.' }),
  preset({ id: 'postman-context-graph', name: 'Postman · Context Graph', url: 'https://mcp.postman.com/context-graph', secret: 'POSTMAN_API_KEY',
    description: 'Explore API relationships and workspace context through Postman Context Graph. Uses a Postman API key.' }),
];

const SKILLS: RegistryItem[] = [
  skill('pull-request-review', `---
name: Pull request review
slug: pull-request-review
description: Reviews a pull request for bugs, risk and missing tests, and leaves actionable comments
version: 1
---
When asked to review a pull request:

1. Read the description and the full diff before judging anything. Read the surrounding code when a change depends on it.
2. Look first for correctness: wrong logic, unhandled errors and edge cases, broken contracts between callers, security problems (injection, missing authorization, secrets in code), data loss, and concurrency issues.
3. Then check that the change is tested, and name the specific case a test is missing.
4. Report findings most severe first. For each give the file and line, what goes wrong and when, and a concrete fix.
5. Leave style preferences out unless they hide a bug. Say plainly when the change looks good.

Only post comments on the pull request when you have a tool for it and were asked to; otherwise reply with the review.`),
  skill('issue-triage', `---
name: Issue triage
slug: issue-triage
description: Triages new issues: deduplicates, labels, sets priority and asks for missing details
version: 1
---
When triaging issues:

1. Read the issue and search for existing issues describing the same problem. If one exists, link it and say it is a duplicate instead of triaging twice.
2. Classify it as a bug, feature request, question or task, and choose the area it touches.
3. Set priority from impact and reach: data loss, security or a broken core flow is urgent; a workaround lowers it.
4. For a bug without reproduction steps, expected and actual behaviour, or version, ask for exactly what is missing in one short comment.
5. Summarise what you did in one line per issue.

Never close an issue or change its assignee unless asked.`),
  skill('release-notes', `---
name: Release notes
slug: release-notes
description: Turns merged pull requests or commits since the last release into clear release notes
version: 1
---
When writing release notes:

1. Collect the changes since the previous release (merged pull requests or commits between the two tags).
2. Group them under New, Improved, Fixed and, when there are any, Breaking changes. Put breaking changes first with the step users must take.
3. Write each entry for users, not for the team: what they can now do or what no longer goes wrong. Drop internal refactors, CI and dependency bumps unless they change behaviour.
4. Keep one line per entry and link the pull request or issue.
5. Finish with the upgrade steps if any are needed.`),
  skill('incident-postmortem', `---
name: Incident postmortem
slug: incident-postmortem
description: Writes a blameless postmortem from an incident's timeline, logs and discussion
version: 1
---
When writing a postmortem:

1. Build a timeline in UTC from the evidence given: first impact, detection, key decisions, mitigation and resolution.
2. State the impact in numbers where you have them: who was affected, for how long, and what failed.
3. Explain the root cause and the contributing factors, including why detection or mitigation took as long as it did.
4. Keep it blameless: describe systems and decisions, not people.
5. End with action items, each with an owner placeholder and a concrete, checkable outcome.

Mark anything you inferred rather than read in the evidence.`),
  skill('status-update', `---
name: Status update
slug: status-update
description: Writes a short weekly status update from recent issues, pull requests and conversations
version: 1
---
When writing a status update:

1. Gather what changed in the period: shipped work, work in progress, and anything blocked.
2. Lead with the outcome that matters most to the reader, in one sentence.
3. Then three short sections: Shipped, In progress (with expected dates when known), Blocked or at risk (with what would unblock it).
4. Link the issue or pull request behind each item. Keep the whole update readable in under a minute.`),
  skill('sourced-research', `---
name: Sourced research
slug: sourced-research
description: Researches a question with search and docs tools and answers with cited sources
version: 1
---
When researching a question:

1. Use the search and documentation tools available to you. Prefer primary sources: official docs, specifications, changelogs and source code.
2. Check dates and versions; say when a source may be out of date for the version in question.
3. Answer the question directly first, then give the supporting detail.
4. Cite a source for every factual claim, and say clearly when sources disagree or when you could not confirm something.`),
];

export const CATALOG: readonly RegistryItem[] = [...PRESETS, ...SKILLS];
