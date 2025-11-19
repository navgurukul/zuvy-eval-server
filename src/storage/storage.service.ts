import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3: S3Client;

  constructor(
    private readonly config: ConfigService,
  ) {
    this.s3 = new S3Client({
      region: process.env.S3_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_KEY_ACCESS!,
      },
    });
  }

  async uploadAudioToS3(
    audioBuffer,
    studentId: string,
    assessmentId: string,
  ) {
    const bucket = this.config.get<string>('S3_BUCKET_NAME');
    const key = `tts/${studentId}/${assessmentId}.mp3`;

    this.logger.log(
      `Starting upload: student=${studentId}, assessment=${assessmentId}`,
    );

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: audioBuffer,
          ContentType: 'audio/mpeg',
          ACL: 'public-read',
        }),
      );

      const audioUrl = `https://${bucket}.s3.${this.config.get(
        'S3_REGION',
      )}.amazonaws.com/${key}`;

      this.logger.log(`Upload successful → ${audioUrl}`);

      return { audioUrl };
    } catch (err) {
      this.logger.error(
        `Upload failed for student=${studentId}, assessment=${assessmentId}`,
        err.stack,
      );

      throw new InternalServerErrorException('Audio upload failed');
    }
  }

  async getAudioUrl(studentId: string, assessmentId: string) {
    const bucket = this.config.get<string>('S3_BUCKET_NAME');
    const key = `tts/${studentId}/${assessmentId}.mp3`;

    this.logger.log(
      `Checking if audio exists for student=${studentId}, assessment=${assessmentId}`,
    );

    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    } catch {
      this.logger.warn(
        `Audio NOT FOUND for student=${studentId}, assessment=${assessmentId}`,
      );
      throw new NotFoundException('Audio file not found');
    }

    const audioUrl = `https://${bucket}.s3.${this.config.get(
      'S3_REGION',
    )}.amazonaws.com/${key}`;

    this.logger.log(`Audio found → ${audioUrl}`);

    return { audioUrl };
  }
}
