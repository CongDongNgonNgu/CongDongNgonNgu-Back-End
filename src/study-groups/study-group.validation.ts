import { HttpException } from "@nestjs/common";
import type { Page, PageQuery } from "./study-group.types";
export class StudyGroupFailure extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
  }
}
export function unavailable(): never {
  throw new StudyGroupFailure(
    "GROUP_UNAVAILABLE",
    404,
    "Study group is not available",
  );
}
export function limitReached(): never {
  throw new StudyGroupFailure(
    "GROUP_LIMIT_REACHED",
    409,
    "Study group capacity reached",
  );
}
export function invalid(): never {
  throw new StudyGroupFailure(
    "GROUP_INPUT_INVALID",
    400,
    "Request validation failed",
  );
}
export function uuid(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value,
    )
  )
    invalid();
}
export function bounded(
  value: unknown,
  max: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (
    (!allowEmpty && !normalized) ||
    [...normalized].length > max ||
    normalized.includes("\0")
  )
    invalid();
  return normalized;
}
export function pagination(input: PageQuery = {}): Required<PageQuery> {
  const page = input.page ?? 1,
    limit = input.limit ?? 20;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    invalid();
  return { page, limit };
}
export function paginate<T>(items: T[], query: Required<PageQuery>): Page<T> {
  return {
    items: items.slice(
      (query.page - 1) * query.limit,
      query.page * query.limit,
    ),
    ...query,
    total: items.length,
  };
}
