import type { HttpClient } from '../http-client.js';
import type { MailDelivery } from './mail.js';

export type UserRole = 'owner' | 'admin' | 'member';
export type AvatarMode = 'bloop' | 'blobatar' | 'name';

/** Anyone on the server, as a conversation draws them. */
export interface DirectoryUser {
  id: string;
  displayName: string;
  avatarMode: AvatarMode;
}

export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  /** Set while their access is withdrawn; null when they may use the server. */
  suspendedAt?: string | null;
  /** Absent from servers older than avatar modes; treat as 'bloop'. */
  avatarMode?: AvatarMode;
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invitation to join this server. The code is returned only when it is made or resent. */
export interface Invite {
  id: string;
  role: Exclude<UserRole, 'owner'>;
  /** Who it is for; only this address can accept it. Absent on servers older than invite states. */
  email?: string | null;
  /** Absent on servers older than invite states: read `usedAt` instead. */
  status?: InviteStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  revokedAt?: string | null;
  label: string | null;
  code?: string;
}

/** What an invite link offers, readable before accepting it. */
export interface InvitePreview {
  role: Exclude<UserRole, 'owner'>;
  email: string | null;
  expiresAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role?: Exclude<UserRole, 'owner'>;
}

export class UsersResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<UserAccount[]> {
    return this.http.request('GET', '/api/v1/users');
  }

  /** Names and avatars of everyone on the server. Open to members, unlike `list`. */
  directory(): Promise<{ users: DirectoryUser[] }> {
    return this.http.request('GET', '/api/v1/users/directory');
  }

  /** Changes the signed-in person's own name or avatar. */
  updateMe(input: { displayName?: string; avatarMode?: AvatarMode }): Promise<UserAccount> {
    return this.http.request('PATCH', '/api/v1/users/me', input);
  }

  create(input: CreateUserInput): Promise<UserAccount> {
    return this.http.request('POST', '/api/v1/users', input);
  }

  setRole(id: string, role: UserRole): Promise<UserAccount> {
    return this.http.request('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, { role });
  }

  /** Withdraws access, or gives it back. Suspending also ends their sessions. */
  setSuspended(id: string, suspended: boolean): Promise<UserAccount> {
    return this.http.request('PUT', `/api/v1/users/${encodeURIComponent(id)}/suspension`, { suspended });
  }

  remove(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/users/${encodeURIComponent(id)}`);
  }

  listInvites(): Promise<{ invites: Invite[] }> {
    return this.http.request('GET', '/api/v1/invites');
  }

  /** The reply carries the code. It is stored hashed, so this is the only time it is readable. */
  /** With `email`, the server also sends the invite through its mail provider and returns the delivery. */
  /** `send` defaults to true when `email` is given; false only records who the invite is for. */
  createInvite(input: { role?: Exclude<UserRole, 'owner'>; label?: string; email?: string; send?: boolean } = {}): Promise<{ invite: Invite; delivery?: MailDelivery }> {
    return this.http.request('POST', '/api/v1/invites', input);
  }

  /** A new code and a fresh expiry for an unused invite, emailed again when it names someone. */
  resendInvite(id: string): Promise<{ invite: Invite; delivery?: MailDelivery }> {
    return this.http.request('POST', `/api/v1/invites/${encodeURIComponent(id)}/resend`);
  }

  /** Withdraws an unused invite. It stays listed, as revoked. */
  revokeInvite(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/invites/${encodeURIComponent(id)}`);
  }

  /** What a code is an invite to. Needs no session. */
  previewInvite(code: string): Promise<InvitePreview> {
    return this.http.request('GET', `/api/v1/invites/${encodeURIComponent(code)}`);
  }

  /**
   * Accepts an invite. Signed in, it joins as that account and needs no
   * input; signed out, it creates the account from `input`.
   */
  acceptInvite(code: string, input?: { email: string; displayName: string; password: string }): Promise<{
    token: string;
    user: UserAccount;
  }> {
    return this.http.request('POST', `/api/v1/invites/${encodeURIComponent(code)}/accept`, input ?? {});
  }
}
