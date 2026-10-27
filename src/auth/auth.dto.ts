import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normalizeEmail } from '../identity/identity.types';

const passwordPattern = /\S/;

export class RegisterDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 120, pattern: (/\S/).source })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  displayName!: string;

  @ApiProperty({ type: String, minLength: 12, maxLength: 128, pattern: (passwordPattern).source, writeOnly: true })
  @IsString()
  @Length(12, 128)
  @Matches(passwordPattern)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, writeOnly: true })
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class EmailDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class TokenDto {
  @ApiProperty({ type: String, minLength: 20, maxLength: 256, writeOnly: true })
  @IsString()
  @Length(20, 256)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty({ type: String, minLength: 12, maxLength: 128, pattern: (passwordPattern).source, writeOnly: true })
  @IsString()
  @Length(12, 128)
  @Matches(passwordPattern)
  password!: string;
}

export class OAuthModeDto {
  @ApiProperty({ type: String, enum: Array.from(['login', 'register', 'link']) })
  @IsIn(['login', 'register', 'link'])
  mode!: 'login' | 'register' | 'link';
}
