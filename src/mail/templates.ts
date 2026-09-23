/*
 * System mail, by semantic id. Feature code names what it is sending and the
 * facts that go in it; the words live here. Crewly Mail renders the same ids
 * on its side, so a server using it sends the id and variables, not prose.
 */

export const MAIL_TEMPLATES = ['member.invited', 'auth.magic_link', 'notification', 'mail.test'] as const;
export type MailTemplateId = (typeof MAIL_TEMPLATES)[number];

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** Which variables each template needs. A missing one is a programming error, not a bad send. */
const REQUIRED: Record<MailTemplateId, readonly string[]> = {
  'member.invited': ['serverName', 'inviteUrl', 'role'],
  'auth.magic_link': ['serverName', 'signInUrl'],
  notification: ['serverName', 'title', 'body'],
  'mail.test': ['serverName'],
};

const escape = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);

function layout(paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((text) => `<p>${escape(text)}</p>`).join('');
  const button = action ? `<p><a href="${escape(action.url)}">${escape(action.label)}</a></p>` : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">${body}${button}</body></html>`;
}

export function renderTemplate(id: MailTemplateId, variables: Record<string, string>): RenderedMail {
  const missing = REQUIRED[id].filter((name) => !variables[name]);
  if (missing.length) throw new Error(`mail template ${id} is missing ${missing.join(', ')}`);
  const v = variables;
  switch (id) {
    case 'member.invited': {
      const lines = [`You have been invited to join ${v.serverName} on Crewly as ${v.role === 'admin' ? 'an admin' : 'a member'}.`];
      return {
        subject: `You're invited to ${v.serverName}`,
        text: `${lines[0]}\n\nAccept the invite: ${v.inviteUrl}\n\nThe link works once and expires in 7 days.\n`,
        html: layout([...lines, 'The link works once and expires in 7 days.'], { label: 'Accept the invite', url: v.inviteUrl! }),
      };
    }
    case 'auth.magic_link':
      return {
        subject: `Sign in to ${v.serverName}`,
        text: `Use this link to sign in to ${v.serverName}:\n\n${v.signInUrl}\n\nIf you did not ask for it, ignore this email.\n`,
        html: layout([`Use this link to sign in to ${v.serverName}.`, 'If you did not ask for it, ignore this email.'], { label: 'Sign in', url: v.signInUrl! }),
      };
    case 'notification':
      return {
        subject: v.title!,
        text: `${v.body}\n${v.url ? `\n${v.url}\n` : ''}\n— ${v.serverName}\n`,
        html: layout([v.body!, `— ${v.serverName}`], v.url ? { label: 'Open in Crewly', url: v.url } : undefined),
      };
    case 'mail.test':
      return {
        subject: `Test email from ${v.serverName}`,
        text: `This is a test email from ${v.serverName}. Mail delivery is working.\n`,
        html: layout([`This is a test email from ${v.serverName}. Mail delivery is working.`]),
      };
  }
}
