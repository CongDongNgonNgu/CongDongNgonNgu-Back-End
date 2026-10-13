import { describe, expect, it } from "@jest/globals";
import {
  projectCurrentNotification,
  type ConnectionNotificationAccess,
} from "./connection-notification-access";
import {
  NotificationRealtimeService,
  type NotificationRealtimeEvent,
} from "./notification-realtime.service";
import { InMemoryNotificationRepository } from "./notification.repository";
import type { NotificationRecord } from "./notification.contracts";

const parent = "00000000-0000-4000-8000-000000000010";
const record = {
  id: parent,
  intentId: parent,
  sourceEventId: parent,
  retention: { mode: "DAYS", days: 180 },
  recipientUserId: "00000000-0000-4000-8000-000000000001",
  notificationType: "COMMENT_REPLY",
  actor: {
    kind: "USER",
    displayName: "Stale private name",
    profilePath: "/profiles/stale",
  },
  target: { kind: "COMMUNITY_POST", id: parent, path: "/private/snapshot" },
  variables: { title: "Stale private body" },
  category: "COMMUNITY",
  priority: "NORMAL",
  createdAt: "2026-10-13T00:00:00.000Z",
} as NotificationRecord;

describe("current Community notice projection", () => {
  it.each(["COMMENT_REPLY", "ANSWER_ACCEPTED", "CORRECTION_ACCEPTED"] as const)(
    "fails closed for %s without current source access",
    async (notificationType) => {
      expect(
        await projectCurrentNotification(
          { ...record, notificationType },
          false,
          null,
        ),
      ).toMatchObject({
        available: false,
        response: { actor: { kind: "DELETED" }, target: null, variables: {} },
      });
    },
  );
  it("uses the current source actor and canonical parent instead of stored snapshots", async () => {
    const access = {
      resolve: async () => null,
      countUnread: async () => 0,
      resolveCommunity: async () => ({
        actor: { kind: "USER", displayName: "Current name", profilePath: null },
        parentPostId: parent,
      }),
    } as unknown as ConnectionNotificationAccess;
    expect(
      await projectCurrentNotification(record, false, null, access),
    ).toMatchObject({
      available: true,
      response: {
        actor: { displayName: "Current name" },
        target: { kind: "COMMUNITY_POST", path: "/community/posts/" + parent },
        variables: {},
      },
    });
  });
  it("never emits a saved Community snapshot through direct-construction SSE fallback", async () => {
    const service = new NotificationRealtimeService(
      new InMemoryNotificationRepository(),
    );
    const events: NotificationRealtimeEvent[] = [];
    const subscription = service
      .stream(record.recipientUserId)
      .subscribe((event) => events.push(event));
    service.publish(record);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      events.filter((event) => event.type === "notification"),
    ).toHaveLength(0);
    subscription.unsubscribe();
  });
});
