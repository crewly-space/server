import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import type { ToolsetProvider, ToolOutcome } from '../providers/respond.js';
import { createApproval } from '../approvals/repository.js';
import { capabilityActionHash, evaluateCapability, recordPolicyDecision, type CapabilityScope, type ExecutionCapability } from '../permissions/capabilities.js';
import { createArtifact } from '../artifacts/service.js';
import type { AttachmentStore } from '../attachments/service.js';

export interface BrowserSnapshot { url: string; title: string; text: string; elements: Array<{ index: number; role: string; name: string; href?: string }>; }
export interface BrowserAdapter {
  create(): Promise<string>;
  navigate(handle: string, url: string): Promise<BrowserSnapshot>;
  snapshot(handle: string): Promise<BrowserSnapshot>;
  action(handle: string, input: { action: 'back' | 'forward' | 'reload' | 'click' | 'type' | 'select' | 'scroll'; index?: number; value?: string }): Promise<BrowserSnapshot>;
  screenshot(handle: string, fullPage: boolean): Promise<{ data: Buffer; mimeType: 'image/png' | 'image/svg+xml' }>;
  close(handle: string): Promise<void>;
}

function privateIp(address: string): boolean {
  if (address.includes(':')) return address === '::1' || address === '::' || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address) || address.startsWith('::ffff:');
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function publicHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('browser_url_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new Error('browser_private_network_blocked');
  return url;
}

function plainText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 100_000);
}
function decode(value: string): string { return plainText(value); }
function snapshotOf(url: string, html: string): BrowserSnapshot {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url);
  const elements: BrowserSnapshot['elements'] = [];
  const pattern = /<(a|button|input|select|textarea)\b([^>]*)>([\s\S]*?)<\/(?:a|button|select|textarea)>|<input\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null; let index = 0;
  while ((match = pattern.exec(html)) && index < 500) {
    const tag = (match[1] ?? 'input').toLowerCase(); const attrs = match[2] ?? match[4] ?? ''; const content = match[3] ?? '';
    const name = decode(content) || attrs.match(/(?:aria-label|placeholder|value)=["']([^"']+)/i)?.[1] || tag;
    const href = attrs.match(/href=["']([^"']+)/i)?.[1];
    elements.push({ index: index++, role: tag === 'a' ? 'link' : tag, name, ...(href ? { href: new URL(href, url).toString() } : {}) });
  }
  return { url, title, text: plainText(html), elements };
}

/** Lightweight managed target; deployments may inject a Chromium adapter. */
export class FetchBrowserAdapter implements BrowserAdapter {
  private sessions = new Map<string, { history: BrowserSnapshot[]; index: number }>();
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async create(): Promise<string> { const id = randomUUID(); this.sessions.set(id, { history: [], index: -1 }); return id; }
  private get(handle: string) { const session = this.sessions.get(handle); if (!session) throw new Error('browser_session_expired'); return session; }
  async navigate(handle: string, raw: string): Promise<BrowserSnapshot> {
    const url = await publicHttpUrl(raw); const response = await this.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'CrewlyBrowser/1' } });
    if (!response.ok) throw new Error(`browser_navigation_failed_${response.status}`);
    const type = response.headers.get('content-type') ?? ''; if (!type.includes('text/html') && !type.includes('text/plain')) throw new Error('browser_unsupported_content');
    const page = snapshotOf(url.toString(), await response.text()); const session = this.get(handle);
    session.history = session.history.slice(0, session.index + 1); session.history.push(page); session.index = session.history.length - 1; return page;
  }
  async snapshot(handle: string): Promise<BrowserSnapshot> { const session = this.get(handle); const page = session.history[session.index]; if (!page) throw new Error('browser_page_unavailable'); return page; }
  async action(handle: string, input: { action: 'back' | 'forward' | 'reload' | 'click' | 'type' | 'select' | 'scroll'; index?: number; value?: string }): Promise<BrowserSnapshot> {
    const session = this.get(handle);
    if (input.action === 'back') session.index = Math.max(0, session.index - 1);
    else if (input.action === 'forward') session.index = Math.min(session.history.length - 1, session.index + 1);
    else if (input.action === 'reload') return this.navigate(handle, (await this.snapshot(handle)).url);
    else if (input.action === 'click') { const element = (await this.snapshot(handle)).elements.find((entry) => entry.index === input.index); if (!element?.href) throw new Error('browser_element_not_actionable'); return this.navigate(handle, element.href); }
    return this.snapshot(handle);
  }
  async screenshot(handle: string): Promise<{ data: Buffer; mimeType: 'image/svg+xml' }> {
    const page = await this.snapshot(handle); const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
    const lines = page.text.match(/.{1,110}(?:\s|$)/g)?.slice(0, 45) ?? [];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="#fff"/><style>text{font:16px sans-serif;fill:#111}.title{font:bold 22px sans-serif}</style><text x="28" y="36" class="title">${escape(page.title)}</text>${lines.map((line, i) => `<text x="28" y="${72 + i * 14}">${escape(line.trim())}</text>`).join('')}</svg>`;
    return { data: Buffer.from(svg), mimeType: 'image/svg+xml' };
  }
  async close(handle: string): Promise<void> { this.sessions.delete(handle); }
}

interface BrowserSession { id: string; handle: string; expiresAt: number; pageCount: number; }
export function browserToolset(options: { db: Database; adapter: BrowserAdapter; store: AttachmentStore; maxSessions?: number; ttlMs?: number; maxPages?: number }): ToolsetProvider {
  const live = new Map<string, BrowserSession>(); const ttl = options.ttlMs ?? 15 * 60_000; const maxPages = options.maxPages ?? 10;
  const authorize = (agentId: string, runId: string, capability: ExecutionCapability, action: string, scope: CapabilityScope, target?: unknown): ToolOutcome | undefined => {
    const actionHash = capabilityActionHash({ capability, action, scope, target }); const result = evaluateCapability(options.db, { agentId, capability, scope });
    recordPolicyDecision(options.db, { runId, capability, decision: result.decision, policyId: result.policyId, actionHash });
    if (result.decision === 'deny') return { content: `${capability} is denied by this agent's policy.`, isError: true };
    if (result.decision === 'ask') {
      const existing = options.db.prepare("SELECT status FROM approvals WHERE run_id = ? AND action_hash = ? ORDER BY created_at DESC LIMIT 1").pluck().get(runId, actionHash) as string | undefined;
      if (existing === 'approved') return undefined;
      if (!existing || existing === 'denied' || existing === 'expired') createApproval(options.db, { runId, agentId, action, capability, actionHash, details: { capability, scope }, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      return { content: `Approval required for ${action}. The exact action has been queued for an owner.`, isError: true };
    }
    return undefined;
  };
  const expire = async () => { for (const [id, session] of live) if (session.expiresAt <= Date.now()) { await options.adapter.close(session.handle).catch(() => undefined); live.delete(id); options.db.prepare("UPDATE browser_sessions SET status = 'expired', closed_at = ? WHERE id = ?").run(new Date().toISOString(), id); } };
  return (agent, input) => {
    if (!input.run) return undefined; const runId = input.run.runId;
    const policy = evaluateCapability(options.db, { agentId: agent.id, capability: 'browser.control' }); if (policy.decision === 'deny') return undefined;
    return { definitions: [
      { name: 'browser_create', description: 'Create an isolated ephemeral browser session.', inputSchema: { type: 'object', properties: {} } },
      { name: 'browser_navigate', description: 'Navigate a browser session to a public HTTP(S) URL and return text plus structured controls.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string' } }, required: ['sessionId', 'url'] } },
      { name: 'browser_snapshot', description: 'Read current page text and structured controls.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
      { name: 'browser_action', description: 'Operate the current page: back, forward, reload, click, type, select, or scroll.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'string', enum: ['back','forward','reload','click','type','select','scroll'] }, index: { type: 'number' }, value: { type: 'string' } }, required: ['sessionId','action'] } },
      { name: 'browser_screenshot', description: 'Capture the current page as a run artifact.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, fullPage: { type: 'boolean' } }, required: ['sessionId'] } },
      { name: 'browser_close', description: 'Close a browser session and discard its isolated state.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
    ], instructions: 'Browser sessions are isolated and temporary. Private-network targets are blocked. Close sessions when finished.', async execute(call) {
      await expire(); const started = Date.now(); const sessionId = String(call.input.sessionId ?? ''); let session = live.get(sessionId);
      try {
        if (call.name === 'browser_create') {
          const denied = authorize(agent.id, runId, 'browser.control', 'browser.create', {}); if (denied) return denied;
          if (live.size >= (options.maxSessions ?? 8)) return { content: 'Browser session limit reached.', isError: true };
          const id = randomUUID(); const handle = await options.adapter.create(); session = { id, handle, expiresAt: Date.now() + ttl, pageCount: 0 }; live.set(id, session);
          options.db.prepare(`INSERT INTO browser_sessions (id, run_id, agent_id, status, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?)`)
            .run(id, runId, agent.id, new Date().toISOString(), new Date(session.expiresAt).toISOString()); return { content: JSON.stringify({ sessionId: id, expiresAt: new Date(session.expiresAt).toISOString() }) };
        }
        if (!session) return { content: 'Browser session is unavailable or expired.', isError: true };
        session.expiresAt = Date.now() + ttl;
        if (call.name === 'browser_close') { await options.adapter.close(session.handle); live.delete(session.id); options.db.prepare("UPDATE browser_sessions SET status='closed', closed_at=? WHERE id=?").run(new Date().toISOString(), session.id); return { content: 'Browser session closed.' }; }
        let output: unknown; let artifactId: string | undefined; let url: string | undefined;
        if (call.name === 'browser_navigate') {
          url = String(call.input.url ?? ''); const parsed = new URL(url); const denied = authorize(agent.id, runId, 'network.access', 'browser.navigate', { domain: parsed.hostname }, { url }); if (denied) return denied;
          if (session.pageCount >= maxPages) return { content: 'Browser page limit reached.', isError: true }; output = await options.adapter.navigate(session.handle, url); session.pageCount += 1;
          options.db.prepare('UPDATE browser_sessions SET page_count = ?, expires_at = ? WHERE id = ?').run(session.pageCount, new Date(session.expiresAt).toISOString(), session.id);
        } else if (call.name === 'browser_snapshot') output = await options.adapter.snapshot(session.handle);
        else if (call.name === 'browser_action') {
          const action = String(call.input.action) as 'back' | 'forward' | 'reload' | 'click' | 'type' | 'select' | 'scroll';
          if (['click','type','select'].includes(action)) { const denied = authorize(agent.id, runId, 'external.side_effect', `browser.${action}`, { session: session.id }, { index: call.input.index, value: call.input.value }); if (denied) return denied; }
          output = await options.adapter.action(session.handle, { action, index: Number(call.input.index), value: call.input.value === undefined ? undefined : String(call.input.value) });
        } else if (call.name === 'browser_screenshot') {
          const capture = await options.adapter.screenshot(session.handle, Boolean(call.input.fullPage)); const artifact = createArtifact(options.db, options.store, { conversationId: input.conversationId, uploadedBy: agent.ownerUserId, agentId: agent.id, runId,
            filename: `browser-${session.id}.${capture.mimeType === 'image/png' ? 'png' : 'svg'}`, mimeType: capture.mimeType, data: capture.data }); artifactId = artifact.id; output = { artifactId, url: artifact.url };
        }
        options.db.prepare(`INSERT INTO browser_actions (id, session_id, action, url, status, artifact_id, duration_ms, created_at) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?)`)
          .run(randomUUID(), session.id, call.name, url ?? null, artifactId ?? null, Date.now() - started, new Date().toISOString());
        return { content: JSON.stringify(output), ...(artifactId ? { artifactId } : {}) };
      } catch (error) {
        if (session) options.db.prepare(`INSERT INTO browser_actions (id, session_id, action, status, duration_ms, created_at) VALUES (?, ?, ?, 'failed', ?, ?)`)
          .run(randomUUID(), session.id, call.name, Date.now() - started, new Date().toISOString());
        return { content: error instanceof Error ? error.message : 'Browser action failed.', isError: true };
      }
    } };
  };
}
