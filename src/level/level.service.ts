import { Inject, Injectable } from '@nestjs/common';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { levels } from 'src/db/schema/level';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
@Injectable()
export class LevelService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase
  ) {}
  create(createLevelDto: CreateLevelDto) {
    return 'This action adds a new level';
  }

  async seed() {
    const seedData = [
      {
        grade: 'A+',
        scoreRange: '>= 90',
        scoreMin: 90,
        hardship: '+20%',
        meaning: 'Expert / Ready for next level',
      },
      {
        grade: 'A',
        scoreRange: '80-89',
        scoreMin: 80,
        scoreMax: 89,
        hardship: '+10%',
        meaning: 'Strong conceptual understanding',
      },
      {
        grade: 'B',
        scoreRange: '70-79',
        scoreMin: 70,
        scoreMax: 79,
        hardship: '+5%',
        meaning: 'Competent but needs revision',
      },
      {
        grade: 'C',
        scoreRange: '60-69',
        scoreMin: 60,
        scoreMax: 69,
        hardship: '0%',
        meaning: 'Basic grasp, needs reinforcement',
      },
      {
        grade: 'D',
        scoreRange: '< 60',
        scoreMax: 59,
        hardship: '-5%',
        meaning: 'Weak areas identified',
      },
      {
        grade: 'E',
        scoreRange: '< 40',
        scoreMax: 39,
        hardship: '-10%',
        meaning: 'Requires intervention',
      },
    ];

    try {
      // If already seeded, skip inserting again
      const existing = await this.db.select().from(levels);
      if (existing.length > 0) {
        return { message: 'Levels already seeded. Skipping seed.' };
      }

      // Insert and return inserted rows
      const inserted = await this.db.insert(levels).values(seedData).returning();
      return { message: 'Levels seeded successfully', data: inserted };
    } catch (err) {
      console.error('Error seeding levels:', err);
      throw new Error('Failed to seed levels');
    }
  }

  findAll() {
    return `This action returns all level`;
  }

  findOne(id: number) {
    return `This action returns a #${id} level`;
  }

  update(id: number, updateLevelDto: UpdateLevelDto) {
    return `This action updates a #${id} level`;
  }

  remove(id: number) {
    return `This action removes a #${id} level`;
  }
}
