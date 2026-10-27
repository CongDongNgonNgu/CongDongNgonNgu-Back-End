import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateMembershipOrderDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  planVersionId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  priceId!: string;
}
