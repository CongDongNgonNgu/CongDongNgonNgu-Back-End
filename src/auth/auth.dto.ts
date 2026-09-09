import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normalizeEmail } from '../identity/identity.types';

const passwordPattern = /\S/;

export class RegisterDto {
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  displayName!: string;

  @IsString()
  @Length(12, 128)
  @Matches(passwordPattern)
  password!: string;
}

export class LoginDto {
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 128)
  password!: string;
}

export class EmailDto {
  @Transform(({ value }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class TokenDto {
  @IsString()
  @Length(20, 256)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @IsString()
  @Length(12, 128)
  @Matches(passwordPattern)
  password!: string;
}

export class OAuthModeDto {
  @IsIn(['login', 'register', 'link'])
  mode!: 'login' | 'register' | 'link';
}
