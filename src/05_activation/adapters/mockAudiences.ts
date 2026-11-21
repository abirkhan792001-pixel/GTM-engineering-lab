import { createHash } from 'node:crypto';
import type { AdPlatform, AudienceMembership } from '../../shared/types';

// Simulates matched-audience uploads to LinkedIn, Google and Meta. LinkedIn matches a company
// by its domain; Google and Meta match a person by email, which ad platforms take normalised
// and SHA-256 hashed, never in plain text. Adds are idempotent per audience and member.

export interface AudienceMember {
  platform: AdPlatform;
  audience: AudienceMembership['audience'];
  match: AudienceMembership['match'];
  // The company domain or the email address.
  value: string;
}

export interface AudienceAdapter {
  name: string;
  add(member: AudienceMember): Promise<'added' | 'already_member'>;
}

export const hashForAudience = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

export function createMockAudiences(): AudienceAdapter & { members: Map<string, Set<string>> } {
  const members = new Map<string, Set<string>>();
  return {
    name: 'mock-audiences',
    members,
    async add({ platform, audience, match, value }) {
      const key = `${platform}:${audience}`;
      const set = members.get(key) ?? new Set<string>();
      members.set(key, set);
      const stored = match === 'email' ? hashForAudience(value) : value.toLowerCase();
      if (set.has(stored)) return 'already_member';
      set.add(stored);
      return 'added';
    },
  };
}

export const mockAudiences = createMockAudiences();
