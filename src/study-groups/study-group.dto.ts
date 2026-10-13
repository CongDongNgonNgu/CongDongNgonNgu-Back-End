import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsArray,
  ArrayMaxSize,
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
export class ConnectedPartnerInvitationDto {
  @IsUUID("4") partnerUserId!: string;
}
export class StudyGroupTextDto {
  @IsOptional() @Transform(trim) @IsString() @Length(0, 4000) body?: string;
  @IsOptional() @IsUUID('4') clientMessageId?: string;
  @IsOptional() @IsIn(['LIBRARY_RESOURCE', 'COMMUNITY_POST']) contextType?:
    'LIBRARY_RESOURCE' | 'COMMUNITY_POST';
  @IsOptional() @IsUUID('4') contextId?: string;
}
export class StudyGroupSyncDto {
  @IsOptional() @IsString() @Length(1, 2048) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  renderedIds?: string[];
}
export class StudyGroupReadDto {
  @IsUUID('4') textId!: string;
}
export class StudyGroupStreamQueryDto {}
export class StudyGroupReportDto {
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
export class EmptyStudyGroupDto {}
