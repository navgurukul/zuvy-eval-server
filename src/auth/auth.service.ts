import { Injectable, UnauthorizedException, Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { LoginDto } from './dto/login.dto';
import { users, blacklistedTokens, zuvyUserRolesAssigned, zuvyUserRoles, sansaarUserRoles } from 'src/db/schema/parentSchema';
import { eq, inArray } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
let { GOOGLE_CLIENT_ID, GOOGLE_SECRET, GOOGLE_REDIRECT, JWT_SECRET_KEY } =
  process.env;
// import { Role } from '../rbac/utility';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleAuthClient: OAuth2Client;

  constructor(
    private jwtService: JwtService,
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase
  ) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    this.googleAuthClient = new OAuth2Client(clientId);
  }
}
