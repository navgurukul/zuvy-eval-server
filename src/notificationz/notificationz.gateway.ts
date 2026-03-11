import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';

const USER_ROOM_PREFIX = 'user:';

@WebSocketGateway({ cors: true })
export class NotificationzGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationzGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token =
      client.handshake.auth?.token ??
      client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      this.logger.debug(`Client ${client.id} connected without auth; no user room.`);
      return;
    }
    try {
      const payload = await this.jwtService.verifyAsync(token);
      const userId = payload?.sub != null ? String(payload.sub) : null;
      if (userId) {
        const room = `${USER_ROOM_PREFIX}${userId}`;
        await client.join(room);
        this.logger.debug(`Client ${client.id} joined room ${room}`);
      }
    } catch {
      this.logger.debug(`Client ${client.id} invalid token; no user room.`);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client ${client.id} disconnected`);
  }
}