import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DRIZZLE_DB } from 'src/db/constant';
import { QuestionsService } from './questions.service';
import { GenerateQuestionsDto } from './dto/generate-questions.dto';

function mockSelect(result: unknown[]) {
  const chain: any = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

describe('QuestionsService', () => {
  let service: QuestionsService;
  let db: {
    select: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
    delete: jest.Mock;
  };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    db = {
      select: jest.fn(),
      insert: jest.fn(),
      transaction: jest.fn(),
      delete: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionsService,
        { provide: getQueueToken('llm-generation'), useValue: queue },
        { provide: DRIZZLE_DB, useValue: db },
      ],
    }).compile();

    service = module.get(QuestionsService);
  });

  it('splits generation into append-only batches without replacing existing counts', () => {
    const payload = {
      numberOfQuestions: 20,
      topicConfigurations: [
        {
          topicName: 'REST APIs',
          topicDescription: 'HTTP APIs',
          totalQuestions: 20,
          questionCounts: { easy: 10, medium: 6, hard: 4 },
        },
      ],
    } as GenerateQuestionsDto;

    const jobs = service.expandPayloadToJobs(payload, 1);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.count === 10)).toBe(true);
    expect(jobs.every((job) => job.orgId === 1)).toBe(true);
  });

  it('reuses the org topic spelling so a later generate stays in the same pool', async () => {
    db.select.mockReturnValueOnce(
      mockSelect([{ name: 'HTML & CSS', description: 'Frontend' }]),
    );

    const resolved = await service.resolveCanonicalTopic(1, 'html & css');
    expect(resolved).toEqual({
      topicName: 'HTML & CSS',
      topicDescription: 'Frontend',
    });
  });

  it('falls back to the oldest existing question spelling for that org', async () => {
    db.select
      .mockReturnValueOnce(mockSelect([]))
      .mockReturnValueOnce(
        mockSelect([{ topicName: 'REST APIs', topicDescription: 'HTTP' }]),
      );

    const resolved = await service.resolveCanonicalTopic(1, 'rest apis');
    expect(resolved.topicName).toBe('REST APIs');
  });

  it('loads existing question texts by org and topic without deleting anything', async () => {
    db.select.mockReturnValueOnce(
      mockSelect([{ question: 'What is REST?' }, { question: 'What is HTTP?' }]),
    );

    const texts = await service.getQuestionTextsByTopic('rest apis', 1, 200);
    expect(texts).toEqual(['What is REST?', 'What is HTTP?']);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('inserts new questions and never deletes existing rows', async () => {
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 21, question: 'New Q' }]),
        }),
      }),
      delete: jest.fn(),
    };
    db.transaction.mockImplementation(async (cb) => cb(tx));

    const inserted = await service.createManyWithOutbox(
      [
        {
          orgId: 1,
          topicName: 'REST APIs',
          topicDescription: 'HTTP APIs',
          question: 'New Q',
          options: { '1': 'A', '2': 'B', '3': 'C', '4': 'D' },
          correctOption: 1,
        },
      ],
      'user-1',
    );

    expect(inserted).toHaveLength(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('stamps canonical topic names onto queued generate jobs', async () => {
    db.select.mockReturnValue(
      mockSelect([{ name: 'HTML & CSS', description: 'Frontend' }]),
    );

    await service.enqueueGeneration(
      {
        numberOfQuestions: 10,
        topicConfigurations: [
          {
            topicName: 'html & css',
            topicDescription: 'Frontend',
            totalQuestions: 10,
            questionCounts: { easy: 4, medium: 4, hard: 2 },
          },
        ],
      } as GenerateQuestionsDto,
      1,
      'user-1',
    );

    expect(queue.add).toHaveBeenCalledTimes(1);
    const jobPayload = queue.add.mock.calls[0][1];
    expect(jobPayload.topic).toBe('HTML & CSS');
    expect(jobPayload.topicName).toBe('HTML & CSS');
    expect(jobPayload.orgId).toBe(1);
  });
});
