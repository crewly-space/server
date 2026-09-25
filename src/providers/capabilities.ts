import type { ToolDefinition } from '../protocol/index.js';

/**
 * What an agent can actually do on one turn, told to the model in plain words.
 *
 * Without this a model fills the silence from its training: it says it can
 * browse, names a website it is "checking", and reports a result nothing
 * produced. The list here is built from the tools really offered on this
 * run -- after assignment, policy and provider support -- so the model is
 * never told about a tool it cannot call, and is told outright when it has
 * none.
 */
export function capabilityInstructions(tools: ToolDefinition[], now: Date = new Date()): string {
  const clock = `The current date and time is ${now.toISOString()} (UTC). Use it rather than guessing or claiming to look it up.`;
  const rules = [
    'Only describe an action as done, or a result as observed, when a tool call in this conversation actually returned it.',
    'If a tool call fails or is refused, say that it failed. Never present what it would have returned.',
    'If asked which tools you have, answer from what is stated here and nothing else.',
  ];
  if (tools.length === 0) {
    return [
      'Your capabilities on this turn: you have no tools.',
      'You cannot browse the web, open links, search, fetch live data, run code, read or write files, or contact any service. ' +
        'If a request needs any of those, say plainly that you cannot do it here, rather than pretending to.',
      clock,
      ...rules,
    ].join('\n');
  }
  const listed = tools
    .map((tool) => `- ${tool.name}${tool.description ? `: ${firstLine(tool.description)}` : ''}`)
    .join('\n');
  return [
    `Your capabilities on this turn: exactly ${tools.length === 1 ? 'this tool' : `these ${tools.length} tools`}, and no others.`,
    listed,
    'Anything these tools do not cover -- browsing, searching, live data, running code -- you cannot do here; say so instead of pretending to.',
    clock,
    ...rules,
  ].join('\n');
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * A failed tool result, marked so no provider can read it as a success.
 * Anthropic carries `is_error`; OpenAI-style APIs have nowhere to put it but
 * the text.
 */
export function markToolFailure(content: string): string {
  return content.startsWith('[tool call failed]') ? content : `[tool call failed] ${content}`;
}
