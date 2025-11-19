import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { StorageService } from './storage.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  // @Post('audio')
  // uploadAudio(
  //   @Body('text') text: string,
  //   @Body('language') language: string,
  //   @Body('studentId') studentId: string,
  //   @Body('assessmentId') assessmentId: string,
  // ) {
  //   return this.storageService.uploadAudioToS3(text, language, studentId, assessmentId);
  // }

  @Get('audio/:studentId/:assessmentId')
  getAudio(
    @Param('studentId') studentId: string,
    @Param('assessmentId') assessmentId: string,
  ) {
    return this.storageService.getAudioUrl(studentId, assessmentId);
  }

}
