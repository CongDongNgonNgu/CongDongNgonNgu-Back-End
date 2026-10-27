import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class RedeemMembershipCreditDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  planVersionId!: string;

  @ApiProperty({ type: Number, format: 'int32', minimum: 1, maximum: 120 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  creditUnits!: number;
}
