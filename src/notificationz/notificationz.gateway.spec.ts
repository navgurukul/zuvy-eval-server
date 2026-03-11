import { Test, TestingModule } from '@nestjs/testing';
import { NotificationzGateway } from './notificationz.gateway';

describe('NotificationzGateway', () => {
  let gateway: NotificationzGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationzGateway],
    }).compile();

    gateway = module.get<NotificationzGateway>(NotificationzGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
