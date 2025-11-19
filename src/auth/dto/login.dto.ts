import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'User email',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'Google ID token obtained from Google authentication',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjFlOWdkazcifQ...',
  })
  @IsString()
  @IsNotEmpty()
  googleIdToken: string;
} 