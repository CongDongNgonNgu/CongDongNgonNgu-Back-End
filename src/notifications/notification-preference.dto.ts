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
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: NotificationCategory;

  @IsIn(NOTIFICATION_DELIVERY_CHANNELS)
  channel!: NotificationDeliveryChannel;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceChangeDto)
  preferences!: NotificationPreferenceChangeDto[];
}
