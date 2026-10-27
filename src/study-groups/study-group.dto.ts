import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 1_000_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}
export class CreateStudyGroupDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @Transform(trim) @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}
export class AcceptStudyGroupInvitationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID("4") groupId!: string;
  @ApiProperty({ type: String, pattern: (/^[A-Za-z0-9_-]{43}$/).source, writeOnly: true })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
export class StudyGroupRoleDto {
  @ApiProperty({ type: String, enum: Array.from(["MEMBER", "MODERATOR"]) })
  @IsIn(["MEMBER", "MODERATOR"]) role!: "MEMBER" | "MODERATOR";
}
export class StudyGroupOwnershipDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID("4") userId!: string;
}
export class ConnectedPartnerInvitationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID("4") partnerUserId!: string;
}
export class StudyGroupTextDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 0, maxLength: 4000 })
  @IsOptional() @Transform(trim) @IsString() @Length(0, 4000) body?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional() @IsUUID('4') clientMessageId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, enum: Array.from(['LIBRARY_RESOURCE', 'COMMUNITY_POST']) })
  @IsOptional() @IsIn(['LIBRARY_RESOURCE', 'COMMUNITY_POST']) contextType?:
    'LIBRARY_RESOURCE' | 'COMMUNITY_POST';
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional() @IsUUID('4') contextId?: string;
}
export class StudyGroupSyncDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 2048 })
  @IsOptional() @IsString() @Length(1, 2048) cursor?: string;
  @ApiPropertyOptional({ type: Number, nullable: true, format: 'int32', minimum: 1, maximum: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
  @ApiPropertyOptional({ type: String, isArray: true, nullable: true, format: 'uuid', maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  renderedIds?: string[];
}
export class StudyGroupReadDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4') textId!: string;
}
export class StudyGroupStreamQueryDto {}
export class StudyGroupReportDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
export class EmptyStudyGroupDto {}
