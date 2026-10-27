import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DELIVERY_CHANNELS,
} from './notification.contracts';
import type {
  NotificationCategory,
  NotificationDeliveryChannel,
} from './notification.contracts';

export class NotificationPreferenceChangeDto {
  @ApiProperty({ type: String, enum: Array.from(NOTIFICATION_CATEGORIES) })
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: NotificationCategory;

  @ApiProperty({ type: String, enum: Array.from(NOTIFICATION_DELIVERY_CHANNELS) })
  @IsIn(NOTIFICATION_DELIVERY_CHANNELS)
  channel!: NotificationDeliveryChannel;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  enabled!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ type: () => NotificationPreferenceChangeDto, isArray: true, minItems: 1, maxItems: 32 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceChangeDto)
  preferences!: NotificationPreferenceChangeDto[];
}
