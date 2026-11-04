import "server-only";
import { schema } from "@/db";
import type { Tx } from "@/db/tx";

type Input = {
  workspaceId: string; memberId: string; kind: string; title: string; body?: string;
  leadId?: string; taskId?: string; dedupeKey: string;
};

/** External delivery channels that are configured. In-app is always available. */
export function externalChannels(): string[] {
  return process.env.WEBHOOK_URL ? ["webhook"] : [];
}

/**
 * Creates a notification once (dedupeKey is unique), then one delivery row per channel.
 * In-app is marked sent because the notification row itself is what the app displays.
 * External channels start as "pending" and only become "sent" when a worker actually delivers them.
 */
export async function notify(tx: Tx, n: Input): Promise<boolean> {
  const [row] = await tx.insert(schema.notification).values(n).onConflictDoNothing().returning({ id: schema.notification.id });
  if (!row) return false;
  await tx.insert(schema.notificationDelivery).values([
    { notificationId: row.id, channel: "in_app", status: "sent", sentAt: new Date(), attempts: 1 },
    ...externalChannels().map((channel) => ({ notificationId: row.id, channel })),
  ]).onConflictDoNothing();
  return true;
}
