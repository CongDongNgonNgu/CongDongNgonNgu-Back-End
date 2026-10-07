import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class GroupPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}
export class CreateStudyGroupDto {
  @Transform(trim) @IsString() @Length(1, 120) name!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}
export class AcceptStudyGroupInvitationDto {
  @IsUUID("4") groupId!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
export class StudyGroupRoleDto {
  @IsIn(["MEMBER", "MODERATOR"]) role!: "MEMBER" | "MODERATOR";
}
export class StudyGroupOwnershipDto {
  @IsUUID("4") userId!: string;
}
export class StudyGroupTextDto {
  @Transform(trim) @IsString() @Length(1, 2000) body!: string;
}
export class StudyGroupReportDto {
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
export class EmptyStudyGroupDto {}
