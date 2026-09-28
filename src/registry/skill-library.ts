/**
 * Crewly's first cross-connector skills. Each is written against
 * capabilities ("error_tracking", "code_host"), not vendors, so it works with
 * whichever equivalent provider a workspace has connected, and declares the
 * permissions it uses routinely and the ones that must always ask.
 *
 * Permissions use the shared `resource:action` vocabulary the tool
 * classifier produces for native connectors and MCP servers alike.
 */

const READ_CODE = ['repo:read', 'pull_request:read', 'issue:read'];
const CHANGE_CODE = ['branch:create', 'commit:create', 'pull_request:create'];

export const SKILL_LIBRARY: Array<{ id: string; manifest: string }> = [
  { id: 'production-bug-fixer', manifest: `---
name: Production Bug Fixer
slug: production-bug-fixer
description: Takes a production error from error tracking to a tested fix in a pull request with a preview deployment
version: 1
requires: {"error_tracking": ["sentry", "datadog", "new-relic"], "code_host": ["github", "gitlab"]}
optional: {"deployment": ["vercel", "netlify", "cloudflare"], "issue_tracker": ["linear", "atlassian", "github"], "chat": ["slack"]}
permissions: ${JSON.stringify(['errors:read', 'traces:read', 'release:read', 'organization:read', 'project:read', ...READ_CODE, ...CHANGE_CODE, 'deployment:read', 'deployment:preview', 'logs:read'])}
approvals: ["pull_request:merge", "deployment:production"]
---
When given a production error, or asked to fix one:

1. **Inspect.** Read the issue in error tracking: the exception, the full stack trace, the release it started in, how often it happens and to how many users. Look at one or two recent events, not just the summary.
2. **Locate.** Map the stack frames to the repository. Find the release or commit where the error first appeared and read the change that introduced it.
3. **Reproduce.** Before changing anything, write down the input and state that trigger the error. Where the runtime lets you run code, write a failing test that reproduces it.
4. **Fix.** Create a branch named \`fix/<short-description>\`. Make the smallest change that fixes the cause, not the symptom. Do not refactor unrelated code.
5. **Test.** Run the existing tests and the new one. If anything fails, fix it before going on.
6. **Pull request.** Open a pull request that links the error, explains the cause in one paragraph, describes the fix and how it was tested.
7. **Preview.** If a deployment platform is connected, create a preview deployment and link it in the pull request.
8. **Stop for approval.** Merging and production deployments always need a person. Request them through the tools and report where things stand; never try another way.

If you cannot reproduce the error or find its cause, say so with what you checked, rather than guessing at a fix.` },

  { id: 'incident-commander', manifest: `---
name: Incident Commander
slug: incident-commander
description: Coordinates an incident: gathers signals, finds the likely cause, proposes mitigation and keeps everyone updated
version: 1
requires: {"incidents": ["pagerduty", "opsgenie", "better-stack"], "chat": ["slack", "microsoft-teams", "discord"]}
optional: {"error_tracking": [], "metrics": [], "logs": [], "code_host": ["github", "gitlab"], "deployment": [], "status_page": ["statuspage"]}
permissions: ["incident:read", "errors:read", "traces:read", "logs:read", "metric:read", "deployment:read", "repo:read", "pull_request:read", "slack:read"]
approvals: ["incident:write", "slack:send", "deployment:production", "status_page:write"]
---
When an incident is opened or you are asked to run one:

1. **Establish facts.** From the incident tool: what alerted, when, severity, who is on call. From error tracking, metrics and logs: what changed at that time. Keep a UTC timeline.
2. **Find what changed.** Check deployments, merged pull requests and configuration changes in the hour before first impact. A recent deploy is the most likely cause until ruled out.
3. **Assess impact.** Which users, which features, how many requests or errors. Use numbers.
4. **Propose mitigation.** Prefer reversible actions: roll back the suspect deploy, disable a feature flag, scale up. State the expected effect and the risk of each option. Rollbacks and production changes need approval.
5. **Communicate.** Draft updates for the incident channel every 30 minutes or on any change: status, impact, what is being done, next update time. Sending needs approval unless the team has allowed it.
6. **Hand over.** When resolved, write the timeline and open questions for the postmortem.

Separate what you know from what you suspect, every time.` },

  { id: 'release-manager', manifest: `---
name: Release Manager
slug: release-manager
description: Prepares and ships a release: checks CI, writes the changelog, bumps the version, deploys and watches it
version: 1
requires: {"code_host": ["github", "gitlab"]}
optional: {"ci": [], "deployment": [], "error_tracking": [], "chat": ["slack"]}
permissions: ${JSON.stringify([...READ_CODE, 'actions:read', 'release:read', 'branch:create', 'commit:create', 'pull_request:create', 'deployment:read', 'errors:read'])}
approvals: ["release:create", "pull_request:merge", "deployment:production", "slack:send", "actions:execute"]
---
When asked to cut a release:

1. **Check readiness.** The default branch's CI must be green. List open pull requests labelled for this release and anything blocking.
2. **Changelog.** Collect merged pull requests since the last release tag. Group them under Breaking, New, Improved, Fixed; write each for users; drop internal-only changes.
3. **Version.** Choose the next version by semantic versioning from what changed: breaking means major, new features minor, fixes patch. Say why.
4. **Prepare.** Open a pull request that updates the version and changelog.
5. **Ship (with approval).** Merging, tagging the release and deploying to production each need approval.
6. **Watch.** After deploying, check error tracking for new errors in the new release for the next 30 minutes and report.
7. **Announce.** Draft the announcement from the changelog; sending it needs approval.` },

  { id: 'customer-issue-resolver', manifest: `---
name: Customer Issue Resolver
slug: customer-issue-resolver
description: Takes a customer's bug report from the support desk through diagnosis and a fix to a reply the customer can use
version: 1
requires: {"support_desk": ["intercom", "zendesk", "front", "help-scout", "freshdesk", "gorgias", "crisp"], "code_host": ["github", "gitlab"]}
optional: {"error_tracking": [], "logs": [], "deployment": [], "issue_tracker": []}
permissions: ${JSON.stringify(['ticket:read', 'ticket:note', 'errors:read', 'traces:read', 'logs:read', ...READ_CODE, ...CHANGE_CODE, 'deployment:preview', 'deployment:read', 'issue:create'])}
approvals: ["ticket:reply", "pull_request:merge", "deployment:production"]
---
When given a customer conversation about a problem:

1. **Understand.** Read the whole conversation. Note the customer's account, what they did, what they expected and what happened, with times.
2. **Search history.** Look for earlier reports of the same problem in support and the issue tracker. Link duplicates instead of starting over.
3. **Find the error.** Search error tracking and logs around the times the customer gave, filtered to their account where possible.
4. **Fix or file.** If the cause is clear and small, follow the bug-fixing workflow: branch, fix, test, pull request, preview. Otherwise open an issue with the evidence.
5. **Note internally.** Add an internal note to the conversation with what you found and links.
6. **Reply (with approval).** Draft a reply that acknowledges the problem, says what is being done and gives a workaround if there is one. No internal details, no blame, no promises of dates you do not know. Sending it needs approval.` },

  { id: 'revenue-analyst', manifest: `---
name: Revenue Analyst
slug: revenue-analyst
description: Calculates and explains MRR, ARR, churn, ARPU, conversion and failed payments from billing, analytics and CRM data
version: 1
requires: {"payments": ["stripe", "paddle", "chargebee", "lemon-squeezy"]}
optional: {"product_analytics": ["posthog", "amplitude", "mixpanel"], "crm": []}
permissions: ["customer:read", "subscription:read", "invoice:read", "charge:read", "payment_intent:read", "balance:read", "price:read", "product:read", "analytics:read", "event:read", "contact:read", "deal:read"]
approvals: []
---
You analyse revenue. You only read data; you never change billing.

- **Definitions.** MRR is the sum of active subscriptions normalised to a month, excluding one-off charges, taxes and discounts already applied. ARR is MRR × 12. Churn is MRR lost from cancellations and downgrades in the period divided by MRR at its start; report logo churn (customers) and revenue churn separately. ARPU is MRR divided by paying customers.
- **Method.** State the period, the currency and every exclusion. Pull the raw data, compute, and show the numbers behind each figure so they can be checked. Page through lists fully; never extrapolate from the first page.
- **Failed payments.** Count them, the revenue at risk, and how many recovered.
- **Trial conversion and funnels.** Use product analytics when connected; say when a number comes from a different source than the rest.
- **Explain changes.** Break a month-over-month change into new, expansion, contraction and churned MRR.

If the data cannot answer the question, say what is missing.` },

  { id: 'growth-analyst', manifest: `---
name: Growth Analyst
slug: growth-analyst
description: Explains acquisition, activation and conversion from product analytics, web analytics, billing and marketing data
version: 1
requires: {"product_analytics": ["posthog", "amplitude", "mixpanel", "google-analytics", "heap"]}
optional: {"payments": [], "advertising": [], "seo": [], "email_marketing": []}
permissions: ["analytics:read", "event:read", "insight:read", "funnel:read", "cohort:read", "subscription:read", "customer:read", "campaign:read"]
approvals: []
---
You analyse growth. You only read data.

1. Define the metric and the period before querying. Name the event behind every step of a funnel.
2. Compare against the previous period and the same period last year where there is data.
3. Segment the change by channel, country, device and plan before explaining it; the average usually hides it.
4. Separate correlation from cause. Say what experiment would tell them apart.
5. End with at most three recommendations, each with the metric it should move.` },

  { id: 'security-auditor', manifest: `---
name: Security Auditor
slug: security-auditor
description: Reviews repositories, dependencies and edge configuration for security issues and reports them by severity
version: 1
requires: {"code_host": ["github", "gitlab"]}
optional: {"code_security": ["snyk", "semgrep"], "cdn": ["cloudflare"], "security": []}
permissions: ${JSON.stringify([...READ_CODE, 'code_scanning_alert:read', 'dependabot_alert:read', 'secret_scanning_alert:read', 'vulnerability:read', 'dns:read', 'zone:read', 'cloudflare_api:read'])}
approvals: ["issue:create", "pull_request:create"]
---
You audit security. You read; changing anything needs approval.

1. Collect open code scanning, dependency and secret scanning alerts, and results from connected security tools.
2. Review authentication, authorization and input handling in the code paths that face the internet.
3. Check edge configuration where connected: TLS settings, WAF rules, exposed origins, DNS records pointing at retired infrastructure.
4. Rate each finding Critical, High, Medium or Low by exploitability and impact, not by count.
5. For each: where it is, how it could be exploited, and the fix. Group duplicates.

Never paste a secret you find into a message; say where it is and that it must be rotated.` },

  { id: 'cloud-cost-optimizer', manifest: `---
name: Cloud Cost Optimizer
slug: cloud-cost-optimizer
description: Finds where cloud, hosting and database spend goes and what can be cut without hurting reliability
version: 1
requires: {"hosting": ["aws", "gcp", "azure", "vercel", "cloudflare", "netlify", "fly", "render", "railway", "digitalocean"]}
optional: {"database": [], "cloud_cost": []}
permissions: ["usage:read", "billing:read", "project:read", "deployment:read", "cost:read", "database:read", "branch:read", "zone:read", "analytics:read"]
approvals: []
---
You find savings. You only read; you propose changes, you do not make them.

1. Break spend down by provider, service and project for the last three months.
2. Look for idle or oversized resources, unattached storage, preview environments never cleaned up, and paying on-demand for steady load.
3. For each opportunity estimate the monthly saving and the risk to reliability or performance.
4. Order by saving divided by effort. Give the exact change for the top five.` },

  { id: 'sales-call-prep', manifest: `---
name: Sales Call Prep
slug: sales-call-prep
description: Prepares a one-page brief before a sales call from the CRM, email, calendar and public research
version: 1
requires: {"crm": ["hubspot", "salesforce", "pipedrive", "attio", "close"], "calendar": ["google-calendar", "microsoft-calendar"]}
optional: {"email": ["gmail", "outlook"], "web_search": []}
permissions: ["contact:read", "company:read", "deal:read", "note:read", "activity:read", "calendar:read", "email:read", "web:read", "search:read"]
approvals: ["email:send", "note:create"]
---
Before a call on the calendar:

1. Identify the attendees and their company from the event and the CRM.
2. Summarise the relationship: deal stage and value, last conversations, open questions and promises made, from the CRM and recent email.
3. Research the company: what it does, size, recent news, likely priorities. Cite sources.
4. Write a one-page brief: who, where the deal stands, what they care about, three questions to ask, and risks.

Do not email anyone or change the CRM unless asked; both need approval.` },

  { id: 'company-daily-brief', manifest: `---
name: Company Daily Brief
slug: company-daily-brief
description: One concise daily overview of engineering, product, revenue, support and the day ahead
version: 1
requires: {}
optional: {"code_host": [], "issue_tracker": [], "chat": [], "error_tracking": [], "payments": [], "support_desk": [], "product_analytics": [], "calendar": []}
permissions: ["repo:read", "pull_request:read", "issue:read", "slack:read", "errors:read", "subscription:read", "customer:read", "charge:read", "ticket:read", "analytics:read", "calendar:read"]
approvals: ["slack:send"]
---
Write one daily brief, readable in two minutes, from whatever is connected. Skip a section when nothing is connected for it; never invent data.

- **Headline.** The one thing leadership should know today.
- **Engineering.** Pull requests merged and waiting for review, releases, and new or spiking production errors.
- **Product.** Notable issue tracker movement: shipped, started, blocked.
- **Revenue.** Yesterday's new, churned and failed-payment revenue, against the 7-day average.
- **Customers.** Support volume, oldest open conversation, and any theme across tickets.
- **Today.** Meetings that need preparation.

Link every item. Posting the brief to a channel needs approval unless the team has allowed it.` },
];
