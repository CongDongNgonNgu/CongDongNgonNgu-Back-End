import { IsUUID } from 'class-validator';

export class CreateMembershipOrderDto {
  @IsUUID('4')
  planVersionId!: string;

  @IsUUID('4')
  priceId!: string;
}
