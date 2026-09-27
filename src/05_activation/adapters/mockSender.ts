import type { ProspectSender } from '../approvals';

// Mock prospect sender: collects approved emails in an in-memory outbox instead of sending.

export function createMockSender(): ProspectSender & { outbox: { to: string; subject: string; text: string; draftId: string }[] } {
  const outbox: { to: string; subject: string; text: string; draftId: string }[] = [];
  return {
    name: 'mock',
    outbox,
    async send(email) {
      outbox.push({ ...email });
      return { status: 'sent', messageId: `mock_${outbox.length}` };
    },
  };
}
