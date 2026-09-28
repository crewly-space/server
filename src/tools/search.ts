import type { NormalizedTool } from './types.js';

/**
 * Tool search: how an agent with hundreds of tools finds the three it needs
 * without every schema being sent on every turn. Plain lexical scoring over
 * the tool's name, namespace, provider, permission and description -- no
 * embeddings, no network, nothing to host.
 */

const STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'by', 'my', 'me', 'i', 'it', 'is', 'from', 'this', 'that']);
/** Words people use for the same thing, folded together before matching. */
const SYNONYMS: Record<string, string> = {
  pr: 'pull_request', prs: 'pull_request', mr: 'pull_request', pulls: 'pull_request', repository: 'repo', repositories: 'repo',
  error: 'errors', exception: 'errors', exceptions: 'errors', crash: 'errors', bug: 'errors', ticket: 'issue', tickets: 'issue',
  deploy: 'deployment', deploys: 'deployment', deployments: 'deployment', release: 'deployment', mail: 'email', emails: 'email',
  message: 'send', post: 'send', dns: 'dns', record: 'record', records: 'record', remove: 'delete', add: 'create', new: 'create',
  fetch: 'get', show: 'get', read: 'get', retrieve: 'get', lookup: 'search', find: 'search', query: 'search', edit: 'update', modify: 'update',
};

function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP.has(word))
    .flatMap((word) => {
      const folded = SYNONYMS[word] ?? word;
      return folded.includes('_') ? [folded, ...folded.split('_')] : [folded];
    });
}

export interface SearchHit<T> { tool: T; score: number }

export function searchTools<T extends Pick<NormalizedTool, 'ref' | 'name' | 'namespace' | 'provider' | 'permission' | 'description' | 'category' | 'areas'>>(
  tools: readonly T[], query: string, limit = 8,
): Array<SearchHit<T>> {
  const wanted = [...new Set(terms(query))];
  if (!wanted.length) return [];
  const scored = tools.map((tool) => {
    const nameTerms = new Set(terms(`${tool.name} ${tool.permission}`));
    const scopeTerms = new Set(terms(`${tool.namespace} ${tool.provider ?? ''} ${tool.category} ${tool.areas.join(' ')}`));
    const bodyTerms = new Set(terms(tool.description));
    let score = 0;
    let matched = 0;
    for (const term of wanted) {
      const hit = (nameTerms.has(term) ? 3 : 0) + (scopeTerms.has(term) ? 2 : 0) + (bodyTerms.has(term) ? 1 : 0);
      if (hit) matched += 1;
      score += hit;
    }
    // Covering more of the query beats repeating one word.
    score *= matched / wanted.length;
    return { tool, score };
  });
  return scored.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.tool.ref.localeCompare(b.tool.ref)).slice(0, limit);
}
