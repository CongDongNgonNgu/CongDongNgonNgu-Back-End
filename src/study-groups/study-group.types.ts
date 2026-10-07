export type GroupRole = "OWNER" | "MODERATOR" | "MEMBER";
export interface GroupResponse {
  id: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED";
  role: GroupRole;
  createdAt: string;
  updatedAt: string;
}
export interface MemberResponse {
  userId: string;
  displayName: string;
  role: GroupRole;
  joinedAt: string;
}
export interface TextResponse {
  id: string;
  body: string;
  author: { userId: string; displayName: string };
  hidden: boolean;
  createdAt: string;
}
export interface ReportResponse {
  id: string;
  textId: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
}
export interface InvitationResponse {
  id: string;
  createdAt: string;
  expiresAt: string;
  state: "UNUSED" | "ACCEPTED" | "REVOKED" | "EXPIRED";
}
export interface PageQuery {
  page?: number;
  limit?: number;
}
export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}
export interface GroupRow {
  id: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED";
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
}
export interface MembershipRow {
  user_id: string;
  role: GroupRole;
  status: "ACTIVE" | "LEFT" | "REMOVED";
  joined_at: Date;
  display_name: string;
}
